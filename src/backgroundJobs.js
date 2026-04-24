// ============================================================================
// Background Jobs: Heartbeat monitor, memory protection, Redis timer recovery
// ============================================================================

import { logger } from './utils/logger.js';
import { getRedis } from './config/redis.js';
import { getFirestore, admin } from './config/firebase.js';
import {
  getAllCallTimers, deleteCallTimer, setUserStatus, deleteActiveCall,
  getConnectedUser, getAllActiveCalls, getAllConnectedUsers
} from './socket/state/connectionManager.js';
import {
  HEARTBEAT_TIMEOUT_MS, HEARTBEAT_CHECK_INTERVAL_MS,
  MAX_CONCURRENT_CALLS, REDIS_CALL_TIMER_EXPIRY, COIN_RATES,
  FEMALE_EARNING_RATES
} from './shared/constants.js';
import { updateCallLogs } from './utils/callLogUtil.js';
import { startMarketingNotificationJob, stopMarketingNotificationJob } from './features/notifications/marketingNotification.js';

let heartbeatIntervalId = null;
let memoryCheckIntervalId = null;

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
              if (['cancelled', 'declined', 'ended', 'completed', 'timeout', 'timeout_heartbeat', 'timeout_runaway'].includes(callStatus)) {
                logger.info(`Skipping stale billing for ${callId} — already ${callStatus} in Firestore`);
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

        const finalDuration = rawDuration;
        const isTrialStale = timer.isTrialCall === true;
        // For trial calls: zero coins regardless of duration
        const coinsToDeduct = isTrialStale ? 0 : Math.ceil(finalDuration * (timer.coinRate || 0));

        logger.info(`Auto-ending stale call ${callId}: ${finalDuration}s, ${coinsToDeduct} coins${isTrialStale ? ' [TRIAL]' : ''}`);

        // Deduct coins and update Firestore — use ACTUAL deduction for symmetric billing (Fix 4)
        // For trial calls: zero deduction
        let actualCoinsDeducted = 0;
        let actualBilledSeconds = finalDuration;
        try {
          const db = getFirestore();
          if (db && timer.callerId) {
            if (!isTrialStale) {
              await db.runTransaction(async (transaction) => {
                const userRef = db.collection('users').doc(timer.callerId);
                const userDoc = await transaction.get(userRef);
                if (userDoc.exists) {
                  const currentBalance = userDoc.data().coins ?? 0;
                  actualCoinsDeducted = Math.min(coinsToDeduct, Math.max(0, currentBalance));
                  const newBalance = currentBalance - actualCoinsDeducted;
                  transaction.update(userRef, {
                    coins: newBalance,
                    lastDeductedAt: admin.firestore.FieldValue.serverTimestamp()
                  });
                }
              });
            }

            // Fix 4: Calculate actual billed seconds based on what was actually charged
            if (actualCoinsDeducted < coinsToDeduct && timer.coinRate > 0) {
              actualBilledSeconds = Math.floor(actualCoinsDeducted / timer.coinRate);
            }

            await db.collection('calls').doc(callId).update({
              status: 'timeout_heartbeat',
              durationSeconds: actualBilledSeconds,
              coinsDeducted: actualCoinsDeducted,
              isTrialCall: isTrialStale,
              displayLabel: isTrialStale ? 'Trial Call' : null,
              endedAt: admin.firestore.FieldValue.serverTimestamp(),
              endReason: isTrialStale ? 'trial_call_timeout' : 'No heartbeat received - connection lost'
            });
            logger.info(`Stale call ${callId} billed and closed: ${actualCoinsDeducted} coins deducted (requested: ${coinsToDeduct}, actual billed seconds: ${actualBilledSeconds})${isTrialStale ? ' [TRIAL]' : ''}`);

            // Fix 4: Record female earnings based on ACTUAL billed seconds (symmetric) — SKIP for trial
            if (!isTrialStale && timer.recipientId && actualBilledSeconds > 0) {
              try {
                const callType = timer.callType || 'audio';
                const earningRate = callType === 'video' ? FEMALE_EARNING_RATES.video : FEMALE_EARNING_RATES.audio;
                const earningAmount = parseFloat((actualBilledSeconds * earningRate).toFixed(2));
                const dateKey = new Date().toISOString().split('T')[0];
                const femaleEarningsRef = db.collection('female_earnings').doc(timer.recipientId);

                await femaleEarningsRef.set({
                  totalEarnings: admin.firestore.FieldValue.increment(earningAmount),
                  availableBalance: admin.firestore.FieldValue.increment(earningAmount),
                  totalCalls: admin.firestore.FieldValue.increment(1),
                  totalDurationSeconds: admin.firestore.FieldValue.increment(actualBilledSeconds),
                  lastCallAt: admin.firestore.FieldValue.serverTimestamp(),
                  lastUpdated: admin.firestore.FieldValue.serverTimestamp()
                }, { merge: true });

                await femaleEarningsRef.collection('daily').doc(dateKey).set({
                  date: dateKey,
                  earnings: admin.firestore.FieldValue.increment(earningAmount),
                  calls: admin.firestore.FieldValue.increment(1),
                  durationSeconds: admin.firestore.FieldValue.increment(actualBilledSeconds),
                  lastUpdated: admin.firestore.FieldValue.serverTimestamp()
                }, { merge: true });

                await femaleEarningsRef.collection('transactions').doc(callId).set({
                  type: 'call_earning',
                  callId,
                  callerId: timer.callerId,
                  callType,
                  durationSeconds: actualBilledSeconds,
                  amount: earningAmount,
                  currency: 'INR',
                  ratePerSecond: earningRate,
                  completedAt: new Date().toISOString(),
                  createdAt: admin.firestore.FieldValue.serverTimestamp(),
                  status: 'completed',
                  source: 'stale_call_recovery'
                });

                logger.info(`Female earnings recorded for stale call ${callId}: ₹${earningAmount} (based on actual billed ${actualBilledSeconds}s) to ${timer.recipientId}`);
              } catch (earningsError) {
                logger.error(`Failed to record female earnings for stale call ${callId}: ${earningsError.message}`);
              }
            } else if (isTrialStale && timer.recipientId && finalDuration > 0) {
              // Trial call timed out — record trial transaction (₹0) for female history
              try {
                const callType = timer.callType || 'audio';
                await db.collection('female_earnings').doc(timer.recipientId)
                  .collection('transactions').doc(callId).set({
                    type: 'trial_call',
                    callId,
                    callerId: timer.callerId,
                    callType,
                    isVideoCall: callType === 'video',
                    durationSeconds: finalDuration,
                    amount: 0,
                    currency: 'INR',
                    isTrialCall: true,
                    displayLabel: 'Trial Call',
                    completedAt: new Date().toISOString(),
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    status: 'completed'
                  });
                logger.info(`Trial call timeout transaction recorded for ${timer.recipientId}`);
              } catch (e) {
                logger.error(`Failed to record trial call timeout transaction: ${e.message}`);
              }
            }

            // Update call logs for both users (with trial flag)
            await updateCallLogs({
              callId,
              callerId: timer.callerId,
              recipientId: timer.recipientId,
              callType: timer.callType || 'audio',
              durationSeconds: isTrialStale ? finalDuration : actualBilledSeconds,
              coinsDeducted: actualCoinsDeducted,
              status: 'completed',
              endReason: isTrialStale ? 'trial_call_timeout' : 'connection_lost',
              source: isTrialStale ? 'trial_stale_recovery' : 'stale_call_recovery',
              isTrialCall: isTrialStale,
              displayLabel: isTrialStale ? 'Trial Call' : null,
            });

            // Increment male call count to use up trial
            if (timer.callerId) {
              const { incrementMaleCallCount } = await import('./utils/trialCallUtil.js');
              await incrementMaleCallCount(timer.callerId, timer.callType || 'audio');
            }
          }
        } catch (error) {
          logger.error(`Error closing stale call ${callId}: ${error.message}`);
        }

        // Clean up call timer
        deleteCallTimer(callId);

        // Reset user statuses
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

        // Notify users via WebSocket
        const callerConn = timer.callerId ? getConnectedUser(timer.callerId) : null;
        const recipientConn = timer.recipientId ? getConnectedUser(timer.recipientId) : null;

        const endPayload = {
          callId,
          endedBy: 'server',
          reason: 'Connection timeout - no heartbeat',
          duration: finalDuration
        };

        if (callerConn) io.to(callerConn.socketId).emit('call_ended', endPayload);
        if (recipientConn) io.to(recipientConn.socketId).emit('call_ended', endPayload);

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
