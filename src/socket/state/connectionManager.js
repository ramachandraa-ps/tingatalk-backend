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

          io.to('room_male_browse').emit('availability_changed', {
            femaleUserId: userId,
            isAvailable: true,
            isOnline: false,
            reason: 'disconnect_timeout',
            timestamp: new Date().toISOString()
          });

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
}

// --- Tier 1.5: FCM Ping to detect force-close vs background ---
async function _startFcmPingCheck(userId, io) {
  _cancelFcmPingCheck(userId);
  confirmedBackgrounded.delete(userId);

  logger.info(`Tier 1.5: Sending FCM availability_ping to ${userId} (${FCM_PING_TIMEOUT_MS / 1000}s timeout)`);

  // Send FCM silent push to check if app is alive in background
  try {
    const messaging = getMessaging();
    const db = getFirestore();
    if (messaging && db) {
      const userDoc = await db.collection('users').doc(userId).get();
      const fcmToken = userDoc.exists ? userDoc.data()?.fcmToken : null;

      if (fcmToken) {
        await messaging.send({
          token: fcmToken,
          data: {
            type: 'availability_ping',
            userId: userId,
            timestamp: new Date().toISOString()
          },
          android: { priority: 'high', ttl: 60000 },
          apns: {
            headers: { 'apns-priority': '10', 'apns-push-type': 'background' },
            payload: { aps: { 'content-available': 1 } }
          }
        });
        logger.info(`FCM availability_ping sent to ${userId}`);
      } else {
        logger.warn(`No FCM token for ${userId} — treating as force-close`);
        // No FCM token = can't verify, force unavailable immediately
        await _forceUnavailableOnPingTimeout(userId, io);
        return;
      }
    }
  } catch (err) {
    logger.error(`FCM ping send error for ${userId}: ${err.message}`);
    // FCM send failed — might be invalid token, treat as force-close
    if (err.code === 'messaging/invalid-registration-token' ||
        err.code === 'messaging/registration-token-not-registered') {
      await _forceUnavailableOnPingTimeout(userId, io);
      return;
    }
  }

  // Start timeout — if no heartbeat response within FCM_PING_TIMEOUT_MS, assume force-close
  const timeoutId = setTimeout(async () => {
    const userConnection = connectedUsers.get(userId);
    if (userConnection && userConnection.isOnline) {
      logger.info(`User ${userId} reconnected before FCM ping timeout`);
      fcmPingTimeouts.delete(userId);
      return;
    }

    if (confirmedBackgrounded.has(userId)) {
      // User responded to ping — app is backgrounded, start Tier 2
      logger.info(`User ${userId} confirmed backgrounded — starting Tier 2 (${AVAILABILITY_TIMEOUT_MS / 60000} min)`);
      fcmPingTimeouts.delete(userId);
      confirmedBackgrounded.delete(userId);
      _startAvailabilityTimeout(userId, io);
      return;
    }

    // No response — force-close detected
    logger.info(`Tier 1.5: No FCM ping response from ${userId} — force-close detected`);
    await _forceUnavailableOnPingTimeout(userId, io);
    fcmPingTimeouts.delete(userId);
  }, FCM_PING_TIMEOUT_MS);

  fcmPingTimeouts.set(userId, { timeoutId, sentAt: new Date() });
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
      await db.collection('users').doc(userId).update({
        isAvailable: false,
        isOnline: false,
        forceCloseDetectedAt: new Date()
      });
      logger.info(`User ${userId} - Tier 1.5: Force-close detected, isAvailable=false`);

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

// Force-close: immediately set isAvailable=false (called from set_unavailable handler)
export async function forceSetUnavailable(userId, io) {
  _cancelFcmPingCheck(userId);
  _cancelAvailabilityTimeout(userId);
  try {
    const db = getFirestore();
    if (db) {
      await db.collection('users').doc(userId).update({
        isAvailable: false,
        isOnline: false,
        appTerminatedAt: new Date()
      });
      logger.info(`User ${userId} - Force-close: isAvailable=false, isOnline=false`);

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
