import { Router } from 'express';
import { getFirestore, admin } from '../../config/firebase.js';
import { generateAccessToken } from '../../config/twilio.js';
import { logger } from '../../utils/logger.js';
import {
  getUserStatus, setUserStatus, getConnectedUser,
  getActiveCall, getAllActiveCalls,
  setCallTimer, getCallTimer, deleteCallTimer, getAllCallTimers,
  completeCall
} from '../../socket/state/connectionManager.js';
import {
  COIN_RATES, MIN_BALANCE, MIN_CALL_DURATION_SECONDS,
  FEMALE_EARNING_RATES, ENDED_CALL_STATUSES
} from '../../shared/constants.js';
import { updateCallLogs } from '../../utils/callLogUtil.js';
import { checkIsTrialCall, incrementMaleCallCount, TRIAL_CALL_MAX_DURATION_SECONDS } from '../../utils/trialCallUtil.js';

const router = Router();

/**
 * @openapi
 * /api/calls/start:
 *   post:
 *     tags:
 *       - Calls
 *     summary: Start a call with server-side billing
 *     description: Initiates a call between two users. Validates recipient availability and caller balance, creates a Firestore call record, and starts a server-side billing timer.
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - callId
 *               - callerId
 *               - recipientId
 *               - callType
 *             properties:
 *               callId:
 *                 type: string
 *               callerId:
 *                 type: string
 *               recipientId:
 *                 type: string
 *               callType:
 *                 type: string
 *                 enum: [audio, video]
 *               roomName:
 *                 type: string
 *     responses:
 *       200:
 *         description: Call tracking started
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 callId:
 *                   type: string
 *                 serverStartTime:
 *                   type: string
 *                   format: date-time
 *                 callerBalance:
 *                   type: number
 *                 coinRate:
 *                   type: number
 *                 message:
 *                   type: string
 *       400:
 *         description: Missing fields, recipient unavailable, or insufficient balance
 *       404:
 *         description: Caller not found
 *       500:
 *         description: Server error
 */
router.post('/start', async (req, res) => {
  try {
    const { callId, callerId, recipientId, callType, roomName } = req.body;

    if (!callId || !callerId || !recipientId || !callType) {
      return res.status(400).json({ error: 'Missing required fields: callId, callerId, recipientId, callType' });
    }

    logger.info(`Starting call: ${callId} (${callType}) - Caller: ${callerId}, Recipient: ${recipientId}`);

    // Check recipient availability
    const recipientStatus = getUserStatus(recipientId);
    const recipientConnection = getConnectedUser(recipientId);
    let actualStatus = 'unavailable';
    let hasConnection = false;

    const io = req.app.get('io');
    if (recipientConnection && recipientConnection.isOnline) {
      const socket = io.sockets.sockets.get(recipientConnection.socketId);
      if (socket && socket.connected) {
        hasConnection = true;
        actualStatus = recipientStatus ? recipientStatus.status : 'available';
      }
    }
    if (!hasConnection) actualStatus = 'unavailable';

    if (actualStatus !== 'available') {
      return res.status(400).json({
        error: 'Recipient is not available',
        recipientStatus: actualStatus,
        message: actualStatus === 'busy' ? 'User is currently on another call'
          : actualStatus === 'ringing' ? 'User is receiving another call'
          : 'User is currently unavailable for calls'
      });
    }

    // Validate balance
    const db = getFirestore();
    const userDoc = await db.collection('users').doc(callerId).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'Caller not found' });

    const userData = userDoc.data();
    const callerName = userData.name || userData.displayName || 'Unknown';
    const callerBalance = userData.coins ?? 0;
    const requiredBalance = callType === 'video' ? MIN_BALANCE.video : MIN_BALANCE.audio;

    // Check if this should be a trial call (new male, first audio/video call)
    const trialCheck = await checkIsTrialCall(callerId, callType);
    const isTrial = trialCheck.isTrial;
    if (isTrial) {
      logger.info(`TRIAL CALL: ${callId} - Caller ${callerId} (${callType}) - free 60s trial (${trialCheck.reason})`);
    }

    // Skip balance check for trial calls
    if (!isTrial && callerBalance < requiredBalance) {
      return res.status(400).json({
        error: 'Insufficient balance',
        currentBalance: callerBalance,
        requiredBalance,
        shortfall: Math.max(0, requiredBalance - callerBalance)
      });
    }

    const coinRate = callType === 'video' ? COIN_RATES.video : COIN_RATES.audio;
    const startTime = Date.now();

    // Save to Firestore
    const callData = {
      callId, callerId, recipientId, callType,
      roomName: roomName || `${callType}_${callerId}_${recipientId}`,
      status: 'initiated',
      coinRatePerSecond: coinRate,
      startedAt: new Date().toISOString(),
      durationSeconds: 0, coinsDeducted: 0,
      isTrialCall: isTrial,
      displayLabel: isTrial ? 'Trial Call' : null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    await db.collection('calls').doc(callId).set(callData, { merge: true });

    // Start timer with mid-call balance check (Fix 6) + trial call 60s hard cap
    const ioApp = req.app.get('io');
    const interval = setInterval(async () => {
      const timer = getCallTimer(callId);
      if (!timer) return;
      timer.durationSeconds++;

      // Trial call: hard 60-second auto-end
      if (timer.isTrialCall && timer.durationSeconds >= TRIAL_CALL_MAX_DURATION_SECONDS) {
        logger.info(`TRIAL CALL AUTO-END: ${callId} reached ${TRIAL_CALL_MAX_DURATION_SECONDS}s — ending call`);
        clearInterval(timer.interval);
        const callerConn = getConnectedUser(timer.callerId);
        const recipientConn = getConnectedUser(timer.recipientId);
        const endPayload = {
          callId,
          endedBy: 'server',
          reason: 'trial_ended',
          duration: timer.durationSeconds,
          isTrialCall: true,
          displayLabel: 'Trial Call',
        };
        if (ioApp && callerConn) ioApp.to(callerConn.socketId).emit('call_ended', endPayload);
        if (ioApp && recipientConn) ioApp.to(recipientConn.socketId).emit('call_ended', endPayload);
        await db.collection('calls').doc(callId).update({
          status: 'completed',
          durationSeconds: timer.durationSeconds,
          coinsDeducted: 0,
          isTrialCall: true,
          displayLabel: 'Trial Call',
          endedAt: admin.firestore.FieldValue.serverTimestamp(),
          endReason: 'trial_60s_reached',
        }).catch(() => {});
        setUserStatus(timer.callerId, { status: 'available', currentCallId: null, lastStatusChange: new Date() });
        setUserStatus(timer.recipientId, { status: 'available', currentCallId: null, lastStatusChange: new Date() });
        // Increment male call count so trial is used up
        await incrementMaleCallCount(timer.callerId, timer.callType);
        // Update call logs (with isTrial flag)
        await updateCallLogs({
          callId,
          callerId: timer.callerId,
          recipientId: timer.recipientId,
          callType: timer.callType,
          durationSeconds: timer.durationSeconds,
          coinsDeducted: 0,
          status: 'completed',
          endReason: 'trial_60s_reached',
          source: 'trial_auto_end',
          isTrialCall: true,
          displayLabel: 'Trial Call',
        });
        deleteCallTimer(callId);
        return;
      }

      // Mid-call balance check every 30s (skip for trial calls — no coins involved)
      if (!timer.isTrialCall && timer.durationSeconds % 30 === 0) {
        try {
          const userDoc = await db.collection('users').doc(timer.callerId).get();
          const balance = userDoc.exists ? (userDoc.data().coins ?? 0) : 0;
          const projectedNeed = Math.ceil(60 * timer.coinRate);
          if (balance < projectedNeed) {
            logger.warn(`AUTO-END: Caller ${timer.callerId} balance (${balance}) below 1-min buffer (${projectedNeed}) for call ${callId}`);
            clearInterval(timer.interval);
            const callerConn = getConnectedUser(timer.callerId);
            const recipientConn = getConnectedUser(timer.recipientId);
            const endPayload = { callId, endedBy: 'server', reason: 'insufficient_balance', duration: timer.durationSeconds };
            if (ioApp && callerConn) ioApp.to(callerConn.socketId).emit('call_ended', endPayload);
            if (ioApp && recipientConn) ioApp.to(recipientConn.socketId).emit('call_ended', endPayload);
            await db.collection('calls').doc(callId).update({
              status: 'ended',
              durationSeconds: timer.durationSeconds,
              endedAt: admin.firestore.FieldValue.serverTimestamp(),
              endReason: 'insufficient_balance'
            }).catch(() => {});
            setUserStatus(timer.callerId, { status: 'available', currentCallId: null, lastStatusChange: new Date() });
            setUserStatus(timer.recipientId, { status: 'available', currentCallId: null, lastStatusChange: new Date() });
            deleteCallTimer(callId);
          }
        } catch (e) {
          logger.warn(`Mid-call balance check failed for ${callId}: ${e.message}`);
        }
      }
    }, 1000);

    setCallTimer(callId, {
      interval, durationSeconds: 0, coinRate, callerId, recipientId,
      callType, callerName, startTime, lastHeartbeat: Date.now(),
      isTrialCall: isTrial,
    });

    res.json({
      success: true, callId,
      serverStartTime: new Date().toISOString(),
      callerBalance, coinRate,
      isTrialCall: isTrial,
      trialMaxDurationSeconds: isTrial ? TRIAL_CALL_MAX_DURATION_SECONDS : null,
      displayLabel: isTrial ? 'Trial Call' : null,
      message: isTrial ? 'Trial call started (60s max)' : 'Call tracking started on server'
    });
  } catch (error) {
    logger.error('Error starting call:', error);
    res.status(500).json({
      error: 'Failed to start call',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

/**
 * @openapi
 * /api/calls/complete:
 *   post:
 *     tags:
 *       - Calls
 *     summary: Complete a call and deduct coins
 *     description: Ends an active call, deducts coins from the caller based on server-tracked duration, records female earnings, creates spend transactions, and notifies participants via WebSocket. Supports idempotency and fraud detection.
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - callId
 *             properties:
 *               callId:
 *                 type: string
 *               call_id:
 *                 type: string
 *                 description: Alternative field name for callId
 *               callerId:
 *                 type: string
 *               caller_id:
 *                 type: string
 *               recipientId:
 *                 type: string
 *               recipient_id:
 *                 type: string
 *               endReason:
 *                 type: string
 *               client_duration_seconds:
 *                 type: number
 *                 description: Client-reported duration for fraud detection
 *               client_coins_deducted:
 *                 type: number
 *                 description: Client-reported deduction for fallback
 *     responses:
 *       200:
 *         description: Call completed and billed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 callId:
 *                   type: string
 *                 durationSeconds:
 *                   type: integer
 *                 coinsDeducted:
 *                   type: number
 *                 newBalance:
 *                   type: number
 *                   nullable: true
 *                 coinRate:
 *                   type: number
 *                 callType:
 *                   type: string
 *                 source:
 *                   type: string
 *                   enum: [server, client_fallback, already_completed]
 *                 fraudDetection:
 *                   type: object
 *                   nullable: true
 *                 message:
 *                   type: string
 *       400:
 *         description: Missing callId
 *       500:
 *         description: Server error
 */
router.post('/complete', async (req, res) => {
  try {
    const {
      callId, call_id, callerId, caller_id, recipientId, recipient_id,
      endReason, client_duration_seconds, client_coins_deducted
    } = req.body;

    const finalCallId = callId || call_id;
    const finalCallerId = callerId || caller_id;
    const finalRecipientId = recipientId || recipient_id;

    if (!finalCallId) return res.status(400).json({ error: 'Missing required field: callId' });

    logger.info(`Completing call: ${finalCallId}`);

    // Idempotency: only skip if SERVER already billed this call
    // (billingSource === 'server' means coins were already deducted)
    const db = getFirestore();
    if (db) {
      try {
        const existingCall = await db.collection('calls').doc(finalCallId).get();
        if (existingCall.exists) {
          const existing = existingCall.data();
          if (existing.status === 'completed' && existing.billingSource === 'server') {
            logger.info(`Call ${finalCallId} already billed by server — returning cached result`);
            return res.json({
              success: true, callId: finalCallId,
              durationSeconds: existing.durationSeconds || 0,
              coinsDeducted: existing.coinsDeducted || 0,
              newBalance: null, source: 'already_completed',
              duplicate: true,
              message: 'Call was already completed and billed'
            });
          }
        }
      } catch (err) {
        logger.warn(`Idempotency check failed for ${finalCallId}: ${err.message}`);
      }
    }

    const serverTimer = getCallTimer(finalCallId);

    // Graceful fallback if no server timer
    if (!serverTimer) {
      logger.warn(`No server timer found for call ${finalCallId}`);

      if (client_duration_seconds !== undefined) {
        if (db) {
          await db.collection('calls').doc(finalCallId).update({
            status: 'completed', durationSeconds: client_duration_seconds || 0,
            coinsDeducted: client_coins_deducted || 0,
            endedAt: new Date().toISOString(),
            endReason: endReason || 'User ended call',
            billingSource: 'client_fallback',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }).catch(() => {});
        }

        return res.json({
          success: true, callId: finalCallId,
          durationSeconds: client_duration_seconds || 0,
          coinsDeducted: client_coins_deducted || 0,
          newBalance: null, source: 'client_fallback',
          warning: 'Server timer not found, used client-reported values'
        });
      }

      return res.json({
        success: true, callId: finalCallId,
        durationSeconds: 0, coinsDeducted: 0, newBalance: null,
        source: 'already_completed',
        warning: 'Call not found - may have already been completed'
      });
    }

    // Stop timer
    clearInterval(serverTimer.interval);
    const serverDuration = serverTimer.durationSeconds;
    const isTrialCall = serverTimer.isTrialCall === true;
    // For trial calls: zero coins regardless of duration
    const coinsDeducted = isTrialCall ? 0 : Math.ceil(serverDuration * serverTimer.coinRate);

    // Fraud detection
    let fraudDetection = null;
    if (client_duration_seconds !== undefined) {
      const durationDiff = Math.abs(serverDuration - client_duration_seconds);
      const isSuspicious = durationDiff > 5;
      fraudDetection = {
        clientDuration: client_duration_seconds,
        serverDuration, differenceSeconds: durationDiff, isSuspicious
      };
      if (isSuspicious) {
        logger.warn(`FRAUD ALERT: Call ${finalCallId} - Server: ${serverDuration}s, Client: ${client_duration_seconds}s`);
      }
    }

    // db already declared earlier (idempotency check)
    const effectiveCallerId = finalCallerId || serverTimer.callerId;
    const effectiveRecipientId = finalRecipientId || serverTimer.recipientId;

    // Deduct coins (with negative balance guard) — SKIP for trial calls
    let actualDeduction = coinsDeducted;
    if (!isTrialCall && effectiveCallerId && coinsDeducted > 0) {
      const userRef = db.collection('users').doc(effectiveCallerId);
      const userDoc = await userRef.get();
      const data = userDoc.data() || {};
      const currentBalance = data.coins ?? 0;

      // Guard: don't deduct more than available
      actualDeduction = Math.min(coinsDeducted, Math.max(0, currentBalance));

      if (actualDeduction > 0) {
        await userRef.update({
          coins: admin.firestore.FieldValue.increment(-actualDeduction),
          lastSpendAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }

      if (actualDeduction < coinsDeducted) {
        logger.warn(`Balance guard: User ${effectiveCallerId} had ${currentBalance} coins, tried to deduct ${coinsDeducted}, deducted ${actualDeduction}`);
      }
    } else if (isTrialCall) {
      logger.info(`TRIAL CALL completion: ${finalCallId} - skipping coin deduction (duration: ${serverDuration}s)`);
    }

    const newBalance = await (async () => {
      const doc = await db.collection('users').doc(effectiveCallerId || serverTimer.callerId).get();
      const d = doc.data() || {};
      return d.coins ?? 0;
    })();

    // Update call in Firestore
    await db.collection('calls').doc(finalCallId).update({
      status: 'completed', durationSeconds: serverDuration, coinsDeducted: actualDeduction,
      endedAt: new Date().toISOString(),
      endReason: endReason || 'User ended call',
      billingSource: 'server', fraudDetection,
      isTrialCall: isTrialCall,
      displayLabel: isTrialCall ? 'Trial Call' : null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }).catch(() => {});

    // Record female earnings — SKIP for trial calls (female gets ₹0)
    if (!isTrialCall && effectiveRecipientId && serverDuration > 0) {
      try {
        const earningRate = serverTimer.callType === 'video' ? FEMALE_EARNING_RATES.video : FEMALE_EARNING_RATES.audio;
        const earningAmount = parseFloat((serverDuration * earningRate).toFixed(2));
        const dateKey = new Date().toISOString().split('T')[0];

        const femaleEarningsRef = db.collection('female_earnings').doc(effectiveRecipientId);
        await femaleEarningsRef.set({
          totalEarnings: admin.firestore.FieldValue.increment(earningAmount),
          availableBalance: admin.firestore.FieldValue.increment(earningAmount),
          totalCalls: admin.firestore.FieldValue.increment(1),
          totalDurationSeconds: admin.firestore.FieldValue.increment(serverDuration),
          [`total${serverTimer.callType === 'video' ? 'Video' : 'Audio'}Calls`]: admin.firestore.FieldValue.increment(1),
          [`total${serverTimer.callType === 'video' ? 'Video' : 'Audio'}Earnings`]: admin.firestore.FieldValue.increment(earningAmount),
          lastCallAt: admin.firestore.FieldValue.serverTimestamp(),
          lastUpdated: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        await femaleEarningsRef.collection('daily').doc(dateKey).set({
          date: dateKey,
          earnings: admin.firestore.FieldValue.increment(earningAmount),
          calls: admin.firestore.FieldValue.increment(1),
          durationSeconds: admin.firestore.FieldValue.increment(serverDuration),
          lastUpdated: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        // Record individual transaction for female earnings history
        const femaleTransactionRef = femaleEarningsRef.collection('transactions').doc(finalCallId);
        await femaleTransactionRef.set({
          type: 'call_earning',
          callId: finalCallId,
          callerId: serverTimer.callerId,
          callerName: serverTimer.callerName || 'Unknown',
          callType: serverTimer.callType,
          isVideoCall: serverTimer.callType === 'video',
          durationSeconds: serverDuration,
          amount: earningAmount,
          currency: 'INR',
          ratePerSecond: earningRate,
          completedAt: new Date().toISOString(),
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          status: 'completed'
        });
      } catch (err) {
        logger.error(`Failed to record female earnings: ${err.message}`);
      }
    } else if (isTrialCall && effectiveRecipientId && serverDuration > 0) {
      // Trial call: record a trial transaction (₹0) so female sees it in history as "Trial Call"
      try {
        const femaleEarningsRef = db.collection('female_earnings').doc(effectiveRecipientId);
        await femaleEarningsRef.collection('transactions').doc(finalCallId).set({
          type: 'trial_call',
          callId: finalCallId,
          callerId: serverTimer.callerId,
          callerName: serverTimer.callerName || 'Unknown',
          callType: serverTimer.callType,
          isVideoCall: serverTimer.callType === 'video',
          durationSeconds: serverDuration,
          amount: 0,
          currency: 'INR',
          isTrialCall: true,
          displayLabel: 'Trial Call',
          completedAt: new Date().toISOString(),
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          status: 'completed'
        });
        logger.info(`Trial call transaction recorded for female ${effectiveRecipientId} (₹0 earnings)`);
      } catch (err) {
        logger.error(`Failed to record trial call transaction: ${err.message}`);
      }
    }

    // Record spend transaction
    if (effectiveCallerId && actualDeduction > 0) {
      try {
        const spendTxnId = `txn_call_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;
        const spendTxnData = {
          id: spendTxnId, userId: effectiveCallerId, type: 'spend', status: 'success',
          coinAmount: actualDeduction,
          description: `${serverTimer.callType} call - ${serverDuration}s`,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          metadata: {
            callId: finalCallId, callType: serverTimer.callType,
            durationSeconds: serverDuration, coinRate: serverTimer.coinRate,
            recipientId: effectiveRecipientId
          }
        };

        const batch = db.batch();
        batch.set(db.collection('users').doc(effectiveCallerId).collection('transactions').doc(spendTxnId), spendTxnData);
        batch.update(db.collection('users').doc(effectiveCallerId), {
          totalCoinsSpent: admin.firestore.FieldValue.increment(actualDeduction)
        });
        await batch.commit();
      } catch (err) {
        logger.error(`Failed to record spend transaction: ${err.message}`);
      }
    }

    // Update admin analytics
    try {
      await db.collection('admin_analytics').doc('call_stats').set({
        totalCalls: admin.firestore.FieldValue.increment(1),
        totalDurationSeconds: admin.firestore.FieldValue.increment(serverDuration),
        totalCoinsDeducted: admin.firestore.FieldValue.increment(actualDeduction),
        lastUpdated: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    } catch (err) {
      logger.warn('Call analytics update failed:', err.message);
    }

    // Update call logs for both users (so frontend call history shows correctly)
    await updateCallLogs({
      callId: finalCallId,
      callerId: serverTimer.callerId,
      recipientId: effectiveRecipientId,
      callType: serverTimer.callType,
      durationSeconds: serverDuration,
      coinsDeducted: actualDeduction,
      status: 'completed',
      endReason: endReason || 'completed',
      source: isTrialCall ? 'trial_completion' : 'normal_completion',
      isTrialCall,
      displayLabel: isTrialCall ? 'Trial Call' : null,
    });

    // Increment male call count (for both trial AND normal calls so trial gets used up)
    await incrementMaleCallCount(serverTimer.callerId, serverTimer.callType);

    deleteCallTimer(finalCallId);

    // Reset user statuses
    setUserStatus(serverTimer.callerId, { status: 'available', currentCallId: null, lastStatusChange: new Date() });
    setUserStatus(serverTimer.recipientId, { status: 'available', currentCallId: null, lastStatusChange: new Date() });

    // Notify participants that call ended
    const io = req.app.get('io');
    if (io) {
      // Calculate female earning for the event payload (₹0 for trial calls)
      const earningRate = serverTimer.callType === 'video' ? FEMALE_EARNING_RATES.video : FEMALE_EARNING_RATES.audio;
      const femaleEarningAmount = isTrialCall ? 0 : parseFloat((serverDuration * earningRate).toFixed(2));

      [serverTimer.callerId, serverTimer.recipientId].forEach(uid => {
        const conn = getConnectedUser(uid);
        if (conn && conn.isOnline) {
          const eventData = {
            callId: finalCallId,
            durationSeconds: serverDuration,
            coinsDeducted: actualDeduction,
            endReason: endReason || 'User ended call',
            callType: serverTimer.callType,
            isTrialCall,
            displayLabel: isTrialCall ? 'Trial Call' : null,
            timestamp: new Date().toISOString()
          };

          // Add earning data only for the female (recipient)
          if (uid === effectiveRecipientId) {
            eventData.earningAmount = femaleEarningAmount;
            eventData.isRecipient = true;
          }

          io.to(conn.socketId).emit('call_ended', eventData);
        }
      });
    }

    res.json({
      success: true, callId: finalCallId,
      durationSeconds: serverDuration, coinsDeducted: actualDeduction,
      newBalance, coinRate: serverTimer.coinRate,
      callType: serverTimer.callType, source: 'server',
      isTrialCall,
      displayLabel: isTrialCall ? 'Trial Call' : null,
      fraudDetection,
      message: isTrialCall ? 'Trial call completed (no charge)' : 'Call completed and billed successfully'
    });
  } catch (error) {
    logger.error('Error completing call:', error);
    res.status(500).json({
      error: 'Failed to complete call',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

/**
 * @openapi
 * /api/calls/heartbeat:
 *   post:
 *     tags:
 *       - Calls
 *     summary: Send a call heartbeat
 *     description: Updates the last heartbeat timestamp for an active call and returns current duration and estimated cost.
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - callId
 *             properties:
 *               callId:
 *                 type: string
 *               userId:
 *                 type: string
 *               callerId:
 *                 type: string
 *                 description: Alternative field name for userId
 *     responses:
 *       200:
 *         description: Heartbeat acknowledged
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 callId:
 *                   type: string
 *                 currentDurationSeconds:
 *                   type: integer
 *                 estimatedCost:
 *                   type: number
 *                 coinRate:
 *                   type: number
 *       400:
 *         description: Missing required fields
 *       404:
 *         description: Call not found
 *       500:
 *         description: Server error
 */
router.post('/heartbeat', async (req, res) => {
  try {
    const { callId, userId, callerId } = req.body;
    const effectiveUserId = userId || callerId;

    if (!callId || !effectiveUserId) {
      return res.status(400).json({ error: 'Missing required fields: callId, userId (or callerId)' });
    }

    const serverTimer = getCallTimer(callId);
    if (!serverTimer) return res.status(404).json({ error: 'Call not found' });

    serverTimer.lastHeartbeat = Date.now();

    res.json({
      success: true, callId,
      currentDurationSeconds: serverTimer.durationSeconds,
      estimatedCost: Math.ceil(serverTimer.durationSeconds * serverTimer.coinRate),
      coinRate: serverTimer.coinRate
    });
  } catch (error) {
    logger.error('Error in heartbeat:', error);
    res.status(500).json({ error: 'Heartbeat failed' });
  }
});

/**
 * @openapi
 * /api/calls/{callId}:
 *   get:
 *     tags:
 *       - Calls
 *     summary: Get active call details
 *     description: Returns the current state of an active call including server-tracked duration and coin rate.
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: callId
 *         required: true
 *         schema:
 *           type: string
 *         description: The call ID
 *     responses:
 *       200:
 *         description: Call details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 callId:
 *                   type: string
 *                 callerId:
 *                   type: string
 *                 recipientId:
 *                   type: string
 *                 callType:
 *                   type: string
 *                 status:
 *                   type: string
 *                 server_duration_seconds:
 *                   type: integer
 *                 server_coin_rate:
 *                   type: number
 *       404:
 *         description: Call not found
 */
router.get('/:callId', (req, res) => {
  const { callId } = req.params;
  const call = getActiveCall(callId);

  if (!call) return res.status(404).json({ error: 'Call not found' });

  const serverTimer = getCallTimer(callId);
  const result = { ...call };
  if (serverTimer) {
    result.server_duration_seconds = serverTimer.durationSeconds;
    result.server_coin_rate = serverTimer.coinRate;
  }

  res.json(result);
});

export default router;
