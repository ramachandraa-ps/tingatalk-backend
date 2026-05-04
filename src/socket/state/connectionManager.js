import { logger } from '../../utils/logger.js';
import { getRedis } from '../../config/redis.js';
import { getFirestore, admin } from '../../config/firebase.js';
import { DISCONNECT_TIMEOUT_MS, AVAILABILITY_TIMEOUT_MS, FCM_PING_TIMEOUT_MS } from '../../shared/constants.js';
import { getMessaging } from '../../config/firebase.js';

// In-memory state (synced to Redis non-blocking)
const connectedUsers = new Map();
const userStatus = new Map();
const activeCalls = new Map();
const callTimers = new Map();
const disconnectTimeouts = new Map();
const availabilityTimeouts = new Map();
const fcmPingTimeouts = new Map();         // Tier 1.5: FCM ping response tracking
const confirmedBackgrounded = new Set();   // Users who responded to FCM ping (confirmed alive)
const offlineBroadcastTimeouts = new Map(); // Grace-window timers before notifying males of female offline
const recentOfflineBroadcasts = new Map();  // userId -> timestamp of last actual offline broadcast (for recovery event)

// Grace period after Tier 1 fires before we actually tell males "she's offline".
// Prevents card flicker during normal mobile network jitter (8-30s drops).
// If she reconnects within this window, no males ever see the offline event.
const OFFLINE_BROADCAST_GRACE_MS = 30000;

// --- Connected Users ---
export function setConnectedUser(userId, userData) {
  connectedUsers.set(userId, userData);
  const redis = getRedis();
  if (redis) {
    redis.hset('connected_users', userId, JSON.stringify(userData)).catch(err =>
      logger.error(`Error syncing connected user to Redis: ${err.message}`)
    );
  }
}

export function getConnectedUser(userId) {
  return connectedUsers.get(userId);
}

export function deleteConnectedUser(userId) {
  connectedUsers.delete(userId);
  const redis = getRedis();
  if (redis) {
    redis.hdel('connected_users', userId).catch(err =>
      logger.error(`Error deleting connected user from Redis: ${err.message}`)
    );
  }
}

export function getAllConnectedUsers() {
  return connectedUsers;
}

// --- User Status ---
export function setUserStatus(userId, status) {
  userStatus.set(userId, status);
  const redis = getRedis();
  if (redis) {
    redis.hset('user_status', userId, JSON.stringify(status)).catch(err =>
      logger.error(`Error syncing user status to Redis: ${err.message}`)
    );
  }
}

export function getUserStatus(userId) {
  return userStatus.get(userId);
}

export function deleteUserStatus(userId) {
  userStatus.delete(userId);
  const redis = getRedis();
  if (redis) {
    redis.hdel('user_status', userId).catch(err =>
      logger.error(`Error deleting user status from Redis: ${err.message}`)
    );
  }
}

export function getAllUserStatuses() {
  return userStatus;
}

// --- Active Calls ---
export function setActiveCall(callId, callData) {
  activeCalls.set(callId, callData);
  const redis = getRedis();
  if (redis) {
    redis.hset('active_calls', callId, JSON.stringify(callData)).catch(err =>
      logger.error(`Error syncing call to Redis: ${err.message}`)
    );
  }
  // Also save to Firestore
  const db = getFirestore();
  if (db) {
    const firestoreData = {
      callId: callData.callId,
      callerId: callData.callerId,
      recipientId: callData.recipientId,
      callType: callData.callType,
      roomName: callData.roomName || '',
      status: callData.status || 'initiated',
      coinRatePerSecond: callData.coinRate || 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      durationSeconds: callData.durationSeconds || 0,
      coinsDeducted: callData.coinsDeducted || 0
    };
    db.collection('calls').doc(callId).set(firestoreData, { merge: true }).catch(err =>
      logger.error(`Error saving call to Firestore: ${err.message}`)
    );
  }
}

export function getActiveCall(callId) {
  return activeCalls.get(callId);
}

export function deleteActiveCall(callId) {
  activeCalls.delete(callId);
  const redis = getRedis();
  if (redis) {
    redis.hdel('active_calls', callId).catch(err =>
      logger.error(`Error deleting call from Redis: ${err.message}`)
    );
  }
}

export function getAllActiveCalls() {
  return activeCalls;
}

export function completeCall(callId, updates) {
  deleteActiveCall(callId);
  const db = getFirestore();
  if (db) {
    const updateData = {
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    if (updates.durationSeconds !== undefined) updateData.durationSeconds = updates.durationSeconds;
    if (updates.coinsDeducted !== undefined) updateData.coinsDeducted = updates.coinsDeducted;
    if (updates.status !== undefined) updateData.status = updates.status;
    if (updates.endedAt !== undefined) updateData.endedAt = admin.firestore.Timestamp.fromDate(new Date(updates.endedAt));
    if (updates.endReason !== undefined) updateData.endReason = updates.endReason;
    // Copy over any additional fields
    for (const key of Object.keys(updates)) {
      if (!(key in updateData)) {
        updateData[key] = updates[key];
      }
    }
    db.collection('calls').doc(callId).update(updateData).catch(err =>
      logger.error(`Error updating call in Firestore: ${err.message}`)
    );
  }
}

// --- Call Timers ---
export function setCallTimer(callId, timerData) {
  callTimers.set(callId, timerData);
}

export function getCallTimer(callId) {
  return callTimers.get(callId);
}

export function deleteCallTimer(callId) {
  const timer = callTimers.get(callId);
  if (timer && timer.interval) {
    clearInterval(timer.interval);
  }
  callTimers.delete(callId);
}

export function getAllCallTimers() {
  return callTimers;
}

// --- Disconnect Timeouts ---
export function startDisconnectTimeout(userId, userType, io) {
  cancelDisconnectTimeout(userId);

  logger.info(`Starting disconnect timeout for ${userId} (${userType || 'unknown'}) - ${DISCONNECT_TIMEOUT_MS / 1000}s`);

  const timeoutId = setTimeout(async () => {
    const userConnection = connectedUsers.get(userId);
    if (userConnection && userConnection.isOnline) {
      logger.info(`User ${userId} has reconnected - NOT marking as unavailable`);
      disconnectTimeouts.delete(userId);
      return;
    }

    try {
      const db = getFirestore();
      if (db) {
        if (userType === 'female') {
          // Tier 1: ONLY set isOnline=false. NEVER touch isAvailable here.
          // Female stays FCM-reachable for calls while backgrounded.
          // isAvailable is ONLY changed by: manual toggle, logout, force-close signal, or Tier 2 safety net.
          await db.collection('users').doc(userId).update({
            isOnline: false,
            lastSeenAt: new Date(),
            disconnectedAt: new Date()
          });
          logger.info(`Female user ${userId} - Tier 1: isOnline=false (isAvailable preserved, FCM-reachable)`);

          // Defer the male-facing broadcast by OFFLINE_BROADCAST_GRACE_MS.
          // Why: female sockets routinely flap for 8-30s on mobile networks (Android doze,
          // network handoffs, app backgrounding). Broadcasting "she's offline" immediately
          // causes male card flicker / removal. If she reconnects within the grace window,
          // we cancel the broadcast — males never see her go offline at all.
          _scheduleOfflineBroadcast(userId, io);

          // Start Tier 1.5: Send FCM ping to detect force-close vs background
          _startFcmPingCheck(userId, io);
        } else {
          await db.collection('users').doc(userId).update({
            isOnline: false,
            lastSeenAt: new Date(),
            disconnectedAt: new Date()
          });

          io.emit('user_status_changed', {
            userId,
            isOnline: false,
            reason: 'disconnect_timeout',
            timestamp: new Date().toISOString()
          });
        }
      }
    } catch (error) {
      logger.error(`Error updating Firestore for ${userId} disconnect timeout:`, error.message);
    }

    disconnectTimeouts.delete(userId);
  }, DISCONNECT_TIMEOUT_MS);

  disconnectTimeouts.set(userId, {
    timeoutId,
    disconnectedAt: new Date(),
    userType: userType || 'unknown'
  });
}

export function cancelDisconnectTimeout(userId) {
  const existing = disconnectTimeouts.get(userId);
  if (existing) {
    clearTimeout(existing.timeoutId);
    disconnectTimeouts.delete(userId);
    logger.info(`Cancelled disconnect timeout for ${userId} (reconnected)`);
  }
  _cancelFcmPingCheck(userId);
  _cancelAvailabilityTimeout(userId);
  _cancelOfflineBroadcast(userId);
}

// Schedule a deferred "she went offline" broadcast to males (Tier 1 grace window).
// If user reconnects before this fires, _cancelOfflineBroadcast() short-circuits it.
function _scheduleOfflineBroadcast(userId, io) {
  _cancelOfflineBroadcast(userId);
  const timeoutId = setTimeout(() => {
    // Re-check connection state before broadcasting — they may have come back
    const conn = connectedUsers.get(userId);
    if (conn && conn.isOnline) {
      logger.info(`Suppressing offline broadcast for ${userId} — already reconnected`);
      offlineBroadcastTimeouts.delete(userId);
      return;
    }
    io.to('room_male_browse').emit('availability_changed', {
      femaleUserId: userId,
      isAvailable: true,
      isOnline: false,
      reason: 'disconnect_timeout',
      timestamp: new Date().toISOString()
    });
    recentOfflineBroadcasts.set(userId, Date.now());
    logger.info(`Tier 1 offline broadcast SENT for ${userId} (after ${OFFLINE_BROADCAST_GRACE_MS / 1000}s grace)`);
    offlineBroadcastTimeouts.delete(userId);
  }, OFFLINE_BROADCAST_GRACE_MS);
  offlineBroadcastTimeouts.set(userId, timeoutId);
  logger.info(`Tier 1 offline broadcast DEFERRED for ${userId} (${OFFLINE_BROADCAST_GRACE_MS / 1000}s grace window)`);
}

function _cancelOfflineBroadcast(userId) {
  const timeoutId = offlineBroadcastTimeouts.get(userId);
  if (timeoutId) {
    clearTimeout(timeoutId);
    offlineBroadcastTimeouts.delete(userId);
    logger.info(`Tier 1 offline broadcast CANCELLED for ${userId} (reconnect within grace window)`);
  }
}

// Returns true if an offline broadcast was actually sent recently (within last 60s)
// Used by join handler to decide if a recovery event is needed for male UIs
export function wasRecentlyBroadcastOffline(userId) {
  const ts = recentOfflineBroadcasts.get(userId);
  if (!ts) return false;
  if (Date.now() - ts > 60000) {
    recentOfflineBroadcasts.delete(userId);
    return false;
  }
  return true;
}

export function clearRecentOfflineBroadcast(userId) {
  recentOfflineBroadcasts.delete(userId);
}

// --- Tier 1.5: Double FCM Ping to detect force-close vs background ---
// Why double ping: Android keeps the background isolate alive briefly after force-close,
// so a single ping always gets a response. A second ping 30s later catches the dead process.
async function _startFcmPingCheck(userId, io) {
  _cancelFcmPingCheck(userId);
  confirmedBackgrounded.delete(userId);

  const fcmToken = await _getUserFcmToken(userId);
  if (!fcmToken) {
    logger.warn(`No FCM token for ${userId} — treating as force-close`);
    await _forceUnavailableOnPingTimeout(userId, io);
    return;
  }

  // Send first ping
  logger.info(`Tier 1.5: Sending FIRST FCM ping to ${userId}`);
  const sent = await _sendFcmPing(userId, fcmToken, 'ping_1');
  if (!sent) {
    await _forceUnavailableOnPingTimeout(userId, io);
    return;
  }

  // After 30 seconds, send second verification ping
  const timeoutId = setTimeout(async () => {
    const userConnection = connectedUsers.get(userId);
    if (userConnection && userConnection.isOnline) {
      logger.info(`User ${userId} reconnected — skipping second ping`);
      fcmPingTimeouts.delete(userId);
      return;
    }

    // Reset confirmation flag before second ping
    confirmedBackgrounded.delete(userId);
    logger.info(`Tier 1.5: Sending SECOND verification FCM ping to ${userId}`);
    const sent2 = await _sendFcmPing(userId, fcmToken, 'ping_2');

    if (!sent2) {
      logger.info(`Tier 1.5: Second ping failed to send — force-close detected`);
      await _forceUnavailableOnPingTimeout(userId, io);
      fcmPingTimeouts.delete(userId);
      return;
    }

    // Wait 30s more for second response
    const secondTimeoutId = setTimeout(async () => {
      const conn = connectedUsers.get(userId);
      if (conn && conn.isOnline) {
        logger.info(`User ${userId} reconnected before second ping timeout`);
        fcmPingTimeouts.delete(userId);
        return;
      }

      if (confirmedBackgrounded.has(userId)) {
        // Responded to BOTH pings — truly backgrounded
        logger.info(`User ${userId} responded to BOTH pings — confirmed backgrounded, starting Tier 2 (${AVAILABILITY_TIMEOUT_MS / 60000} min)`);
        confirmedBackgrounded.delete(userId);
        _startAvailabilityTimeout(userId, io);
      } else {
        // Responded to first but NOT second — force-close (dying process responded to first)
        logger.info(`Tier 1.5: No response to second ping from ${userId} — FORCE-CLOSE detected`);
        await _forceUnavailableOnPingTimeout(userId, io);
      }
      fcmPingTimeouts.delete(userId);
    }, 30000);

    fcmPingTimeouts.set(userId, { timeoutId: secondTimeoutId, sentAt: new Date(), phase: 'ping_2' });
  }, 30000);

  fcmPingTimeouts.set(userId, { timeoutId, sentAt: new Date(), phase: 'ping_1' });
}

async function _getUserFcmToken(userId) {
  try {
    const db = getFirestore();
    if (!db) return null;
    const userDoc = await db.collection('users').doc(userId).get();
    return userDoc.exists ? userDoc.data()?.fcmToken : null;
  } catch (err) {
    logger.error(`Failed to get FCM token for ${userId}: ${err.message}`);
    return null;
  }
}

async function _sendFcmPing(userId, fcmToken, pingPhase) {
  try {
    const messaging = getMessaging();
    if (!messaging) return false;

    await messaging.send({
      token: fcmToken,
      data: {
        type: 'availability_ping',
        userId: userId,
        pingPhase: pingPhase,
        timestamp: new Date().toISOString()
      },
      android: { priority: 'high', ttl: 30000 },
      apns: {
        headers: { 'apns-priority': '10', 'apns-push-type': 'background' },
        payload: { aps: { 'content-available': 1 } }
      }
    });
    logger.info(`FCM ${pingPhase} sent to ${userId}`);
    return true;
  } catch (err) {
    logger.error(`FCM ${pingPhase} send error for ${userId}: ${err.message}`);
    if (err.code === 'messaging/invalid-registration-token' ||
        err.code === 'messaging/registration-token-not-registered') {
      return false;
    }
    return true; // Other errors (network) — don't treat as force-close
  }
}

function _cancelFcmPingCheck(userId) {
  const existing = fcmPingTimeouts.get(userId);
  if (existing) {
    clearTimeout(existing.timeoutId);
    fcmPingTimeouts.delete(userId);
  }
  confirmedBackgrounded.delete(userId);
}

async function _forceUnavailableOnPingTimeout(userId, io) {
  try {
    const db = getFirestore();
    if (db) {
      // Force-close detected via FCM ping timeout — also clear toggle preference
      // so it doesn't auto-restore to ON when she reopens the app.
      await db.collection('users').doc(userId).update({
        isAvailable: false,
        isOnline: false,
        availabilityPreference: false,
        forceCloseDetectedAt: new Date()
      });
      logger.info(`User ${userId} - Tier 1.5: Force-close detected, isAvailable=false, availabilityPreference=false`);

      io.to('room_male_browse').emit('availability_changed', {
        femaleUserId: userId,
        isAvailable: false,
        isOnline: false,
        reason: 'force_close_detected',
        timestamp: new Date().toISOString()
      });
    }
  } catch (error) {
    logger.error(`Error in FCM ping timeout for ${userId}: ${error.message}`);
  }
}

/// Called when female app responds to availability_ping via HTTP or WebSocket
export function confirmBackgrounded(userId) {
  confirmedBackgrounded.add(userId);
  logger.info(`User ${userId} confirmed alive (backgrounded) via availability heartbeat`);
}

// --- Tier 2: Availability Safety Net (for backgrounded apps) ---
function _startAvailabilityTimeout(userId, io) {
  _cancelAvailabilityTimeout(userId);

  const minutes = AVAILABILITY_TIMEOUT_MS / 60000;
  logger.info(`Starting ${minutes}-min availability safety net for ${userId}`);

  const timeoutId = setTimeout(async () => {
    const userConnection = connectedUsers.get(userId);
    if (userConnection && userConnection.isOnline) {
      logger.info(`User ${userId} reconnected — cancelling availability timeout`);
      availabilityTimeouts.delete(userId);
      return;
    }

    try {
      const db = getFirestore();
      if (db) {
        await db.collection('users').doc(userId).update({
          isAvailable: false,
          isOnline: false,
          availabilityTimedOutAt: new Date()
        });
        logger.info(`Female user ${userId} - Tier 2: isAvailable=false (${minutes}-min safety net fired)`);

        io.to('room_male_browse').emit('availability_changed', {
          femaleUserId: userId,
          isAvailable: false,
          isOnline: false,
          reason: 'availability_timeout',
          timestamp: new Date().toISOString()
        });
      }
    } catch (error) {
      logger.error(`Error in availability timeout for ${userId}: ${error.message}`);
    }

    availabilityTimeouts.delete(userId);
  }, AVAILABILITY_TIMEOUT_MS);

  availabilityTimeouts.set(userId, { timeoutId, startedAt: new Date() });
}

function _cancelAvailabilityTimeout(userId) {
  const existing = availabilityTimeouts.get(userId);
  if (existing) {
    clearTimeout(existing.timeoutId);
    availabilityTimeouts.delete(userId);
    logger.info(`Cancelled availability timeout for ${userId} (reconnected)`);
  }
}

// Force-close: immediately set isAvailable=false AND clear toggle preference
// (called from set_unavailable handler when user kills/swipes the app away)
//
// Why we also clear availabilityPreference:
//   On force-close the user has deliberately exited the app. When they reopen,
//   the toggle should NOT auto-restore to ON — that would surprise the user
//   (they might receive calls they didn't intend to). Force-close = explicit
//   intent to go offline. They must manually toggle ON to receive calls again.
//
// This is different from a normal disconnect/network drop where preference IS
// preserved (so toggle restores when they reconnect within the grace period).
export async function forceSetUnavailable(userId, io) {
  _cancelFcmPingCheck(userId);
  _cancelAvailabilityTimeout(userId);
  try {
    const db = getFirestore();
    if (db) {
      await db.collection('users').doc(userId).update({
        isAvailable: false,
        isOnline: false,
        availabilityPreference: false,
        appTerminatedAt: new Date()
      });
      logger.info(`User ${userId} - Force-close: isAvailable=false, isOnline=false, availabilityPreference=false`);

      io.to('room_male_browse').emit('availability_changed', {
        femaleUserId: userId,
        isAvailable: false,
        isOnline: false,
        reason: 'app_terminated',
        timestamp: new Date().toISOString()
      });
    }
  } catch (error) {
    logger.error(`Error in forceSetUnavailable for ${userId}: ${error.message}`);
  }
}

// --- Stats ---
export function getStats() {
  return {
    connectedUsers: connectedUsers.size,
    activeCalls: activeCalls.size,
    activeTimers: callTimers.size,
    busyUsers: Array.from(userStatus.values()).filter(s => s.status === 'busy').length,
    disconnectTimeouts: disconnectTimeouts.size
  };
}
