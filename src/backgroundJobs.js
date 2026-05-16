// ============================================================================
// Background Jobs: Heartbeat monitor, memory protection, Redis timer recovery
// ============================================================================

import { logger } from './utils/logger.js';
import { getRedis } from './config/redis.js';
import { getFirestore, admin } from './config/firebase.js';
import {
  getAllCallTimers, deleteCallTimer, setUserStatus, deleteActiveCall,
  getAllActiveCalls, getAllConnectedUsers
} from './socket/state/connectionManager.js';
import {
  HEARTBEAT_TIMEOUT_MS, HEARTBEAT_CHECK_INTERVAL_MS,
  MAX_CONCURRENT_CALLS, REDIS_CALL_TIMER_EXPIRY, COIN_RATES,
} from './shared/constants.js';
import { performCallBilling } from './utils/callBillingUtil.js';
import { startMarketingNotificationJob, stopMarketingNotificationJob } from './features/notifications/marketingNotification.js';

let heartbeatIntervalId = null;
let memoryCheckIntervalId = null;

// Idempotency signals for billing — used by heartbeat-stale-detection and the
// stale-call reaper to avoid re-billing calls another path already handled.
//
// MUST stay in sync with ALREADY_BILLED in call.handler.js end_call handler.
// Verified against every performCallBilling() caller in the codebase:
//   - 'server'              legacy value still present on older call docs
//   - 'normal_completion'   end_call socket safety-net + /api/calls/complete
//   - 'server_auto_end'     auto-end timer when male balance exhausted
//   - 'disconnect_recovery' connection.handler.js disconnect path
//   - 'client_fallback'     calls.routes.js fallback billing path
//   - 'stale_call_recovery' this file's heartbeat-stale-detection path
//   - 'admin_cleanup_2026-05-16' one-off cleanup script
const BILLED_SOURCES = new Set([
  'server',
  'normal_completion',
  'server_auto_end',
  'disconnect_recovery',
  'client_fallback',
  'stale_call_recovery',
  'admin_cleanup_2026-05-16',
]);

// Defense-in-depth: status-based check. Extended from the original 7 statuses
// with 'disconnected' (Bug C original symptom), 'abandoned' (cleanup script),
// 'missed' (used elsewhere in codebase).
const TERMINAL_STATUSES = [
  'cancelled', 'declined', 'ended', 'completed',
  'timeout', 'timeout_heartbeat', 'timeout_runaway',
  'disconnected', 'abandoned', 'missed',
];

// ============================================================================
// Heartbeat Timeout Monitor
// ============================================================================
function startHeartbeatMonitor(io) {
  heartbeatIntervalId = setInterval(async () => {
    const now = Date.now();
    let staleCallsFound = 0;
    const callEntries = Array.from(getAllCallTimers().entries());

    for (const [callId, timer] of callEntries) {
      if (!timer.lastHeartbeat) {
        timer.lastHeartbeat = Date.now();
        logger.warn(`Timer for call ${callId} had no lastHeartbeat, initialized now`);
        continue;
      }

      const timeSinceLastHeartbeat = now - timer.lastHeartbeat;

      if (timeSinceLastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
        // Stop the timer interval immediately
        if (timer.interval) clearInterval(timer.interval);

        const rawDuration = timer.durationSeconds || 0;
        const MAX_CALL_DURATION_SECONDS = 3600; // 60 min hard cap

        // FIX 3: Hard cap — if duration exceeds 60 min, this is a runaway timer, don't bill
        if (rawDuration > MAX_CALL_DURATION_SECONDS) {
          logger.warn(`RUNAWAY TIMER DETECTED: ${callId} - Duration ${rawDuration}s exceeds ${MAX_CALL_DURATION_SECONDS}s cap. Discarding without billing.`);
          deleteCallTimer(callId);
          deleteActiveCall(callId);
          await removeCallTimerFromRedis(callId);
          // Update Firestore to mark as cancelled-runaway
          try {
            const db = getFirestore();
            if (db) {
              await db.collection('calls').doc(callId).update({
                status: 'timeout_runaway',
                durationSeconds: 0,
                coinsDeducted: 0,
                endedAt: admin.firestore.FieldValue.serverTimestamp(),
                endReason: 'Runaway timer detected - call discarded'
              }).catch(() => {});
            }
          } catch (e) {}
          continue;
        }

        // Check if this call was already cancelled/declined/ended in Firestore before billing
        try {
          const db = getFirestore();
          if (db) {
            const callDoc = await db.collection('calls').doc(callId).get();
            if (callDoc.exists) {
              const callData = callDoc.data();
              const callStatus = callData.status;
              const billingSource = callData.billingSource;
              // Bug C fix: use billingSource as PRIMARY signal (correct dimension —
              // means "billing has run") with status as defense-in-depth secondary.
              // Either signal indicating "already handled" → skip.
              const alreadyBilled = (billingSource && BILLED_SOURCES.has(billingSource)) ||
                                    TERMINAL_STATUSES.includes(callStatus);
              if (alreadyBilled) {
                logger.info(`Skipping stale billing for ${callId} — already handled (status=${callStatus}, billingSource=${billingSource || 'none'})`);
                deleteCallTimer(callId);
                deleteActiveCall(callId);
                await removeCallTimerFromRedis(callId);
                continue;
              }
            }
          }
        } catch (checkErr) {
          logger.warn(`Could not verify call status for ${callId}: ${checkErr.message} — proceeding with stale billing`);
        }

        staleCallsFound++;
        logger.warn(`STALE CALL DETECTED: ${callId} - No heartbeat for ${Math.round(timeSinceLastHeartbeat / 1000)}s`);
        logger.info(`Auto-ending stale call ${callId} via performCallBilling`);

        // Delegate billing to single source of truth.
        // Female now gets credit for the FULL call duration regardless of male's
        // wallet shortfall (matches behavior of all other paths after the
        // Issue #3 + Issue #4 refactor). Male is still capped by the balance
        // guard inside performCallBilling.
        try {
          const db = getFirestore();
          if (db && timer.callerId) {
            await performCallBilling({
              callId,
              timer,
              endReason: 'No heartbeat received - connection lost',
              source: 'stale_call_recovery',
              db,
              io,
              endedBy: 'server',
            });
          }
        } catch (error) {
          logger.error(`Error closing stale call ${callId}: ${error.message}`);
        }

        // Clean up call timer (performCallBilling didn't delete it — that's
        // intentionally caller's responsibility for flexibility)
        deleteCallTimer(callId);

        // Reset user statuses (also intentionally caller's responsibility)
        if (timer.callerId) {
          setUserStatus(timer.callerId, {
            status: 'available',
            currentCallId: null,
            lastStatusChange: new Date()
          });
        }
        if (timer.recipientId) {
          setUserStatus(timer.recipientId, {
            status: 'available',
            currentCallId: null,
            lastStatusChange: new Date()
          });
        }

        // call_ended socket emit is handled by performCallBilling — no need to
        // emit again here.

        // Clean from active calls
        deleteActiveCall(callId);

        // Remove from Redis
        await removeCallTimerFromRedis(callId);
      }
    }

    if (staleCallsFound > 0) {
      logger.info(`Heartbeat monitor: Found and cleaned ${staleCallsFound} stale call(s)`);
    }
  }, HEARTBEAT_CHECK_INTERVAL_MS);
}

// ============================================================================
// Memory Protection: Limit max concurrent call timers
// ============================================================================
function startMemoryProtection() {
  memoryCheckIntervalId = setInterval(() => {
    const timers = getAllCallTimers();
    if (timers.size > MAX_CONCURRENT_CALLS) {
      logger.warn(`MEMORY WARNING: ${timers.size} call timers active (max: ${MAX_CONCURRENT_CALLS})`);

      const sortedTimers = Array.from(timers.entries())
        .sort((a, b) => (a[1].startTime || 0) - (b[1].startTime || 0));

      const toRemove = sortedTimers.slice(0, timers.size - MAX_CONCURRENT_CALLS);
      toRemove.forEach(([callId, timer]) => {
        logger.warn(`Force cleaning old call timer: ${callId}`);
        if (timer.interval) clearInterval(timer.interval);
        deleteCallTimer(callId);
      });
    }
  }, 60000);
}

// ============================================================================
// Redis Timer Persistence
// ============================================================================
export async function storeCallTimerInRedis(callId, callData) {
  try {
    const redis = getRedis();
    if (!redis) return;

    const timerKey = `call_timer:${callId}`;
    await redis.hset(timerKey, {
      startTime: Date.now().toString(),
      callerId: callData.callerId || '',
      recipientId: callData.recipientId || '',
      callType: callData.callType || 'video',
      coinRate: (callData.callType === 'video' ? COIN_RATES.video : COIN_RATES.audio).toString(),
      roomName: callData.roomName || ''
    });
    await redis.expire(timerKey, REDIS_CALL_TIMER_EXPIRY);
    logger.info(`Call timer stored in Redis: ${callId}`);
  } catch (error) {
    logger.error(`Failed to store call timer in Redis: ${callId}`, error.message);
  }
}

export async function removeCallTimerFromRedis(callId) {
  try {
    const redis = getRedis();
    if (!redis) return;
    await redis.del(`call_timer:${callId}`);
    logger.info(`Call timer removed from Redis: ${callId}`);
  } catch (error) {
    logger.error(`Failed to remove call timer from Redis: ${callId}`, error.message);
  }
}

export async function recoverCallTimersFromRedis() {
  try {
    const redis = getRedis();
    if (!redis) return;

    const keys = await redis.keys('call_timer:*');
    logger.info(`Found ${keys.length} call timers to recover from Redis`);

    const activeCalls = getAllActiveCalls();

    for (const key of keys) {
      const timerData = await redis.hgetall(key);
      const callId = key.replace('call_timer:', '');
      const elapsed = Math.floor((Date.now() - parseInt(timerData.startTime)) / 1000);

      if (elapsed > REDIS_CALL_TIMER_EXPIRY) {
        await redis.del(key);
        logger.warn(`Cleaned up stale call timer: ${callId} (${elapsed}s old)`);
        continue;
      }

      activeCalls.set(callId, {
        ...timerData,
        startTime: parseInt(timerData.startTime),
        elapsedSeconds: elapsed,
        recovered: true
      });
      logger.info(`Recovered call timer: ${callId} (${elapsed}s elapsed)`);
    }
  } catch (error) {
    logger.error('Error recovering call timers:', error.message);
  }
}

// ============================================================================
// Start / Stop
// ============================================================================
// --- Stale Connection Cleanup (every 5 minutes) ---
let staleCleanupIntervalId = null;

function startStaleConnectionCleanup(io) {
  staleCleanupIntervalId = setInterval(() => {
    const allUsers = getAllConnectedUsers();
    let cleaned = 0;

    for (const [userId, userData] of allUsers.entries()) {
      if (!userData.isOnline) continue;

      const socket = io.sockets.sockets.get(userData.socketId);
      if (!socket || !socket.connected) {
        logger.info(`Cleaning stale connection for ${userId} (socket ${userData.socketId} is dead)`);
        userData.isOnline = false;
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.info(`Stale connection cleanup: removed ${cleaned} dead connections`);
    }
  }, 300000); // Every 5 minutes
}

export function startBackgroundJobs(io) {
  startHeartbeatMonitor(io);
  startMemoryProtection();
  startStaleConnectionCleanup(io);
  startMarketingNotificationJob();
  logger.info(`Background jobs started (heartbeat timeout: ${HEARTBEAT_TIMEOUT_MS / 1000}s, check interval: ${HEARTBEAT_CHECK_INTERVAL_MS / 1000}s)`);
}

export function stopBackgroundJobs() {
  if (heartbeatIntervalId) clearInterval(heartbeatIntervalId);
  if (memoryCheckIntervalId) clearInterval(memoryCheckIntervalId);
  if (staleCleanupIntervalId) clearInterval(staleCleanupIntervalId);
  stopMarketingNotificationJob();
  logger.info('Background jobs stopped');
}
