// ============================================================================
// Trial Call Utility
// New male users get 1 free audio call + 1 free video call (max 60 sec each).
// Tracked via existing totalAudioCallsMade and totalVideoCallsMade fields.
// Trial calls: no coin deduction, no female earnings, hard cap at 60s.
// ============================================================================

import { getFirestore, admin } from '../config/firebase.js';
import { logger } from './logger.js';

export const TRIAL_CALL_MAX_DURATION_SECONDS = 60;

/**
 * Check if this call should be a trial call.
 *
 * A call is a trial call when:
 *   - Caller is male
 *   - For audio: totalAudioCallsMade == 0
 *   - For video: totalVideoCallsMade == 0
 *
 * Returns: { isTrial: boolean, reason: string }
 */
export async function checkIsTrialCall(callerId, callType) {
  if (!callerId) return { isTrial: false, reason: 'no_caller_id' };
  if (callType !== 'audio' && callType !== 'video') {
    return { isTrial: false, reason: 'invalid_call_type' };
  }
  try {
    const db = getFirestore();
    if (!db) return { isTrial: false, reason: 'firestore_not_initialized' };

    const userDoc = await db.collection('users').doc(callerId).get();
    if (!userDoc.exists) return { isTrial: false, reason: 'user_not_found' };

    const data = userDoc.data();
    if (data.gender !== 'male') {
      return { isTrial: false, reason: 'not_male' };
    }

    const fieldName = callType === 'video' ? 'totalVideoCallsMade' : 'totalAudioCallsMade';
    const callCount = data[fieldName];

    // Treat null/undefined as 0 (new user)
    if (callCount === undefined || callCount === null || callCount === 0) {
      return { isTrial: true, reason: `first_${callType}_call` };
    }

    return { isTrial: false, reason: `already_made_${callCount}_${callType}_calls` };
  } catch (err) {
    logger.error(`checkIsTrialCall error: ${err.message}`);
    return { isTrial: false, reason: 'error' };
  }
}

/**
 * Increment male user's call count after a completed call.
 * Should be called for BOTH trial AND normal calls so trial gets used up.
 */
export async function incrementMaleCallCount(callerId, callType) {
  if (!callerId || (callType !== 'audio' && callType !== 'video')) return;
  try {
    const db = getFirestore();
    if (!db) return;
    const fieldName = callType === 'video' ? 'totalVideoCallsMade' : 'totalAudioCallsMade';
    await db.collection('users').doc(callerId).set({
      [fieldName]: admin.firestore.FieldValue.increment(1),
    }, { merge: true });
    logger.info(`Incremented ${fieldName} for ${callerId}`);
  } catch (err) {
    logger.error(`incrementMaleCallCount error: ${err.message}`);
  }
}
