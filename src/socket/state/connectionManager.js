import { logger } from '../../utils/logger.js';
import { getRedis } from '../../config/redis.js';
import { getFirestore, admin } from '../../config/firebase.js';
import { DISCONNECT_TIMEOUT_MS } from '../../shared/constants.js';

// In-memory state (synced to Redis non-blocking)
const connectedUsers = new Map();
const userStatus = new Map();
const activeCalls = new Map();
const callTimers = new Map();
const disconnectTimeouts = new Map();

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
          await db.collection('users').doc(userId).update({
            isAvailable: false,
            isOnline: false,
            lastSeenAt: new Date(),
            disconnectedAt: new Date(),
            forceClosedAt: new Date()
          });
          logger.info(`Female user ${userId} - BOTH isAvailable AND isOnline set to FALSE (force-close detected)`);

          io.emit('availability_changed', {
            femaleUserId: userId,
            isAvailable: false,
            isOnline: false,
            reason: 'force_close_detected',
            timestamp: new Date().toISOString()
          });
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
