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

const router = Router();

// ============================================================
// POST /api/calls/start - Start call with server-side billing
// ============================================================
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
    const callerBalance = userData.coinBalance || userData.coins || 0;
    const requiredBalance = callType === 'video' ? MIN_BALANCE.video : MIN_BALANCE.audio;

    if (callerBalance < requiredBalance) {
      return res.status(400).json({
        error: 'Insufficient balance',
        currentBalance: callerBalance,
        requiredBalance,
        shortfall: requiredBalance - callerBalance
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
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    await db.collection('calls').doc(callId).set(callData, { merge: true });

    // Start timer
    const interval = setInterval(() => {
      const timer = getCallTimer(callId);
      if (timer) timer.durationSeconds++;
    }, 1000);

    setCallTimer(callId, {
      interval, durationSeconds: 0, coinRate, callerId, recipientId,
      callType, startTime, lastHeartbeat: Date.now()
    });

    res.json({
      success: true, callId,
      serverStartTime: new Date().toISOString(),
      callerBalance, coinRate,
      message: 'Call tracking started on server'
    });
  } catch (error) {
    logger.error('Error starting call:', error);
    res.status(500).json({
      error: 'Failed to start call',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// ============================================================
// POST /api/calls/complete - Complete call + deduct coins
// ============================================================
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

    // Idempotency: check if call already completed in Firestore
    const db = getFirestore();
    if (db) {
      try {
        const existingCall = await db.collection('calls').doc(finalCallId).get();
        if (existingCall.exists && existingCall.data().status === 'completed') {
          const existing = existingCall.data();
          logger.info(`Call ${finalCallId} already completed — returning cached result`);
          return res.json({
            success: true, callId: finalCallId,
            durationSeconds: existing.durationSeconds || 0,
            coinsDeducted: existing.coinsDeducted || 0,
            newBalance: null, source: 'already_completed',
            duplicate: true,
            message: 'Call was already completed'
          });
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
        const db = getFirestore();
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
    const coinsDeducted = Math.ceil(serverDuration * serverTimer.coinRate);

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

    // Deduct coins (with negative balance guard)
    if (effectiveCallerId && coinsDeducted > 0) {
      const userRef = db.collection('users').doc(effectiveCallerId);
      const userDoc = await userRef.get();
      const data = userDoc.data() || {};
      const currentBalance = data.coins ?? data.coinBalance ?? 0;

      // Guard: don't deduct more than available
      const actualDeduction = Math.min(coinsDeducted, Math.max(0, currentBalance));

      if (actualDeduction > 0) {
        await userRef.update({
          coins: admin.firestore.FieldValue.increment(-actualDeduction),
          lastSpendAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }

      if (actualDeduction < coinsDeducted) {
        logger.warn(`Balance guard: User ${effectiveCallerId} had ${currentBalance} coins, tried to deduct ${coinsDeducted}, deducted ${actualDeduction}`);
      }
    }

    const newBalance = await (async () => {
      const doc = await db.collection('users').doc(effectiveCallerId || serverTimer.callerId).get();
      const d = doc.data() || {};
      return d.coins ?? d.coinBalance ?? 0;
    })();

    // Update call in Firestore
    await db.collection('calls').doc(finalCallId).update({
      status: 'completed', durationSeconds: serverDuration, coinsDeducted,
      endedAt: new Date().toISOString(),
      endReason: endReason || 'User ended call',
      billingSource: 'server', fraudDetection,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }).catch(() => {});

    // Record female earnings
    if (effectiveRecipientId && serverDuration > 0) {
      try {
        const earningRate = serverTimer.callType === 'video' ? FEMALE_EARNING_RATES.video : FEMALE_EARNING_RATES.audio;
        const earningAmount = parseFloat((serverDuration * earningRate).toFixed(2));
        const dateKey = new Date().toISOString().split('T')[0];

        const femaleEarningsRef = db.collection('female_earnings').doc(effectiveRecipientId);
        await femaleEarningsRef.set({
          totalEarningsINR: admin.firestore.FieldValue.increment(earningAmount),
          availableBalanceINR: admin.firestore.FieldValue.increment(earningAmount),
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
      } catch (err) {
        logger.error(`Failed to record female earnings: ${err.message}`);
      }
    }

    // Record spend transaction
    if (effectiveCallerId && coinsDeducted > 0) {
      try {
        const spendTxnId = `txn_call_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;
        const spendTxnData = {
          id: spendTxnId, userId: effectiveCallerId, type: 'spend', status: 'success',
          coinAmount: coinsDeducted,
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
        batch.set(db.collection('transactions').doc(spendTxnId), spendTxnData);
        batch.update(db.collection('users').doc(effectiveCallerId), {
          totalCoinsSpent: admin.firestore.FieldValue.increment(coinsDeducted)
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
        totalCoinsDeducted: admin.firestore.FieldValue.increment(coinsDeducted),
        lastUpdated: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    } catch (err) {
      logger.warn('Call analytics update failed:', err.message);
    }

    deleteCallTimer(finalCallId);

    // Reset user statuses
    setUserStatus(serverTimer.callerId, { status: 'available', currentCallId: null, lastStatusChange: new Date() });
    setUserStatus(serverTimer.recipientId, { status: 'available', currentCallId: null, lastStatusChange: new Date() });

    res.json({
      success: true, callId: finalCallId,
      durationSeconds: serverDuration, coinsDeducted,
      newBalance, coinRate: serverTimer.coinRate,
      callType: serverTimer.callType, source: 'server',
      fraudDetection,
      message: 'Call completed and billed successfully'
    });
  } catch (error) {
    logger.error('Error completing call:', error);
    res.status(500).json({
      error: 'Failed to complete call',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// ============================================================
// POST /api/calls/heartbeat
// ============================================================
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

// ============================================================
// GET /api/call/:callId
// ============================================================
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
