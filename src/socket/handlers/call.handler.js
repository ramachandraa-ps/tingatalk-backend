import { logger } from '../../utils/logger.js';
import { getFirestore, admin } from '../../config/firebase.js';
import { getMessaging } from '../../config/firebase.js';
import {
  setConnectedUser, getConnectedUser, getAllConnectedUsers,
  setUserStatus, getUserStatus,
  setActiveCall, getActiveCall, deleteActiveCall,
  setCallTimer, getCallTimer, deleteCallTimer, getAllCallTimers,
  completeCall
} from '../state/connectionManager.js';
import { COIN_RATES, CALL_RING_TIMEOUT_MS, FCM_CALL_TIMEOUT_MS } from '../../shared/constants.js';

// FCM notification helper
async function sendIncomingCallNotification(userId, callData) {
  const messaging = getMessaging();
  const db = getFirestore();

  if (!messaging || !db) {
    logger.warn('FCM or Firestore not initialized');
    return false;
  }

  try {
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) return false;

    const fcmToken = userDoc.data()?.fcmToken;
    if (!fcmToken) {
      logger.warn(`No FCM token for user ${userId}`);
      return false;
    }

    // Data-only FCM: no `notification` field so Flutter's onBackgroundMessage
    // handler gets full control to show the full-screen incoming call UI.
    const message = {
      token: fcmToken,
      data: {
        type: 'incoming_call',
        callId: callData.callId || '',
        call_id: callData.callId || '',
        callerId: callData.callerId || '',
        caller_id: callData.callerId || '',
        callerName: callData.callerName || 'Unknown',
        caller_name: callData.callerName || 'Unknown',
        roomName: callData.roomName || '',
        room_name: callData.roomName || '',
        callType: callData.callType || 'video',
        call_type: callData.callType || 'video',
        recipientId: userId,
        recipient_id: userId,
        timestamp: new Date().toISOString()
      },
      android: {
        priority: 'high',
        ttl: 60000
      },
      apns: {
        headers: { 'apns-priority': '10', 'apns-push-type': 'background' },
        payload: {
          aps: {
            'content-available': 1,
            'mutable-content': 1,
            sound: 'default'
          }
        }
      }
    };

    const response = await messaging.send(message);
    logger.info(`FCM notification sent to ${userId}: ${response}`);
    return true;
  } catch (error) {
    logger.error(`FCM send error for ${userId}:`, error.message);
    if (error.code === 'messaging/invalid-registration-token' ||
        error.code === 'messaging/registration-token-not-registered') {
      try {
        await db.collection('users').doc(userId).update({
          fcmToken: admin.firestore.FieldValue.delete(),
          fcmTokenInvalidAt: admin.firestore.FieldValue.serverTimestamp()
        });
      } catch (clearErr) {
        logger.error(`Failed to clear invalid FCM token: ${clearErr.message}`);
      }
    }
    return false;
  }
}

export function registerCallHandlers(io, socket) {

  // =============================================
  // INITIATE CALL
  // =============================================
  socket.on('initiate_call', async (data) => {
    const { callerId, recipientId, callType = 'video', callId, roomName, callerName: providedCallerName } = data;

    logger.info(`INITIATE_CALL: Caller=${callerId}, Recipient=${recipientId}, Type=${callType}`);

    if (!callerId || !recipientId) {
      socket.emit('error', { message: 'Caller ID and Recipient ID are required' });
      return;
    }

    // STEP 1: Check recipient status
    const recipientStatus = getUserStatus(recipientId);
    const recipientConnection = getConnectedUser(recipientId);

    let actualStatus = 'unavailable';
    let hasConnection = false;

    if (recipientConnection && recipientConnection.isOnline) {
      const recipientWs = io.sockets.sockets.get(recipientConnection.socketId);
      if (recipientWs && recipientWs.connected) {
        hasConnection = true;
        actualStatus = recipientStatus ? recipientStatus.status : 'available';
        if (!recipientStatus) {
          setUserStatus(recipientId, {
            status: 'available', currentCallId: null, lastStatusChange: new Date()
          });
        }
      }
    }

    // BUSY/RINGING CHECK - Must be done FIRST
    if (recipientStatus && (recipientStatus.status === 'busy' || recipientStatus.status === 'ringing')) {
      logger.warn(`CALL BLOCKED: Recipient ${recipientId} is ${recipientStatus.status}`);
      socket.emit('call_failed', {
        callId: callId || `call_${Date.now()}`,
        reason: recipientStatus.status === 'busy'
          ? 'User is busy on another call'
          : 'User is receiving another call',
        recipient_status: recipientStatus.status,
        is_busy: true
      });
      return;
    }

    // STEP 2: Get caller name
    let callerName = providedCallerName || null;
    if (!callerName || callerName === 'Unknown' || callerName === callerId) {
      try {
        const db = getFirestore();
        if (db) {
          const callerDoc = await db.collection('users').doc(callerId).get();
          if (callerDoc.exists) {
            const callerData = callerDoc.data();
            callerName = callerData.displayName || callerData.name || callerData.username || 'Someone';
          } else {
            callerName = 'Someone';
          }
        }
      } catch (e) {
        callerName = 'Someone';
      }
    }

    // STEP 3: Check FCM reachability for offline users
    let hasToggleOn = false;
    let hasFcmToken = false;

    if (!hasConnection) {
      try {
        const db = getFirestore();
        if (db) {
          const recipientDoc = await db.collection('users').doc(recipientId).get();
          if (recipientDoc.exists) {
            const recipientData = recipientDoc.data();
            hasToggleOn = recipientData.isAvailable === true;
            hasFcmToken = !!recipientData.fcmToken && recipientData.fcmToken.length > 0;
          }
        }
      } catch (e) {
        logger.warn(`Could not check recipient Firestore data: ${e.message}`);
      }

      if (hasToggleOn && hasFcmToken) {
        actualStatus = 'fcm_reachable';
      } else {
        actualStatus = 'unavailable';
      }
    }

    // STEP 4: Block if unavailable
    if (actualStatus !== 'available' && actualStatus !== 'fcm_reachable') {
      logger.warn(`Call blocked: Recipient ${recipientId} is ${actualStatus}`);
      socket.emit('call_failed', {
        callId: callId || `call_${Date.now()}`,
        reason: `Recipient is currently ${actualStatus}`,
        recipient_status: actualStatus
      });
      return;
    }

    const finalCallId = callId || `call_${callerId}_${recipientId}_${Date.now()}`;
    const finalRoomName = roomName || `${callType}_${callerId}_${recipientId}`;

    // Create call object
    const call = {
      callId: finalCallId,
      roomName: finalRoomName,
      callerId,
      callerName,
      recipientId,
      callType,
      status: 'initiated',
      createdAt: new Date(),
      participants: [callerId]
    };

    setActiveCall(finalCallId, call);

    // STEP 5: Handle online recipient
    const recipient = getConnectedUser(recipientId);
    if (recipient && recipient.isOnline) {
      // Mark recipient as ringing
      setUserStatus(recipientId, {
        status: 'ringing',
        currentCallId: finalCallId,
        lastStatusChange: new Date()
      });

      const recipientSocketId = recipient.socketId;

      // Prepare payload with both camelCase and snake_case
      const incomingCallPayload = {
        callId: finalCallId,
        roomName: finalRoomName,
        callerId,
        callerName,
        recipientId,
        callType,
        timestamp: new Date().toISOString(),
        caller_id: callerId,
        caller_name: callerName,
        recipient_id: recipientId,
        room_name: finalRoomName,
        call_type: callType,
        call_id: finalCallId
      };

      // Emit to recipient only
      io.to(recipientSocketId).emit('incoming_call', incomingCallPayload);

      // Also send FCM as backup
      sendIncomingCallNotification(recipientId, {
        callId: finalCallId,
        callerId,
        callerName,
        roomName: finalRoomName,
        callType
      }).catch(err => logger.warn(`Backup FCM failed: ${err.message}`));

      call.status = 'ringing';
      call.recipientOnline = true;
      call.recipientSocketId = recipientSocketId;

      // Notify caller
      socket.emit('call_initiated', {
        callId: finalCallId,
        roomName: finalRoomName,
        status: 'ringing',
        recipientOnline: true,
        recipientSocketId
      });

      // Call timeout (30 seconds)
      setTimeout(() => {
        const currentCall = getActiveCall(finalCallId);
        if (currentCall && currentCall.status === 'ringing') {
          logger.warn(`Call timeout: ${finalCallId} - No response from ${recipientId}`);

          setUserStatus(recipientId, {
            status: 'available', currentCallId: null, lastStatusChange: new Date()
          });

          io.to(recipientSocketId).emit('call_timeout', { callId: finalCallId });
          socket.emit('call_timeout', { callId: finalCallId, reason: 'No response from recipient' });

          currentCall.status = 'timeout';
          currentCall.timeoutAt = new Date();
          completeCall(finalCallId, {
            status: 'timeout',
            timeoutAt: new Date(),
            endedAt: new Date()
          });
        }
      }, CALL_RING_TIMEOUT_MS);

    } else {
      // STEP 6: Handle offline/FCM-reachable recipient
      if (actualStatus === 'fcm_reachable') {
        logger.info(`Sending FCM push to ${recipientId}`);

        const fcmSent = await sendIncomingCallNotification(recipientId, {
          callId: finalCallId, callerId, callerName, roomName: finalRoomName, callType
        });

        if (fcmSent) {
          call.status = 'pending_fcm';
          call.recipientOnline = false;
          call.fcmSent = true;

          socket.emit('call_initiated', {
            callId: finalCallId,
            roomName: finalRoomName,
            status: 'ringing_fcm',
            recipientOnline: false,
            fcmSent: true,
            message: 'Push notification sent to recipient'
          });

          // FCM timeout (60 seconds)
          setTimeout(() => {
            const currentCall = getActiveCall(finalCallId);
            if (currentCall && (currentCall.status === 'pending_fcm' || currentCall.status === 'ringing')) {
              logger.warn(`FCM Call timeout: ${finalCallId}`);
              socket.emit('call_timeout', {
                callId: finalCallId,
                reason: 'No response from recipient (FCM)'
              });
              currentCall.status = 'timeout';
              completeCall(finalCallId, {
                status: 'timeout', timeoutAt: new Date(), endedAt: new Date()
              });
            }
          }, FCM_CALL_TIMEOUT_MS);
        } else {
          call.status = 'failed';
          socket.emit('call_failed', { callId: finalCallId, reason: 'Could not reach recipient' });
        }
      } else {
        call.status = 'failed';
        socket.emit('call_failed', { callId: finalCallId, reason: 'Recipient is offline' });
      }
    }
  });

  // =============================================
  // ACCEPT CALL
  // =============================================
  socket.on('accept_call', async (data) => {
    const { callId, callerId, recipientId } = data;

    const call = getActiveCall(callId);
    if (!call) {
      socket.emit('error', { message: 'Call not found' });
      return;
    }

    if (call.recipientId !== recipientId) {
      socket.emit('error', { message: 'Unauthorized to accept this call' });
      return;
    }

    // Mark both users as busy
    setUserStatus(callerId, { status: 'busy', currentCallId: callId, lastStatusChange: new Date() });
    setUserStatus(recipientId, { status: 'busy', currentCallId: callId, lastStatusChange: new Date() });

    call.status = 'accepted';
    call.participants.push(recipientId);
    call.acceptedAt = new Date();

    // Auto-start billing timer if not already started
    if (!getCallTimer(callId)) {
      const coinRate = call.callType === 'video' ? COIN_RATES.video : COIN_RATES.audio;
      const startTime = Date.now();

      const interval = setInterval(() => {
        const timer = getCallTimer(callId);
        if (timer) {
          timer.durationSeconds++;
          if (timer.durationSeconds % 30 === 0) {
            logger.info(`Call ${callId} duration: ${timer.durationSeconds}s (auto-started on accept)`);
          }
        }
      }, 1000);

      setCallTimer(callId, {
        interval,
        durationSeconds: 0,
        coinRate,
        callerId,
        recipientId,
        callType: call.callType,
        startTime,
        lastHeartbeat: Date.now(),
        autoStarted: true
      });

      logger.info(`Auto-started billing timer for call ${callId} (${call.callType}) - Rate: ${coinRate}/s`);

      // Save to Firestore as 'active'
      try {
        const db = getFirestore();
        if (db) {
          await db.collection('calls').doc(callId).set({
            callId, callerId, recipientId,
            callType: call.callType,
            roomName: call.roomName,
            status: 'active',
            coinRatePerSecond: coinRate,
            startedAt: new Date().toISOString(),
            acceptedAt: call.acceptedAt.toISOString(),
            durationSeconds: 0,
            coinsDeducted: 0,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
        }
      } catch (err) {
        logger.error(`Failed to save call to Firestore: ${err.message}`);
      }
    }

    // Notify caller
    const caller = getConnectedUser(callerId);
    if (caller) {
      io.to(caller.socketId).emit('call_accepted', {
        callId,
        roomName: call.roomName,
        recipientId,
        acceptedAt: call.acceptedAt.toISOString()
      });
    }

    logger.info(`Call accepted: ${callId} by ${recipientId} - Both users busy, billing started`);
  });

  // =============================================
  // DECLINE CALL
  // =============================================
  socket.on('decline_call', (data) => {
    const { callId, callerId, recipientId } = data;

    const call = getActiveCall(callId);
    if (!call) {
      socket.emit('error', { message: 'Call not found' });
      return;
    }

    call.status = 'declined';
    call.declinedAt = new Date();

    // Reset recipient status
    setUserStatus(recipientId, {
      status: 'available', currentCallId: null, lastStatusChange: new Date()
    });

    // Notify caller
    const caller = getConnectedUser(callerId);
    if (caller) {
      io.to(caller.socketId).emit('call_declined', {
        callId,
        reason: 'Call declined by recipient',
        declinedAt: call.declinedAt.toISOString()
      });
    }

    completeCall(callId, {
      status: 'declined',
      declinedAt: call.declinedAt,
      endedAt: new Date()
    });

    logger.info(`Call declined: ${callId} by ${recipientId}`);
  });

  // =============================================
  // END CALL
  // =============================================
  socket.on('end_call', async (data) => {
    const { callId, userId } = data;

    const call = getActiveCall(callId);
    if (!call) {
      // Call already cleaned up (by other party's end_call, timeout, or stale detector)
      // Still persist isAvailable=true for the user who sent this event
      logger.info(`end_call for already-cleaned call ${callId} from ${userId} — persisting availability`);
      if (userId) {
        setUserStatus(userId, { status: 'available', currentCallId: null, lastStatusChange: new Date() });
        try {
          const db = getFirestore();
          if (db) {
            await db.collection('users').doc(userId).update({
              isAvailable: true,
              lastCallEndedAt: admin.firestore.FieldValue.serverTimestamp()
            });
          }
        } catch (err) {
          logger.warn(`Failed to persist availability for ${userId}: ${err.message}`);
        }
      }
      return;
    }

    call.status = 'ended';
    call.endedAt = new Date();
    call.endedBy = userId;

    // Stop server timer
    const serverTimer = getCallTimer(callId);
    if (serverTimer) {
      clearInterval(serverTimer.interval);
      logger.info(`Stopped server timer for call ${callId}: ${serverTimer.durationSeconds}s`);
    }

    // Reset all participants
    if (call.participants) {
      const db = getFirestore();
      call.participants.forEach(participantId => {
        setUserStatus(participantId, {
          status: 'available', currentCallId: null, lastStatusChange: new Date()
        });

        const participant = getConnectedUser(participantId);
        if (participant) {
          io.to(participant.socketId).emit('call_ended', {
            callId,
            endedBy: userId,
            duration: call.endedAt - call.createdAt,
            endedAt: call.endedAt.toISOString()
          });
        }

        // Persist isAvailable=true to Firestore so check_availability reads correct
        // value during the socket reconnection gap after call screen navigation
        if (db) {
          db.collection('users').doc(participantId).update({
            isAvailable: true,
            lastCallEndedAt: admin.firestore.FieldValue.serverTimestamp()
          }).catch(err => logger.warn(`Failed to persist post-call status for ${participantId}: ${err.message}`));
        }
      });
    }

    completeCall(callId, {
      status: 'ended',
      endedAt: call.endedAt,
      endedBy: userId
    });
    deleteCallTimer(callId);

    logger.info(`Call ended: ${callId} by ${userId}`);
  });

  // =============================================
  // CANCEL CALL
  // =============================================
  socket.on('cancel_call', async (data) => {
    const { callId, callerId, recipientId, userId, reason } = data;

    logger.info(`CANCEL_CALL: ${callId}, cancelled by ${userId}, reason: ${reason}`);

    const call = getActiveCall(callId);

    if (call) {
      call.status = 'cancelled';
      call.cancelledAt = new Date();
      call.cancelledBy = userId;
      call.cancelReason = reason;

      // Reset recipient status
      setUserStatus(recipientId, {
        status: 'available', currentCallId: null, lastStatusChange: new Date()
      });

      // Notify recipient
      const recipient = getConnectedUser(recipientId);
      if (recipient) {
        io.to(recipient.socketId).emit('call_cancelled', {
          callId,
          cancelledBy: userId,
          reason: reason || 'caller_cancelled',
          cancelledAt: call.cancelledAt.toISOString()
        });
        // Also emit call_ended for compatibility
        io.to(recipient.socketId).emit('call_ended', {
          callId,
          endedBy: userId,
          reason: 'cancelled',
          endedAt: call.cancelledAt.toISOString()
        });
      }

      completeCall(callId, {
        status: 'cancelled',
        cancelledAt: call.cancelledAt,
        cancelledBy: userId,
        cancelReason: reason,
        endedAt: call.cancelledAt
      });
    } else {
      // Even if not in memory, update Firestore
      const db = getFirestore();
      if (db) {
        db.collection('calls').doc(callId).update({
          status: 'cancelled',
          cancelledAt: new Date(),
          cancelledBy: userId,
          cancelReason: reason,
          endedAt: new Date(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }).catch(err => logger.error(`Error updating cancelled call: ${err.message}`));
      }

      // Still notify recipient
      const recipient = getConnectedUser(recipientId);
      if (recipient) {
        io.to(recipient.socketId).emit('call_cancelled', {
          callId, cancelledBy: userId, reason: reason || 'caller_cancelled'
        });
        io.to(recipient.socketId).emit('call_ended', {
          callId, endedBy: userId, reason: 'cancelled'
        });
      }
    }

    logger.info(`Call ${callId} cancelled successfully`);
  });
}
