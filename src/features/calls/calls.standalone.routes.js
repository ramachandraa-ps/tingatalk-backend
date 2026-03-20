import { Router } from 'express';
import { getFirestore, admin } from '../../config/firebase.js';
import { generateAccessToken } from '../../config/twilio.js';
import { logger } from '../../utils/logger.js';
import {
  getActiveCall, getCallTimer, setCallTimer, deleteCallTimer
} from '../../socket/state/connectionManager.js';
import { COIN_RATES, MIN_BALANCE, MIN_CALL_DURATION_SECONDS, ENDED_CALL_STATUSES } from '../../shared/constants.js';

const router = Router();

/**
 * @openapi
 * /api/check_call_status:
 *   post:
 *     tags:
 *       - Calls
 *     summary: Check the status of a call
 *     description: Checks whether a call is active, ringing, connected, or ended. Looks up the call in in-memory state first, then falls back to Firestore.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - call_id
 *             properties:
 *               call_id:
 *                 type: string
 *     responses:
 *       200:
 *         description: Call status result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 call_active:
 *                   type: boolean
 *                 call_status:
 *                   type: string
 *                 is_ringing:
 *                   type: boolean
 *                 is_connected:
 *                   type: boolean
 *                 is_ended:
 *                   type: boolean
 *                 ended_reason:
 *                   type: string
 *                   nullable: true
 *                 call_data:
 *                   type: object
 *                 message:
 *                   type: string
 *       400:
 *         description: Missing call_id
 *       500:
 *         description: Server error
 */
router.post('/check_call_status', async (req, res) => {
  try {
    const { call_id } = req.body;
    if (!call_id) return res.status(400).json({ error: 'Missing call_id' });

    const activeCall = getActiveCall(call_id);

    if (activeCall) {
      const callStatus = activeCall.status || 'unknown';
      const isRinging = callStatus === 'ringing' || callStatus === 'initiated'
                     || callStatus === 'pending_fcm' || callStatus === 'ringing_fcm';
      const isConnected = callStatus === 'connected' || callStatus === 'answered';
      const isEnded = ENDED_CALL_STATUSES.includes(callStatus);
      const isActive = !isEnded && (isRinging || isConnected || callStatus === 'unknown');

      return res.json({
        success: true, call_active: isActive, call_status: callStatus,
        is_ringing: isRinging, is_connected: isConnected, is_ended: isEnded,
        ended_reason: isEnded ? callStatus : null,
        call_data: {
          callId: activeCall.callId, callerId: activeCall.callerId,
          callerName: activeCall.callerName, recipientId: activeCall.recipientId,
          callType: activeCall.callType, roomName: activeCall.roomName,
          startedAt: activeCall.startedAt
        },
        message: isEnded ? `Call has ended (${callStatus})` : `Call is ${callStatus}`
      });
    }

    // Check Firestore
    const db = getFirestore();
    if (db) {
      const callDoc = await db.collection('calls').doc(call_id).get();
      if (callDoc.exists) {
        const callData = callDoc.data();
        const callStatus = callData.status || 'unknown';
        const isEnded = ENDED_CALL_STATUSES.includes(callStatus);

        return res.json({
          success: true, call_active: !isEnded, call_status: callStatus,
          is_ringing: false, is_connected: false, is_ended: isEnded,
          ended_reason: isEnded ? callStatus : null,
          call_data: {
            callId: callData.callId, callerId: callData.callerId,
            callerName: callData.callerName, recipientId: callData.recipientId,
            callType: callData.callType, roomName: callData.roomName,
            endedAt: callData.endedAt, duration: callData.duration
          },
          message: isEnded ? `Call has ended (${callStatus})` : `Call status: ${callStatus}`
        });
      }
    }

    return res.json({
      success: true, call_active: false, call_status: 'not_found',
      is_ringing: false, is_connected: false, is_ended: true,
      ended_reason: 'not_found',
      message: 'Call not found - may have ended or never existed'
    });
  } catch (error) {
    logger.error('Error in check_call_status:', error);
    res.status(500).json({
      error: 'Failed to check call status',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

/**
 * @openapi
 * /api/validate_balance:
 *   post:
 *     tags:
 *       - Calls
 *     summary: Validate user balance for a call
 *     description: Checks if a user has sufficient coin balance to start a call of the specified type. Returns balance details and minimum requirements.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - user_id
 *               - call_type
 *             properties:
 *               user_id:
 *                 type: string
 *               call_type:
 *                 type: string
 *                 enum: [audio, video]
 *     responses:
 *       200:
 *         description: Balance validation result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 has_sufficient_balance:
 *                   type: boolean
 *                 current_balance:
 *                   type: number
 *                 required_balance:
 *                   type: number
 *                 shortfall:
 *                   type: number
 *                 coin_rate_per_second:
 *                   type: number
 *                 minimum_duration_seconds:
 *                   type: integer
 *                 call_type:
 *                   type: string
 *                 message:
 *                   type: string
 *       400:
 *         description: Missing required fields
 *       404:
 *         description: User not found
 *       500:
 *         description: Server error
 */
router.post('/validate_balance', async (req, res) => {
  try {
    const { user_id, call_type } = req.body;

    if (!user_id || !call_type) {
      return res.status(400).json({ error: 'Missing required fields: user_id, call_type' });
    }

    // Server-authoritative: read actual balance from Firestore
    const db = getFirestore();
    const userDoc = await db.collection('users').doc(user_id).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userData = userDoc.data();
    const actualBalance = userData.coins ?? 0;

    const isVideo = call_type === 'video';
    const requiredBalance = isVideo ? MIN_BALANCE.video : MIN_BALANCE.audio;
    const coinRate = isVideo ? COIN_RATES.video : COIN_RATES.audio;
    const hasEnoughBalance = actualBalance >= requiredBalance;

    res.json({
      success: hasEnoughBalance,
      has_sufficient_balance: hasEnoughBalance,
      current_balance: actualBalance,
      required_balance: requiredBalance,
      shortfall: hasEnoughBalance ? 0 : Math.max(0, requiredBalance - actualBalance),
      coin_rate_per_second: coinRate,
      minimum_duration_seconds: MIN_CALL_DURATION_SECONDS,
      call_type,
      message: hasEnoughBalance
        ? 'Sufficient balance for call'
        : `Insufficient balance. Need at least ${requiredBalance} coins for ${MIN_CALL_DURATION_SECONDS / 60} minutes`
    });
  } catch (error) {
    logger.error('Error in validate_balance:', error);
    res.status(500).json({
      error: 'Failed to validate balance',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

/**
 * @openapi
 * /api/generate_token:
 *   post:
 *     tags:
 *       - Calls
 *     summary: Generate a Twilio access token
 *     description: Generates a Twilio Video/Audio access token for a user to join a room. Token expires in 30 minutes.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - user_identity
 *               - room_name
 *             properties:
 *               user_identity:
 *                 type: string
 *                 description: Unique user identity for the token
 *               room_name:
 *                 type: string
 *                 description: "Room name in format: (video|audio)_userIds"
 *               is_video:
 *                 type: boolean
 *                 default: true
 *     responses:
 *       200:
 *         description: Access token generated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 accessToken:
 *                   type: string
 *                 room_name:
 *                   type: string
 *                 user_identity:
 *                   type: string
 *                 is_video:
 *                   type: boolean
 *                 coin_rate_per_second:
 *                   type: number
 *                 expiresAt:
 *                   type: string
 *                   format: date-time
 *                 server_timestamp:
 *                   type: string
 *                   format: date-time
 *       400:
 *         description: Missing fields or invalid room_name format
 *       500:
 *         description: Server error
 */
router.post('/generate_token', async (req, res) => {
  try {
    const { user_identity, room_name, is_video = true } = req.body;

    if (!user_identity || !room_name) {
      return res.status(400).json({ error: 'Missing required fields: user_identity and room_name' });
    }

    if (!room_name.match(/^(video|audio)_[a-zA-Z0-9_]+$/)) {
      return res.status(400).json({ error: 'Invalid room_name format. Must be: (video|audio)_userIds' });
    }

    const accessToken = generateAccessToken(user_identity, room_name, is_video);
    const coinRate = is_video ? COIN_RATES.video : COIN_RATES.audio;

    res.json({
      accessToken, room_name, user_identity, is_video,
      coin_rate_per_second: coinRate,
      expiresAt: new Date(Date.now() + 1800000).toISOString(),
      server_timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error in generate_token:', error);
    res.status(500).json({
      error: 'Failed to generate access token',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

/**
 * @openapi
 * /api/start_call_tracking:
 *   post:
 *     tags:
 *       - Calls
 *     summary: Start server-side call tracking (legacy)
 *     description: "[LEGACY] Starts a server-side timer for call billing. Use POST /api/calls/start instead."
 *     deprecated: true
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - call_id
 *               - caller_id
 *               - recipient_id
 *               - call_type
 *             properties:
 *               call_id:
 *                 type: string
 *               caller_id:
 *                 type: string
 *               recipient_id:
 *                 type: string
 *               call_type:
 *                 type: string
 *                 enum: [audio, video]
 *               room_name:
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
 *                 call_id:
 *                   type: string
 *                 coin_rate_per_second:
 *                   type: number
 *                 server_start_time:
 *                   type: string
 *                   format: date-time
 *                 message:
 *                   type: string
 *       400:
 *         description: Missing required fields
 *       500:
 *         description: Server error
 */
router.post('/start_call_tracking', async (req, res) => {
  try {
    const { call_id, caller_id, recipient_id, call_type, room_name } = req.body;

    if (!call_id || !caller_id || !recipient_id || !call_type) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const coinRate = call_type === 'video' ? COIN_RATES.video : COIN_RATES.audio;
    const startTime = Date.now();

    const interval = setInterval(() => {
      const timer = getCallTimer(call_id);
      if (timer) {
        timer.durationSeconds++;
        if (timer.durationSeconds % 10 === 0) {
          logger.debug(`Call ${call_id} duration: ${timer.durationSeconds}s`);
        }
      }
    }, 1000);

    setCallTimer(call_id, {
      interval, startTime, durationSeconds: 0,
      callerId: caller_id, recipientId: recipient_id,
      callType: call_type, coinRate, roomName: room_name,
      lastHeartbeat: Date.now()
    });

    res.json({
      success: true, call_id,
      coin_rate_per_second: coinRate,
      server_start_time: new Date(startTime).toISOString(),
      message: 'Server-side call tracking started'
    });
  } catch (error) {
    logger.error('Error in start_call_tracking:', error);
    res.status(500).json({
      error: 'Failed to start call tracking',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

/**
 * @openapi
 * /api/complete_call:
 *   post:
 *     tags:
 *       - Calls
 *     summary: Complete a call and get billing info (legacy)
 *     description: "[LEGACY] Stops the server-side timer and returns billing information. Use POST /api/calls/complete instead."
 *     deprecated: true
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - call_id
 *             properties:
 *               call_id:
 *                 type: string
 *               client_duration_seconds:
 *                 type: number
 *                 description: Client-reported duration for fraud detection
 *               client_coins_deducted:
 *                 type: number
 *                 description: Client-reported deduction for fallback
 *     responses:
 *       200:
 *         description: Call completed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 call_id:
 *                   type: string
 *                 duration_seconds:
 *                   type: integer
 *                 coins_deducted:
 *                   type: number
 *                 coin_rate_per_second:
 *                   type: number
 *                 call_type:
 *                   type: string
 *                 source:
 *                   type: string
 *                   enum: [server, client]
 *                 validation:
 *                   type: object
 *                   properties:
 *                     client_duration:
 *                       type: number
 *                     server_duration:
 *                       type: integer
 *                     duration_diff_seconds:
 *                       type: number
 *                     is_fraudulent:
 *                       type: boolean
 *       400:
 *         description: Missing call_id
 *       500:
 *         description: Server error
 */
router.post('/complete_call', async (req, res) => {
  try {
    const { call_id, client_duration_seconds, client_coins_deducted } = req.body;

    if (!call_id) return res.status(400).json({ error: 'Missing call_id' });

    const serverTimer = getCallTimer(call_id);

    if (!serverTimer) {
      return res.json({
        success: true, call_id,
        duration_seconds: client_duration_seconds || 0,
        coins_deducted: client_coins_deducted || 0,
        source: 'client',
        warning: 'Server timer not found, using client-reported values'
      });
    }

    clearInterval(serverTimer.interval);
    const serverDuration = serverTimer.durationSeconds;
    const serverCoinsDeducted = Math.ceil(serverDuration * serverTimer.coinRate);

    const durationDiff = Math.abs(serverDuration - (client_duration_seconds || 0));
    const isFraudulent = durationDiff > 5;

    if (isFraudulent) {
      logger.warn(`FRAUD ALERT: Call ${call_id} - Server: ${serverDuration}s, Client: ${client_duration_seconds}s`);
    }

    deleteCallTimer(call_id);

    res.json({
      success: true, call_id,
      duration_seconds: serverDuration,
      coins_deducted: serverCoinsDeducted,
      coin_rate_per_second: serverTimer.coinRate,
      call_type: serverTimer.callType,
      source: 'server',
      validation: {
        client_duration: client_duration_seconds,
        server_duration: serverDuration,
        duration_diff_seconds: durationDiff,
        is_fraudulent: isFraudulent
      }
    });
  } catch (error) {
    logger.error('Error in complete_call:', error);
    res.status(500).json({
      error: 'Failed to complete call',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

export default router;
