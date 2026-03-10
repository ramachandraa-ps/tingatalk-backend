import { logger } from '../../utils/logger.js';
import { getFirestore, admin } from '../../config/firebase.js';
import {
  setConnectedUser, getConnectedUser, getAllConnectedUsers,
  setUserStatus, getUserStatus,
  getActiveCall,
  getCallTimer, deleteCallTimer,
  startDisconnectTimeout, cancelDisconnectTimeout,
  completeCall, setCallTimer
} from '../state/connectionManager.js';
import { COIN_RATES } from '../../shared/constants.js';

export function registerConnectionHandlers(io, socket) {

  socket.on('join', async (data) => {
    let userId, userType;

    if (typeof data === 'string') {
      userId = data;
      userType = 'unknown';
    } else if (typeof data === 'object' && data !== null) {
      userId = data.userId || data.user_id;
      userType = data.userType || data.user_type;
    } else {
      socket.emit('error', { message: 'Invalid join data format' });
      return;
    }

    if (!userId) {
      socket.emit('error', { message: 'User ID is required' });
      return;
    }

    logger.info(`Processing join for user: ${userId}`);

    // Cancel any pending disconnect timeout
    cancelDisconnectTimeout(userId);

    // Handle existing connection (reconnect scenario)
    const existingUser = getConnectedUser(userId);
    if (existingUser && existingUser.socketId !== socket.id) {
      logger.warn(`User ${userId} reconnecting - Previous socket: ${existingUser.socketId}, New: ${socket.id}`);
      const oldSocket = io.sockets.sockets.get(existingUser.socketId);
      if (oldSocket) {
        oldSocket.leave(`user_${userId}`);
        oldSocket.disconnect(true);
        logger.info(`Disconnected old socket: ${existingUser.socketId}`);
      }
    }

    // Store connection
    setConnectedUser(userId, {
      socketId: socket.id,
      userType: userType || 'unknown',
      connectedAt: new Date(),
      isOnline: true
    });

    // Set user status from Firestore preference
    const currentStatus = getUserStatus(userId);
    if (!currentStatus || currentStatus.status === 'unavailable' || currentStatus.status === 'disconnected') {
      let savedPreference = true;
      try {
        const db = getFirestore();
        if (db) {
          const userDoc = await db.collection('users').doc(userId).get();
          if (userDoc.exists) {
            savedPreference = userDoc.data().isAvailable !== false;
            logger.info(`Loaded saved availability preference for ${userId}: ${savedPreference}`);
          }
        }
      } catch (err) {
        logger.warn(`Could not load availability preference: ${err.message}`);
      }

      setUserStatus(userId, {
        status: savedPreference ? 'available' : 'unavailable',
        currentCallId: null,
        lastStatusChange: new Date(),
        userPreference: savedPreference
      });
      logger.info(`User ${userId} status set to: ${savedPreference ? 'available' : 'unavailable'}`);
    } else {
      logger.info(`User ${userId} status remains: ${currentStatus.status}`);
    }

    // Join user-specific room
    const roomName = `user_${userId}`;
    socket.join(roomName);

    // Update Firestore online status
    try {
      const db = getFirestore();
      if (db) {
        await db.collection('users').doc(userId).update({
          isOnline: true,
          lastSeenAt: new Date(),
          lastConnectedAt: new Date()
        });
        logger.info(`User ${userId} marked as online in Firestore`);
      }
    } catch (err) {
      logger.warn(`Could not update online status in Firestore: ${err.message}`);
    }

    const userStatusObj = getUserStatus(userId);
    socket.emit('joined', {
      userId,
      userType: userType || 'unknown',
      status: userStatusObj ? userStatusObj.status : 'available',
      socketId: socket.id,
      roomName,
      success: true
    });

    logger.info(`User ${userId} (${userType || 'unknown'}) joined - Socket: ${socket.id}`);
  });

  socket.on('disconnect', async (reason) => {
    logger.info(`User disconnected: ${socket.id} - Reason: ${reason}`);

    const allUsers = getAllConnectedUsers();
    for (const [userId, user] of allUsers.entries()) {
      if (user.socketId !== socket.id) continue;

      user.isOnline = false;
      user.disconnectedAt = new Date();

      // Handle active call cleanup
      const currentStatus = getUserStatus(userId);
      if (currentStatus && currentStatus.currentCallId) {
        const callId = currentStatus.currentCallId;
        const call = getActiveCall(callId);

        if (call) {
          logger.warn(`User ${userId} disconnected during active call ${callId}`);

          // Notify other participants
          if (call.participants) {
            call.participants.forEach(pid => {
              if (pid !== userId) {
                const participant = getConnectedUser(pid);
                if (participant && participant.isOnline) {
                  io.to(participant.socketId).emit('participant_disconnected', {
                    callId,
                    disconnectedUserId: userId,
                    reason: 'User connection lost'
                  });
                }
                setUserStatus(pid, {
                  status: 'available',
                  currentCallId: null,
                  lastStatusChange: new Date()
                });
              }
            });
          }

          // Complete call with billing
          const serverTimer = getCallTimer(callId);
          if (serverTimer) {
            clearInterval(serverTimer.interval);
            const durationSeconds = serverTimer.durationSeconds || 0;
            const coinRate = serverTimer.coinRate || COIN_RATES.audio;
            const coinsDeducted = Math.ceil(durationSeconds * coinRate);

            logger.info(`Call ${callId} disconnected - Duration: ${durationSeconds}s, Cost: ${coinsDeducted} coins`);

            // Deduct coins from caller (non-blocking)
            if (call.callerId && coinsDeducted > 0) {
              try {
                const db = getFirestore();
                if (db) {
                  const userRef = db.collection('users').doc(call.callerId);
                  const userDoc = await userRef.get();
                  const data = userDoc.data() || {};
                  const currentBalance = data.coins ?? data.coinBalance ?? 0;
                  const actualDeduction = Math.min(coinsDeducted, Math.max(0, currentBalance));
                  if (actualDeduction > 0) {
                    await userRef.update({
                      coins: admin.firestore.FieldValue.increment(-actualDeduction),
                      lastSpendAt: admin.firestore.FieldValue.serverTimestamp()
                    });
                  }
                  logger.info(`Deducted ${actualDeduction} coins from ${call.callerId} for disconnected call`);
                }
              } catch (deductErr) {
                logger.error(`Failed to deduct coins on disconnect: ${deductErr.message}`);
              }
            }

            completeCall(callId, {
              status: 'disconnected',
              endReason: 'connection_lost',
              disconnectedBy: userId,
              disconnectedAt: new Date().toISOString(),
              endedAt: new Date().toISOString(),
              durationSeconds,
              coinsDeducted
            });
            deleteCallTimer(callId);
            logger.info(`Call ${callId} completed on disconnect - Firestore updated`);
          } else {
            completeCall(callId, {
              status: 'disconnected',
              endReason: 'connection_lost_before_connect',
              disconnectedBy: userId,
              disconnectedAt: new Date().toISOString(),
              endedAt: new Date().toISOString(),
              durationSeconds: 0,
              coinsDeducted: 0
            });
            logger.info(`Call ${callId} marked disconnected (no timer) - Firestore updated`);
          }
        }
      }

      // Set status to disconnected
      setUserStatus(userId, {
        status: 'disconnected',
        currentCallId: null,
        lastStatusChange: new Date()
      });

      const userType = user.userType || 'unknown';

      // Female-specific immediate updates
      if (userType === 'female') {
        logger.info(`Female user ${userId} disconnected - IMMEDIATE update`);

        // Emit to connected males for instant UI update
        io.emit('user_disconnected', {
          disconnectedUserId: userId,
          userId,
          userType: 'female',
          timestamp: new Date().toISOString(),
          reason: 'websocket_disconnect'
        });

        // Update Firestore - ONLY set isOnline=false, preserve isAvailable toggle
        try {
          const db = getFirestore();
          if (db) {
            await db.collection('users').doc(userId).update({
              isOnline: false,
              lastSeenAt: new Date(),
              disconnectedAt: new Date()
            });
            logger.info(`Female user ${userId} - isOnline set to FALSE (toggle preserved)`);

            io.emit('user_status_changed', {
              femaleUserId: userId,
              isOnline: false,
              reason: 'disconnect',
              timestamp: new Date().toISOString()
            });
          }
        } catch (firestoreError) {
          logger.error(`Failed to update Firestore for female ${userId}:`, firestoreError.message);
        }
      }

      // Start disconnect timeout (backup mechanism)
      startDisconnectTimeout(userId, userType, io);
      logger.info(`User ${userId} (${userType}) disconnected - Started ${15}s timeout`);
      break;
    }
  });
}
