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
import { COIN_RATES, FEMALE_EARNING_RATES, PRE_ACCEPT_CALL_STATUSES, ENDED_CALL_STATUSES, DISCONNECT_TIMEOUT_MS } from '../../shared/constants.js';
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

        // GRACE PERIOD FOR PRE-ACCEPT DISCONNECTS
        // If a participant's socket drops while the call is still in setup phase
        // (initiated/ringing/pending_fcm/ringing_fcm) — do NOT instantly kill the call.
        // Android backgrounding + reconnect storms were causing brief socket drops that
        // killed calls before the recipient could tap Accept (see log forensics 2026-04-23:
        // 169/201 male→female calls failed this way, 84% failure rate).
        //
        // Schedule cleanup after DISCONNECT_TIMEOUT_MS. If the user reconnects and the
        // call transitions to 'accepted'/'active' within that window, the deferred
        // cleanup is a no-op. Existing billing/cleanup logic for mid-call disconnect
        // (call.status === 'accepted'/'active') is unchanged.
        if (call && PRE_ACCEPT_CALL_STATUSES.includes(call.status)) {
          // Debounce: if a prior grace timer exists for this call (e.g. same user
          // disconnected twice in quick succession during a reconnect storm), cancel it
          // and schedule fresh. Prevents duplicate work and redundant log lines.
          if (call._graceTimer) {
            clearTimeout(call._graceTimer);
            logger.debug(`Grace period: cleared stale grace timer for call ${callId}`);
          }

          logger.info(`Grace period: call ${callId} in pre-accept state '${call.status}' — deferring cleanup ${DISCONNECT_TIMEOUT_MS / 1000}s for potential reconnect from ${userId}`);

          call._graceTimer = setTimeout(() => {
            const laterCall = getActiveCall(callId);
            if (!laterCall) {
              logger.debug(`Grace period: call ${callId} already removed — no cleanup needed`);
              return;
            }
            // Clear our stored handle on the call object now that we're firing
            laterCall._graceTimer = null;

            if (laterCall.status === 'accepted' || laterCall.status === 'active') {
              logger.debug(`Grace period: call ${callId} was accepted during grace window — cleanup skipped`);
              return;
            }
            if (ENDED_CALL_STATUSES.includes(laterCall.status) || laterCall.status === 'completed' || laterCall.status === 'missed') {
              logger.debug(`Grace period: call ${callId} already terminated (status='${laterCall.status}') — cleanup skipped`);
              return;
            }
            // Call is STILL in pre-accept state after grace window — treat as genuine abandon.
            // Mark as missed so caller-side UI gets the usual timeout/missed experience.
            logger.warn(`Grace period expired: call ${callId} still '${laterCall.status}' after ${DISCONNECT_TIMEOUT_MS / 1000}s — completing as missed`);
            laterCall.status = 'missed';

            // Notify caller that the call ended (idempotent on caller UI — caller may
            // have already fired cancel_call but end-event handlers are expected to be
            // idempotent on terminal states).
            const callerConn = getConnectedUser(laterCall.callerId);
            if (callerConn && callerConn.isOnline) {
              io.to(callerConn.socketId).emit('call_timeout', {
                callId,
                reason: 'recipient_disconnected',
                endedAt: new Date().toISOString()
              });
            }

            // Status reset: ONLY reset user statuses to 'available' if the user is
            // actually still online. If they're offline, let the user-presence cleanup
            // (startDisconnectTimeout below) own their state so we don't overwrite
            // 'disconnected' with 'available' for a user whose socket is dead.
            const callerOnline = !!getConnectedUser(laterCall.callerId)?.isOnline;
            const recipientOnline = !!getConnectedUser(laterCall.recipientId)?.isOnline;
            if (callerOnline) {
              setUserStatus(laterCall.callerId, { status: 'available', currentCallId: null, lastStatusChange: new Date() });
            }
            if (recipientOnline) {
              setUserStatus(laterCall.recipientId, { status: 'available', currentCallId: null, lastStatusChange: new Date() });
            }

            // Complete call record (no billing — call was never accepted)
            completeCall(callId, {
              status: 'missed',
              endReason: 'recipient_disconnected_before_accept',
              disconnectedBy: userId,
              disconnectedAt: new Date().toISOString(),
              endedAt: new Date().toISOString(),
              durationSeconds: 0,
              coinsDeducted: 0
            });
          }, DISCONNECT_TIMEOUT_MS);

          // IMPORTANT: skip the rest of the in-call cleanup for this call.
          // The user-level cleanup (setUserStatus disconnected, startDisconnectTimeout)
          // below still runs — that's about user presence, not call state.
        }
        else if (call && (call.status === 'completed' || ENDED_CALL_STATUSES.includes(call.status))) {
          // Call already terminated by another path (cancelled/ended/declined/timeout/missed/completed)
          // — skip disconnect billing, just let user-level cleanup below run.
          logger.debug(`Call ${callId} already in terminal state '${call.status}' — skipping disconnect billing`);
        } else if (call) {
          // Call is in accepted/active/disconnected/failed — run the full billing cleanup path.
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
