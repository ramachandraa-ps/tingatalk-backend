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
  confirmBackgrounded,
  wasRecentlyBroadcastOffline, clearRecentOfflineBroadcast
} from '../state/connectionManager.js';

// In-memory dedup for rapid duplicate join requests from buggy frontends.
// When the Flutter app fires 8 join events in 1ms (multiple lifecycle observers
// + WebSocketService races), we process the first and silently ack the rest.
const recentJoinsByUser = new Map(); // userId -> timestamp
const JOIN_DEDUP_WINDOW_MS = 1000;
import { performCallBilling } from '../../utils/callBillingUtil.js';

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

    // Dedup rapid duplicate joins from same user within 1s.
    // Why: Flutter app's lifecycle observers race and emit join 6-8 times per resume,
    // each one cascading into Firestore writes + male broadcasts. First one wins,
    // duplicates get a clean ack but skip the rest of the work.
    const lastJoinTs = recentJoinsByUser.get(userId);
    const nowMs = Date.now();
    if (lastJoinTs && (nowMs - lastJoinTs) < JOIN_DEDUP_WINDOW_MS) {
      socket.emit('joined', {
        userId,
        userType: userType || 'unknown',
        socketId: socket.id,
        roomName: `user_${userId}`,
        success: true,
        deduped: true,
      });
      // Still ensure THIS socket joins the user-specific room (each socket needs it
      // for direct events even though backend state was already updated by the first join)
      socket.join(`user_${userId}`);
      if (userType === 'male') socket.join('room_male_browse');
      return;
    }
    recentJoinsByUser.set(userId, nowMs);

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

    // BUSY-STATE RECOVERY: defense in depth against the disconnect-handler bug
    // where a transient socket flap could wipe userStatus mid-call. Before
    // resetting status from Firestore preference, check if there's still an
    // active call where this user is a participant. If yes, restore busy
    // state — Twilio is still connected on this user's device, and the call
    // shouldn't be considered ended just because the websocket flapped.
    let restoredFromActiveCall = false;
    const activeCalls = getAllActiveCalls();
    for (const [activeCallId, activeCall] of activeCalls.entries()) {
      if (activeCall.status === 'completed') continue;
      const isParticipant = activeCall.callerId === userId ||
                            activeCall.recipientId === userId ||
                            (Array.isArray(activeCall.participants) && activeCall.participants.includes(userId));
      if (isParticipant) {
        setUserStatus(userId, {
          status: 'busy',
          currentCallId: activeCallId,
          lastStatusChange: new Date(),
          userPreference: currentStatus ? currentStatus.userPreference : true
        });
        logger.info(`User ${userId} reconnected mid-call ${activeCallId} — restoring status=busy (BUSY-STATE RECOVERY)`);
        restoredFromActiveCall = true;
        break;
      }
    }

    if (!restoredFromActiveCall) {
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

      // Recovery event — fires only if we ACTUALLY sent an offline broadcast
      // for this female recently. The bypassDedup flag tells the male frontend
      // to skip its timestamp-based dedup so this auto-recovery is not dropped
      // alongside the older offline event.
      if (userType === 'female' && wasRecentlyBroadcastOffline(userId)) {
        io.to('room_male_browse').emit('availability_recovered', {
          femaleUserId: userId,
          isAvailable: true,
          isOnline: true,
          reason: 'female_reconnected_after_offline_broadcast',
          bypassDedup: true,
          timestamp: new Date().toISOString()
        });
        clearRecentOfflineBroadcast(userId);
        logger.info(`Sent availability_recovered for ${userId} (auto-corrects male UIs)`);
      }
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

      // ===== ACTIVE CALL HANDLING =====
      // Critical bug fix: previously, the moment EITHER party's socket dropped,
      // we would immediately mark the call as completed, run billing, wipe
      // userStatus, and clear currentCallId. This caused a race condition where
      // a female whose socket flapped mid-call (Android doze, network handoff —
      // happens every ~21s in production logs for heavy users) would have her
      // status reset to 'available' a few seconds later by the join handler,
      // even though Twilio was still actively connected on her device.
      // Result: a SECOND male could call her and the busy check would let it
      // through.
      //
      // New behavior: if the user has an active call (currentCallId set), do
      // NOT terminate the call immediately. Just mark them offline and let
      // the 15s startDisconnectTimeout decide:
      //   - If they reconnect within 15s → cancelDisconnectTimeout fires →
      //     call continues seamlessly, status stays 'busy'.
      //   - If they don't reconnect → the timeout callback runs the same
      //     cleanup logic that used to be inline here.
      //
      // The cleanup logic itself is preserved verbatim (billing, female
      // earnings, call logs, completeCall, participant notifications) — just
      // moved from "fire on socket drop" to "fire after 15s grace window
      // expires without reconnect".
      const currentStatus = getUserStatus(userId);
      const userType = user.userType || 'unknown';
      const hasActiveCall = currentStatus && currentStatus.currentCallId &&
                            getActiveCall(currentStatus.currentCallId);

      if (hasActiveCall) {
        // PRESERVE userStatus and currentCallId. Defer call termination to
        // the 15s startDisconnectTimeout. This prevents the mid-flap busy
        // bypass without breaking real call termination — the timeout still
        // fires reliably for actual force-closes.
        logger.warn(`User ${userId} disconnected during active call ${currentStatus.currentCallId} — DEFERRING call cleanup to 15s timeout (preserves busy state during socket flap)`);
      } else {
        // No active call — safe to immediately mark status as disconnected.
        // This is the original behavior for users who weren't in a call.
        setUserStatus(userId, {
          status: 'disconnected',
          currentCallId: null,
          lastStatusChange: new Date()
        });
      }

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

      // Start disconnect timeout. If user has an active call, pass a deferred
      // cleanup callback that will run AFTER the 15s grace window if they
      // didn't reconnect. This is the path that actually terminates the call —
      // billing, female earnings, call logs, completeCall, participant
      // notifications. Same logic as the old immediate-on-disconnect path,
      // just gated by the grace window.
      const deferredCleanup = hasActiveCall
        ? buildDeferredCallCleanup(io, userId, currentStatus.currentCallId)
        : null;
      startDisconnectTimeout(userId, userType, io, deferredCleanup);
      logger.info(`User ${userId} (${userType}) disconnected - Started ${15}s timeout${hasActiveCall ? ' (with deferred call cleanup)' : ''}`);
      break;
    }
  });
}

/**
 * Build the deferred call-cleanup function that fires after the 15s
 * disconnect grace window if the user hasn't reconnected. This is the
 * same end-of-call billing pipeline that used to run immediately on socket
 * disconnect — just delayed so transient mobile-network flaps don't
 * terminate live calls.
 */
function buildDeferredCallCleanup(io, userId, callId) {
  return async () => {
    const call = getActiveCall(callId);
    if (!call) {
      logger.info(`Deferred cleanup for ${callId}: call already gone (cleaned by other path) — skipping`);
      return;
    }
    if (call.status === 'completed') {
      logger.info(`Deferred cleanup for ${callId}: call already completed — skipping`);
      return;
    }

    logger.warn(`Deferred call cleanup firing for ${callId} (user ${userId} did not reconnect within 15s grace)`);

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
      logger.info(`Call ${callId} disconnected after grace window - Duration: ${durationSeconds}s`);

      // Delegate billing to single source of truth.
      // CHANGED FROM PRIOR BEHAVIOR: female now earns for the FULL call duration
      // instead of only the duration covered by the male's wallet (which was
      // creating talk-time discrepancies between disconnect-recovery calls and
      // normal-completion calls). Male is still capped by the balance guard
      // inside performCallBilling — any uncharged delta is platform loss,
      // matching how server_auto_end already worked.
      const db = getFirestore();
      if (db) {
        try {
          await performCallBilling({
            callId,
            timer: {
              ...serverTimer,
              callerId: call.callerId || serverTimer.callerId,
              recipientId: call.recipientId || serverTimer.recipientId,
              callType: serverTimer.callType || call.callType || 'audio',
              callerName: serverTimer.callerName || call.callerName,
            },
            endReason: 'connection_lost',
            source: 'disconnect_recovery',
            db,
            io,
            endedBy: userId,
          });
        } catch (billErr) {
          logger.error(`performCallBilling failed in disconnect-recovery for ${callId}: ${billErr.message}`);
        }
      }

      // Mark in-memory state and clean up
      call.status = 'completed';
      // completeCall removes from activeCalls map (Firestore was already updated by performCallBilling).
      // Pass minimal updates here — performCallBilling already wrote durationSeconds/coinsDeducted/status.
      completeCall(callId, {
        // Don't overwrite the fields performCallBilling already set — pass only audit-extras
        disconnectedBy: userId,
        disconnectedAt: new Date().toISOString(),
      });
      deleteCallTimer(callId);
      logger.info(`Call ${callId} completed on disconnect - Firestore updated via performCallBilling`);
    } else {
      // No timer means the call was still in pre-accept state (ringing).
      // Nothing to bill — just mark Firestore + clean in-memory state.
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

    // Now that call is fully cleaned up, finalize disconnected user's status
    setUserStatus(userId, {
      status: 'disconnected',
      currentCallId: null,
      lastStatusChange: new Date()
    });
  };
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
