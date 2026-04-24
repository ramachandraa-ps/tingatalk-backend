import { getFirestore, admin } from '../config/firebase.js';
import { logger } from './logger.js';
import { FEMALE_EARNING_RATES } from '../shared/constants.js';

/**
 * Update callLogs subcollection for both caller and recipient when a call completes.
 * This ensures the frontend call history screen shows accurate data regardless of
 * how the call ended (normal, disconnect, or stale heartbeat).
 *
 * For trial calls (isTrialCall=true): coinsDeducted=0 and earnings=0,
 * with displayLabel='Trial Call' so frontend can show "Trial Call" instead of amount.
 */
export async function updateCallLogs({
  callId,
  callerId,
  recipientId,
  callType,
  durationSeconds,
  coinsDeducted,
  status = 'completed',
  endReason = 'completed',
  source = 'server',
  isTrialCall = false,
  displayLabel = null,
}) {
  try {
    const db = getFirestore();
    if (!db || !callId) return;

    const now = admin.firestore.FieldValue.serverTimestamp();
    const earningRate = callType === 'video' ? FEMALE_EARNING_RATES.video : FEMALE_EARNING_RATES.audio;
    // For trial calls: zero earnings regardless of duration
    const earnings = isTrialCall ? 0 : parseFloat((durationSeconds * earningRate).toFixed(2));

    const updateData = {
      status,
      endReason,
      durationSeconds,
      durationMinutes: parseFloat((durationSeconds / 60).toFixed(2)),
      callEndedAt: now,
      completedAt: now,
      updatedAt: now,
      isTrialCall,
      displayLabel: displayLabel || (isTrialCall ? 'Trial Call' : null),
    };

    const writes = [];

    // Update caller's callLog
    if (callerId) {
      writes.push(
        db.collection('users').doc(callerId).collection('callLogs').doc(callId)
          .set({
            ...updateData,
            coinsDeducted: isTrialCall ? 0 : (coinsDeducted || 0),
          }, { merge: true })
      );
    }

    // Update recipient's (female) callLog with earnings
    if (recipientId) {
      writes.push(
        db.collection('users').doc(recipientId).collection('callLogs').doc(callId)
          .set({
            ...updateData,
            earnings,
          }, { merge: true })
      );
    }

    await Promise.all(writes);
    logger.info(`Call logs updated for ${callId} (${source})${isTrialCall ? ' [TRIAL]' : ''}: caller=${callerId}, recipient=${recipientId}`);
  } catch (err) {
    logger.error(`Failed to update call logs for ${callId}: ${err.message}`);
  }
}
