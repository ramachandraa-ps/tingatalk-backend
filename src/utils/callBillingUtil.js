// ============================================================================
// Call Billing Utility — single source of truth for end-of-call billing
// Used by both:
//   - /api/calls/complete       (manual end by male/female via HTTP)
//   - mid-call auto-end timers  (server-initiated when balance runs out)
//
// Without this helper, the server-initiated path used to skip all billing
// (just killed the timer + emitted call_ended), so coins were never deducted
// from the male and female earnings were never credited.
// ============================================================================

import { admin } from '../config/firebase.js';
import { logger } from './logger.js';
import { FEMALE_EARNING_RATES } from '../shared/constants.js';
import { getConnectedUser } from '../socket/state/connectionManager.js';
import { updateCallLogs } from './callLogUtil.js';

/**
 * Run the full end-of-call billing sequence:
 *   1. Deduct male coins (with balance guard)
 *   2. Update calls/{callId} doc with billing metadata
 *   3. Credit female earnings (totals + daily + transaction record)
 *   4. Record male spend transaction
 *   5. Update admin_analytics.call_stats
 *   6. Update callLogs for both users
 *   7. Emit call_ended to both connected sockets
 *
 * Idempotent: caller is responsible for checking if billing already ran
 * (by inspecting calls/{callId}.billingSource before invoking).
 *
 * @param {Object} args
 * @param {string} args.callId
 * @param {Object} args.timer    - timer object (must have callerId, recipientId, callType, coinRate, callerName, durationSeconds)
 * @param {string} args.endReason
 * @param {string} args.source   - 'normal_completion' | 'server_auto_end' (used in callLogs + callDoc.billingSource)
 * @param {Object} args.db       - Firestore instance
 * @param {Object} [args.io]     - Socket.IO server (optional; if missing, socket emit is skipped)
 * @returns {Promise<{actualDeduction:number, durationSeconds:number, newBalance:number, earningAmount:number}>}
 */
export async function performCallBilling({ callId, timer, endReason, source, db, io }) {
  const callerId = timer.callerId;
  const recipientId = timer.recipientId;
  const callType = timer.callType;
  const durationSeconds = timer.durationSeconds;
  const coinRate = timer.coinRate;
  const coinsDeducted = Math.ceil(durationSeconds * coinRate);

  // 1. Deduct male coins (with balance guard so balance never goes negative)
  let actualDeduction = 0;
  let newBalance = 0;
  if (callerId && coinsDeducted > 0) {
    try {
      const userRef = db.collection('users').doc(callerId);
      const userDoc = await userRef.get();
      const data = userDoc.data() || {};
      const currentBalance = data.coins ?? 0;

      actualDeduction = Math.min(coinsDeducted, Math.max(0, currentBalance));
      if (actualDeduction > 0) {
        await userRef.update({
          coins: admin.firestore.FieldValue.increment(-actualDeduction),
          lastSpendAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
      newBalance = Math.max(0, currentBalance - actualDeduction);

      if (actualDeduction < coinsDeducted) {
        logger.warn(`Balance guard: ${callerId} had ${currentBalance} coins, tried to deduct ${coinsDeducted}, deducted ${actualDeduction}`);
      }
    } catch (e) {
      logger.error(`performCallBilling: deduction failed for ${callId}: ${e.message}`);
    }
  }

  // 2. Update call doc with billing metadata
  try {
    await db.collection('calls').doc(callId).update({
      status: 'completed',
      durationSeconds,
      coinsDeducted: actualDeduction,
      endedAt: new Date().toISOString(),
      endReason: endReason || 'completed',
      billingSource: source,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (e) {
    logger.warn(`performCallBilling: call doc update failed for ${callId}: ${e.message}`);
  }

  // 3. Credit female earnings
  const earningRate = callType === 'video' ? FEMALE_EARNING_RATES.video : FEMALE_EARNING_RATES.audio;
  const earningAmount = parseFloat((durationSeconds * earningRate).toFixed(2));
  if (recipientId && durationSeconds > 0) {
    try {
      const dateKey = new Date().toISOString().split('T')[0];
      const femaleEarningsRef = db.collection('female_earnings').doc(recipientId);

      await femaleEarningsRef.set({
        totalEarnings: admin.firestore.FieldValue.increment(earningAmount),
        availableBalance: admin.firestore.FieldValue.increment(earningAmount),
        totalCalls: admin.firestore.FieldValue.increment(1),
        totalDurationSeconds: admin.firestore.FieldValue.increment(durationSeconds),
        [`total${callType === 'video' ? 'Video' : 'Audio'}Calls`]: admin.firestore.FieldValue.increment(1),
        [`total${callType === 'video' ? 'Video' : 'Audio'}Earnings`]: admin.firestore.FieldValue.increment(earningAmount),
        lastCallAt: admin.firestore.FieldValue.serverTimestamp(),
        lastUpdated: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      await femaleEarningsRef.collection('daily').doc(dateKey).set({
        date: dateKey,
        earnings: admin.firestore.FieldValue.increment(earningAmount),
        calls: admin.firestore.FieldValue.increment(1),
        durationSeconds: admin.firestore.FieldValue.increment(durationSeconds),
        lastUpdated: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      await femaleEarningsRef.collection('transactions').doc(callId).set({
        type: 'call_earning',
        callId,
        callerId,
        callerName: timer.callerName || 'Unknown',
        callType,
        isVideoCall: callType === 'video',
        durationSeconds,
        amount: earningAmount,
        currency: 'INR',
        ratePerSecond: earningRate,
        completedAt: new Date().toISOString(),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        status: 'completed'
      });
    } catch (e) {
      logger.error(`performCallBilling: female earnings failed for ${callId}: ${e.message}`);
    }
  }

  // 4. Record male spend transaction
  if (callerId && actualDeduction > 0) {
    try {
      const spendTxnId = `txn_call_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;
      const spendTxnData = {
        id: spendTxnId, userId: callerId, type: 'spend', status: 'success',
        coinAmount: actualDeduction,
        description: `${callType} call - ${durationSeconds}s`,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        metadata: { callId, callType, durationSeconds, coinRate, recipientId }
      };
      const batch = db.batch();
      batch.set(db.collection('users').doc(callerId).collection('transactions').doc(spendTxnId), spendTxnData);
      batch.update(db.collection('users').doc(callerId), {
        totalCoinsSpent: admin.firestore.FieldValue.increment(actualDeduction)
      });
      await batch.commit();
    } catch (e) {
      logger.error(`performCallBilling: spend txn failed for ${callId}: ${e.message}`);
    }
  }

  // 5. Update admin analytics
  try {
    await db.collection('admin_analytics').doc('call_stats').set({
      totalCalls: admin.firestore.FieldValue.increment(1),
      totalDurationSeconds: admin.firestore.FieldValue.increment(durationSeconds),
      totalCoinsDeducted: admin.firestore.FieldValue.increment(actualDeduction),
      lastUpdated: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  } catch (e) {
    logger.warn(`performCallBilling: analytics update failed for ${callId}: ${e.message}`);
  }

  // 6. Update call logs (for both users' call history)
  try {
    await updateCallLogs({
      callId,
      callerId,
      recipientId,
      callType,
      durationSeconds,
      coinsDeducted: actualDeduction,
      status: 'completed',
      endReason: endReason || 'completed',
      source,
    });
  } catch (e) {
    logger.warn(`performCallBilling: callLogs update failed for ${callId}: ${e.message}`);
  }

  // 7. Notify connected sockets
  if (io) {
    [callerId, recipientId].forEach(uid => {
      if (!uid) return;
      const conn = getConnectedUser(uid);
      if (conn && conn.isOnline) {
        const eventData = {
          callId,
          durationSeconds,
          coinsDeducted: actualDeduction,
          endReason: endReason || 'completed',
          callType,
          endedBy: source === 'server_auto_end' ? 'server' : (timer.endedBy || callerId),
          reason: source === 'server_auto_end' ? 'insufficient_balance' : undefined,
          timestamp: new Date().toISOString()
        };
        if (uid === recipientId) {
          eventData.earningAmount = earningAmount;
          eventData.isRecipient = true;
        }
        io.to(conn.socketId).emit('call_ended', eventData);
      }
    });
  }

  logger.info(`Billing complete: ${callId} - duration=${durationSeconds}s, deducted=${actualDeduction}, earned=${earningAmount}, source=${source}`);

  return { actualDeduction, durationSeconds, newBalance, earningAmount };
}
