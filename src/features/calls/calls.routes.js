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
  FEMALE_EARNING_RATES
} from '../../shared/constants.js';
import { performCallBilling } from '../../utils/callBillingUtil.js';

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

    // ===== ACTIVE-CALL CROSS-CHECK (defense in depth) =====
    // Even if userStatus is wrong (e.g., reset to 'available' by a stale
    // disconnect/reconnect race), the activeCalls map is the authoritative
    // truth: if there's an active call where this recipient is a participant,
    // we MUST reject. Twilio is still actively connected on her device.
    // Logged as WARN so we can monitor busy-rejection rate in production.
    const activeCalls = getAllActiveCalls();
    for (const [activeCallId, activeCall] of activeCalls.entries()) {
      if (activeCall.status === 'completed') continue;
      const recipientInActiveCall = activeCall.recipientId === recipientId ||
                                     activeCall.callerId === recipientId ||
                                     (Array.isArray(activeCall.participants) && activeCall.participants.includes(recipientId));
      if (recipientInActiveCall) {
        logger.warn(`HTTP /api/calls/start REJECTED: recipient ${recipientId} already in active call ${activeCallId} (callType=${activeCall.callType}) — blocking call ${callId} from caller ${callerId}`);
        return res.status(400).json({
          error: 'Recipient is not available',
          recipientStatus: 'busy',
          is_busy: true,
          message: 'User is currently on another call'
        });
      }
    }

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
      logger.warn(`HTTP /api/calls/start REJECTED: recipient ${recipientId} status=${actualStatus} (call ${callId} from caller ${callerId})`);
      return res.status(400).json({
        error: 'Recipient is not available',
        recipientStatus: actualStatus,
        is_busy: actualStatus === 'busy' || actualStatus === 'ringing',
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

    if (callerBalance < requiredBalance) {
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
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    await db.collection('calls').doc(callId).set(callData, { merge: true });

    // Start timer with precise per-second balance check.
    //
    // Old logic compared Firestore balance vs projected need every 30s — but
    // Firestore is only decremented at call END (in /api/calls/complete), so
    // for a user starting with exactly MIN_BALANCE coins the check never
    // triggered (balance stayed equal to projected need throughout the call).
    //
    // New logic: snapshot the initial balance into the timer, then each
    // second compute coins-already-used and end exactly when used >= initial.
    // For 30 coins at 0.5/sec → ends at second 60 precisely.
    const ioApp = req.app.get('io');
    const interval = setInterval(async () => {
      const timer = getCallTimer(callId);
      if (!timer) return;
      timer.durationSeconds++;

      const usedInCall = timer.durationSeconds * timer.coinRate;
      if (usedInCall >= timer.initialBalance) {
        logger.warn(`AUTO-END: ${callId} - caller ${timer.callerId} initial balance ${timer.initialBalance} exhausted at ${timer.durationSeconds}s (used: ${usedInCall.toFixed(2)})`);
        clearInterval(timer.interval);
        // Run the same billing pipeline as /api/calls/complete so coins
        // are deducted and female earnings are credited (not just notify+kill).
        await performCallBilling({
          callId, timer,
          endReason: 'insufficient_balance',
          source: 'server_auto_end',
          db, io: ioApp,
        });
        setUserStatus(timer.callerId, { status: 'available', currentCallId: null, lastStatusChange: new Date() });
        setUserStatus(timer.recipientId, { status: 'available', currentCallId: null, lastStatusChange: new Date() });
        deleteCallTimer(callId);
      }
    }, 1000);

    setCallTimer(callId, {
      interval, durationSeconds: 0, coinRate, callerId, recipientId,
      callType, callerName, startTime, lastHeartbeat: Date.now(),
      initialBalance: callerBalance,
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

    // Idempotency: skip re-billing if SERVER already billed this call via any path.
    // billingSource can be 'server' (legacy), 'normal_completion', 'server_auto_end',
    // or 'disconnect_recovery' — all of these are authoritative server-side billings.
    // Only 'client_fallback' is NOT considered fully billed (allows the no-timer path
    // to top up female earnings if the client reports a longer duration than recorded).
    const ALREADY_BILLED_SOURCES = new Set([
      'server', 'normal_completion', 'server_auto_end', 'disconnect_recovery',
    ]);
    const db = getFirestore();
    let existingCallData = null;
    if (db) {
      try {
        const existingCall = await db.collection('calls').doc(finalCallId).get();
        if (existingCall.exists) {
          existingCallData = existingCall.data();
          const alreadyBilled = existingCallData.status === 'completed' &&
            ALREADY_BILLED_SOURCES.has(existingCallData.billingSource);
          if (alreadyBilled) {
            logger.info(`Call ${finalCallId} already billed (source: ${existingCallData.billingSource}) — returning cached result`);
            return res.json({
              success: true, callId: finalCallId,
              durationSeconds: existingCallData.durationSeconds || 0,
              coinsDeducted: existingCallData.coinsDeducted || 0,
              newBalance: null,
              source: existingCallData.billingSource === 'server_auto_end' ? 'server_auto_end' : 'already_completed',
              duplicate: true,
              message: existingCallData.billingSource === 'server_auto_end'
                ? 'Call ended by server (insufficient balance) and was already billed'
                : 'Call was already completed and billed'
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
        // Top-up logic: if disconnect-recovery already ran and recorded a SHORTER
        // duration than the client now reports, credit the female the difference.
        // This is the safety net for cases where disconnect-recovery undercounted
        // (e.g., timer was killed early by socket flap, but the call actually
        // continued on the male's device a few seconds longer).
        let topupApplied = null;
        try {
          const recordedDuration = (existingCallData && existingCallData.durationSeconds) || 0;
          const clientDuration = Number(client_duration_seconds) || 0;
          const deltaSeconds = clientDuration - recordedDuration;
          // Only apply top-up if difference is meaningful (>5s) AND we have all the metadata
          if (deltaSeconds > 5 && existingCallData && existingCallData.recipientId && existingCallData.callType && db) {
            const callType = existingCallData.callType;
            const earningRate = callType === 'video' ? FEMALE_EARNING_RATES.video : FEMALE_EARNING_RATES.audio;
            const topupAmount = parseFloat((deltaSeconds * earningRate).toFixed(2));
            const recipientId = existingCallData.recipientId;

            const femaleEarningsRef = db.collection('female_earnings').doc(recipientId);
            await femaleEarningsRef.set({
              totalEarnings: admin.firestore.FieldValue.increment(topupAmount),
              availableBalance: admin.firestore.FieldValue.increment(topupAmount),
              totalDurationSeconds: admin.firestore.FieldValue.increment(deltaSeconds),
              lastUpdated: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });

            const dateKey = new Date().toISOString().split('T')[0];
            await femaleEarningsRef.collection('daily').doc(dateKey).set({
              date: dateKey,
              earnings: admin.firestore.FieldValue.increment(topupAmount),
              durationSeconds: admin.firestore.FieldValue.increment(deltaSeconds),
              lastUpdated: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });

            // Idempotent: same callId-based topup transaction doc — re-running merges, doesn't duplicate.
            await femaleEarningsRef.collection('transactions').doc(`${finalCallId}__topup`).set({
              type: 'call_earning_topup',
              callId: finalCallId,
              callType,
              additionalDurationSeconds: deltaSeconds,
              amount: topupAmount,
              currency: 'INR',
              ratePerSecond: earningRate,
              completedAt: new Date().toISOString(),
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
              status: 'completed',
              reason: 'late_client_report_after_disconnect_recovery',
            }, { merge: true });

            topupApplied = { deltaSeconds, topupAmount, recipientId };
            logger.info(`Topup applied for ${finalCallId}: female ${recipientId} credited Rs.${topupAmount} for ${deltaSeconds}s additional (client ${clientDuration}s vs recorded ${recordedDuration}s)`);
          }
        } catch (topupErr) {
          logger.warn(`Top-up check/apply failed for ${finalCallId}: ${topupErr.message}`);
        }

        if (db) {
          await db.collection('calls').doc(finalCallId).update({
            status: 'completed', durationSeconds: client_duration_seconds || 0,
            coinsDeducted: client_coins_deducted || 0,
            endedAt: new Date().toISOString(),
            endReason: endReason || 'User ended call',
            billingSource: 'client_fallback',
            ...(topupApplied && { topupApplied }),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }).catch(() => {});
        }

        return res.json({
          success: true, callId: finalCallId,
          durationSeconds: client_duration_seconds || 0,
          coinsDeducted: client_coins_deducted || 0,
          newBalance: null, source: 'client_fallback',
          ...(topupApplied && { topupApplied }),
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

    // Stop timer (we'll delete it after billing — duration was captured into timer.durationSeconds by the interval ticks)
    clearInterval(serverTimer.interval);
    const serverDuration = serverTimer.durationSeconds;

    // Fraud detection — preserved for audit on the call doc
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

    const effectiveCallerId = finalCallerId || serverTimer.callerId;
    const effectiveRecipientId = finalRecipientId || serverTimer.recipientId;

    // Delegate to single-source-of-truth billing helper.
    // Same function used by server_auto_end and (now) disconnect_recovery —
    // ensures female earnings are calculated identically regardless of how
    // the call ended.
    const io = req.app.get('io');
    const billingResult = await performCallBilling({
      callId: finalCallId,
      timer: { ...serverTimer, callerId: effectiveCallerId, recipientId: effectiveRecipientId },
      endReason: endReason || 'User ended call',
      source: 'normal_completion',
      db,
      io,
      endedBy: effectiveCallerId,
      fraudDetection,
    });

    deleteCallTimer(finalCallId);

    // Reset user statuses (kept outside billing helper — different paths reset differently)
    setUserStatus(serverTimer.callerId, { status: 'available', currentCallId: null, lastStatusChange: new Date() });
    setUserStatus(serverTimer.recipientId, { status: 'available', currentCallId: null, lastStatusChange: new Date() });

    res.json({
      success: true, callId: finalCallId,
      durationSeconds: billingResult.durationSeconds,
      coinsDeducted: billingResult.actualDeduction,
      newBalance: billingResult.newBalance,
      coinRate: serverTimer.coinRate,
      callType: serverTimer.callType,
      source: 'server',
      fraudDetection,
      earningAmount: billingResult.earningAmount,
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
