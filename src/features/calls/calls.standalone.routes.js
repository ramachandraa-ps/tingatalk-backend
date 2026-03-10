import { Router } from 'express';
import { getFirestore, admin } from '../../config/firebase.js';
import { generateAccessToken } from '../../config/twilio.js';
import { logger } from '../../utils/logger.js';
import {
  getActiveCall, getCallTimer, setCallTimer, deleteCallTimer
} from '../../socket/state/connectionManager.js';
import { COIN_RATES, MIN_BALANCE, MIN_CALL_DURATION_SECONDS, ENDED_CALL_STATUSES } from '../../shared/constants.js';

const router = Router();

// POST /api/check_call_status
router.post('/check_call_status', async (req, res) => {
  try {
    const { call_id } = req.body;
    if (!call_id) return res.status(400).json({ error: 'Missing call_id' });

    const activeCall = getActiveCall(call_id);

    if (activeCall) {
      const callStatus = activeCall.status || 'unknown';
      const isRinging = callStatus === 'ringing' || callStatus === 'initiated';
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

// POST /api/validate_balance
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
    const actualBalance = userData.coins ?? userData.coinBalance ?? 0;

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

// POST /api/generate_token
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

// POST /api/start_call_tracking (LEGACY)
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

// POST /api/complete_call (LEGACY)
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
