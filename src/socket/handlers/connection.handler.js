import { logger } from '../../utils/logger.js';
import { getFirestore, admin } from '../../config/firebase.js';
import {
  setConnectedUser, getConnectedUser, getAllConnectedUsers,
  setUserStatus, getUserStatus,
  getActiveCall, getAllActiveCalls,
  getCallTimer, deleteCallTimer, getAllCallTimers,
  startDisconnectTimeout, cancelDisconnectTimeout,
  completeCall, setCallTimer,
  forceSetUnavailable,
  confirmBackgrounded
} from '../state/connectionManager.js';
import { COIN_RATES, FEMALE_EARNING_RATES } from '../../shared/constants.js';
import { updateCallLogs } from '../../utils/callLogUtil.js';

export function registerConnectionHandlers(io, socket) {

  // Handle force-close signal from Flutter _handleDetached()
  socket.on('set_unavailable', async (data) => {
    const userId = data?.userId || data?.user_id;
    if (!userId) return;

    logger.info(`Force-close signal received for ${userId} (reason: ${data?.reason || 'unknown'})`);
    await forceSetUnavailable(userId, io);
  });

  // Handle availability heartbeat response from backgrounded female app
  socket.on('availability_heartbeat', (data) => {
    const userId = data?.userId || data?.user_id;
    if (!userId) return;
    logger.info(`Availability heartbeat received from ${userId} (app is backgrounded, not force-closed)`);
    confirmBackgrounded(userId);
  });

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
        // Flag old socket so its disconnect event skips full cleanup
        oldSocket._replacedByNewConnection = true;
        oldSocket.leave(`user_${userId}`);
        oldSocket.disconnect(true);
        logger.info(`Disconnected old socket: ${existingUser.socketId} (flagged as replaced)`);
      }
    }

    // Store connection
    setConnectedUser(userId, {
      socketId: socket.id,
      userType: userType || 'unknown',
      connectedAt: new Date(),
      isOnline: true
    });

    // Fix 5: Orphan timer cleanup — if user is reconnecting and has any timers
    // for calls they're no longer in (status not busy), delete those orphan timers
    try {
      const userStatus = getUserStatus(userId);
      const userIsInActiveCall = userStatus && userStatus.status === 'busy' && userStatus.currentCallId;
      const allTimers = getAllCallTimers();
      for (const [timerCallId, timerData] of allTimers.entries()) {
        const isUserCaller = timerData.callerId === userId;
        const isUserRecipient = timerData.recipientId === userId;
        if (!isUserCaller && !isUserRecipient) continue;

        // If user is not in this specific call, the timer is an orphan
        if (!userIsInActiveCall || userStatus.currentCallId !== timerCallId) {
          if (timerData.interval) clearInterval(timerData.interval);
          deleteCallTimer(timerCallId);
          logger.info(`Orphan timer cleaned for ${userId} on reconnect: ${timerCallId}`);
        }
      }
    } catch (orphanErr) {
      logger.warn(`Orphan timer cleanup error for ${userId}: ${orphanErr.message}`);
    }

    // Set user status from Firestore preference
    // Read availabilityPreference (user's toggle choice) — NOT isAvailable (system-managed)
    const currentStatus = getUserStatus(userId);
    if (!currentStatus || currentStatus.status === 'unavailable' || currentStatus.status === 'disconnected') {
      let savedPreference = true;
      try {
        const db = getFirestore();
        if (db) {
          const userDoc = await db.collection('users').doc(userId).get();
          if (userDoc.exists) {
            const userData = userDoc.data();
            // Use availabilityPreference (user's toggle) — fallback to isAvailable for old users
            savedPreference = userData.availabilityPreference !== undefined
              ? userData.availabilityPreference !== false
              : userData.isAvailable !== false;
            logger.info(`Loaded availability preference for ${userId}: ${savedPreference} (from ${userData.availabilityPreference !== undefined ? 'availabilityPreference' : 'isAvailable'})`);
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

    // Males join browse room for scoped availability broadcasts
    if (userType === 'male') {
      socket.join('room_male_browse');
    }

    // Update Firestore online status + restore isAvailable from preference
    const userPref = getUserStatus(userId);
    const restoreAvailable = userPref && userPref.userPreference === true;
    try {
      const db = getFirestore();
      if (db) {
        const updateData = {
          isOnline: true,
          lastSeenAt: new Date(),
          lastConnectedAt: new Date()
        };
        // Restore isAvailable to match user's toggle preference
        if (restoreAvailable) {
          updateData.isAvailable = true;
          logger.info(`User ${userId} - restoring isAvailable=true from preference`);
        }
        await db.collection('users').doc(userId).update(updateData);
        logger.info(`User ${userId} marked as online in Firestore`);
      }
    } catch (err) {
      logger.warn(`Could not update online status in Firestore: ${err.message}`);
    }

    // Broadcast availability to males browsing (so male browse + favorites update)
    const userStatusObj = getUserStatus(userId);
    if (userType === 'female' || (userStatusObj && userStatusObj.userPreference === true)) {
      io.to('room_male_browse').emit('availability_changed', {
        femaleUserId: userId,
        isAvailable: userStatusObj ? userStatusObj.status === 'available' : true,
        isOnline: true,
        reason: 'user_connected',
        timestamp: new Date().toISOString()
      });
    }

    socket.emit('joined', {
      userId,
      userType: userType || 'unknown',
      status: userStatusObj ? userStatusObj.status : 'available',
      socketId: socket.id,
      roomName,
      success: true
    });

    logger.info(`User ${userId} (${userType || 'unknown'}) joined - Socket: ${socket.id}`);

    // Push availability snapshot so male UI converges immediately on (re)connect.
    // Why: real-time `availability_changed` events are not replayed; if the male
    // missed events while paused, his cards stay stale until the next event.
    // The snapshot is the ground-truth fallback that makes the UI self-healing.
    if (userType === 'male') {
      sendAvailabilitySnapshot(io, socket, userId).catch(err => {
        logger.warn(`availability_snapshot failed for ${userId}: ${err.message}`);
      });
    }
  });

  socket.on('disconnect', async (reason) => {
    // Skip full cleanup if this socket was replaced by a new connection from same user
    if (socket._replacedByNewConnection) {
      logger.info(`Skipping disconnect cleanup for replaced socket: ${socket.id} - Reason: ${reason}`);
      return;
    }

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

        if (call && call.status === 'completed') {
          logger.info(`Call ${callId} already completed — skipping disconnect billing`);
        } else if (call) {
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
                  const currentBalance = data.coins ?? 0;
                  const actualDeduction = Math.min(coinsDeducted, Math.max(0, currentBalance));
                  if (actualDeduction > 0) {
                    await userRef.update({
                      coins: admin.firestore.FieldValue.increment(-actualDeduction),
                      lastSpendAt: admin.firestore.FieldValue.serverTimestamp()
                    });
                  }
                  logger.info(`Deducted ${actualDeduction} coins from ${call.callerId} for disconnected call`);

                  // Fix 4: symmetric billing — calculate actual billed seconds based on what was charged
                  let billedSeconds = durationSeconds;
                  if (actualDeduction < coinsDeducted && coinRate > 0) {
                    billedSeconds = Math.floor(actualDeduction / coinRate);
                  }

                  // Record female earnings for disconnect-ended calls (based on actual billed seconds)
                  const recipientId = call.recipientId || serverTimer.recipientId;
                  if (recipientId && billedSeconds > 0) {
                    try {
                      const callType = serverTimer.callType || call.callType || 'audio';
                      const earningRate = callType === 'video' ? FEMALE_EARNING_RATES.video : FEMALE_EARNING_RATES.audio;
                      const earningAmount = parseFloat((billedSeconds * earningRate).toFixed(2));
                      const dateKey = new Date().toISOString().split('T')[0];
                      const femaleEarningsRef = db.collection('female_earnings').doc(recipientId);

                      await femaleEarningsRef.set({
                        totalEarnings: admin.firestore.FieldValue.increment(earningAmount),
                        availableBalance: admin.firestore.FieldValue.increment(earningAmount),
                        totalCalls: admin.firestore.FieldValue.increment(1),
                        totalDurationSeconds: admin.firestore.FieldValue.increment(billedSeconds),
                        lastCallAt: admin.firestore.FieldValue.serverTimestamp(),
                        lastUpdated: admin.firestore.FieldValue.serverTimestamp()
                      }, { merge: true });

                      await femaleEarningsRef.collection('daily').doc(dateKey).set({
                        date: dateKey,
                        earnings: admin.firestore.FieldValue.increment(earningAmount),
                        calls: admin.firestore.FieldValue.increment(1),
                        durationSeconds: admin.firestore.FieldValue.increment(billedSeconds),
                        lastUpdated: admin.firestore.FieldValue.serverTimestamp()
                      }, { merge: true });

                      await femaleEarningsRef.collection('transactions').doc(callId).set({
                        type: 'call_earning',
                        callId,
                        callerId: call.callerId,
                        callType,
                        durationSeconds: billedSeconds,
                        amount: earningAmount,
                        currency: 'INR',
                        ratePerSecond: earningRate,
                        completedAt: new Date().toISOString(),
                        createdAt: admin.firestore.FieldValue.serverTimestamp(),
                        status: 'completed',
                        source: 'disconnect_recovery'
                      });

                      logger.info(`Female earnings recorded for disconnect call ${callId}: ₹${earningAmount} (based on ${billedSeconds}s actual billed) to ${recipientId}`);
                    } catch (earningsErr) {
                      logger.error(`Failed to record female earnings on disconnect: ${earningsErr.message}`);
                    }
                  }

                  // Update call logs for both users
                  await updateCallLogs({
                    callId,
                    callerId: call.callerId,
                    recipientId,
                    callType: serverTimer.callType || call.callType || 'audio',
                    durationSeconds: billedSeconds,
                    coinsDeducted: actualDeduction,
                    status: 'completed',
                    endReason: 'connection_lost',
                    source: 'disconnect_recovery',
                  });
                }
              } catch (deductErr) {
                logger.error(`Failed to deduct coins on disconnect: ${deductErr.message}`);
              }
            }

            // Mark call as completed before completeCall to prevent re-entry
            call.status = 'completed';

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
            call.status = 'completed';

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

      // Female-specific updates — defer Firestore write to the 15s disconnect timeout
      // This prevents flapping (rapid online/offline) during brief reconnections
      if (userType === 'female') {
        logger.info(`Female user ${userId} disconnected - deferring offline status to 15s timeout`);

        // Emit to connected males for instant UI update (in-memory only, no Firestore)
        io.emit('user_disconnected', {
          disconnectedUserId: userId,
          userId,
          userType: 'female',
          timestamp: new Date().toISOString(),
          reason: 'websocket_disconnect'
        });
      }

      // Start disconnect timeout (backup mechanism)
      startDisconnectTimeout(userId, userType, io);
      logger.info(`User ${userId} (${userType}) disconnected - Started ${15}s timeout`);
      break;
    }
  });
}

/**
 * Push current available-female state to a male socket on (re)connect.
 * Mirrors the filter logic of GET /api/get_available_females so the
 * push-based real-time stream can self-heal after missed events.
 */
async function sendAvailabilitySnapshot(io, socket, maleUserId) {
  const db = getFirestore();
  if (!db) return;

  const femalesSnapshot = await db.collection('users')
    .where('gender', '==', 'female')
    .where('isVerified', '==', true)
    .where('isAvailable', '==', true)
    .get();

  const females = [];
  for (const doc of femalesSnapshot.docs) {
    const userData = doc.data();
    const userId = doc.id;
    if (userData.isAvailable !== true) continue;

    const userConnection = getConnectedUser(userId);
    const hasActiveConnection = userConnection && userConnection.isOnline;
    let isSocketConnected = false;
    if (hasActiveConnection) {
      const userSocket = io.sockets.sockets.get(userConnection.socketId);
      isSocketConnected = userSocket && userSocket.connected;
    }
    const hasFcmToken = !!(userData.fcmToken && typeof userData.fcmToken === 'string' && userData.fcmToken.length > 0);
    if (!isSocketConnected && !hasFcmToken) continue;

    const userStatusData = getUserStatus(userId);
    const isBusy = userStatusData && userStatusData.status === 'busy';

    females.push({
      femaleUserId: userId,
      isAvailable: true,
      isOnline: isSocketConnected,
      reachability: isSocketConnected ? 'websocket' : 'fcm_only',
      status: isBusy ? 'busy' : 'available'
    });
  }

  socket.emit('availability_snapshot', {
    females,
    count: females.length,
    timestamp: new Date().toISOString()
  });
  logger.info(`Sent availability_snapshot to male ${maleUserId}: ${females.length} available females`);
}
