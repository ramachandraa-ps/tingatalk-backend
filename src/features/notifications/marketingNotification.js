// ============================================================================
// Marketing Notifications Job
// Runs every 30 minutes:
//   - If 1+ male is online → notify all females
//   - If 1+ female has isAvailable=true → notify all males
// 30-minute throttle per direction to prevent spam
// Completely isolated — does not touch any existing call/socket/billing logic
// ============================================================================

import { getFirestore, admin } from '../../config/firebase.js';
import { logger } from '../../utils/logger.js';

// In-memory throttle state (resets on server restart — acceptable tradeoff)
let lastMaleOnlineNotifSent = 0;      // Last time we notified FEMALES about male being online
let lastFemaleAvailableNotifSent = 0; // Last time we notified MALES about female being available
const THROTTLE_MS = 30 * 60 * 1000;   // 30 minutes
const JOB_INTERVAL_MS = 30 * 60 * 1000; // Run check every 30 minutes

const FCM_BATCH_SIZE = 500; // Firebase sendEachForMulticast limit per batch

let marketingJobId = null;

// ============================================================================
// Helpers
// ============================================================================

/**
 * Check if at least one female user has isAvailable=true in Firestore.
 */
async function hasAtLeastOneFemaleAvailable() {
  try {
    const db = getFirestore();
    if (!db) return false;
    const snap = await db.collection('users')
      .where('gender', '==', 'female')
      .where('isAvailable', '==', true)
      .limit(1)
      .get();
    return !snap.empty;
  } catch (err) {
    logger.error(`Marketing job: failed to check available females: ${err.message}`);
    return false;
  }
}

/**
 * Collect all FCM tokens for a given gender from Firestore.
 */
async function getFcmTokensForGender(gender) {
  const tokens = [];
  try {
    const db = getFirestore();
    if (!db) return tokens;
    const snap = await db.collection('users')
      .where('gender', '==', gender)
      .get();
    snap.docs.forEach(doc => {
      const data = doc.data();
      const token = data?.fcmToken;
      if (token && typeof token === 'string' && token.length > 0) {
        tokens.push(token);
      }
    });
  } catch (err) {
    logger.error(`Marketing job: failed to fetch ${gender} FCM tokens: ${err.message}`);
  }
  return tokens;
}

/**
 * Send a marketing notification to an array of FCM tokens in batches.
 */
async function sendMarketingNotification(tokens, title, body, dataType) {
  if (!tokens || tokens.length === 0) {
    logger.info(`Marketing notification (${dataType}): no tokens to send to`);
    return { successCount: 0, failureCount: 0 };
  }

  const messaging = admin.messaging();
  if (!messaging) {
    logger.error('Marketing notification: FCM messaging not initialized');
    return { successCount: 0, failureCount: tokens.length };
  }

  let totalSuccess = 0;
  let totalFailure = 0;

  for (let i = 0; i < tokens.length; i += FCM_BATCH_SIZE) {
    const batch = tokens.slice(i, i + FCM_BATCH_SIZE);
    const message = {
      tokens: batch,
      notification: { title, body },
      data: {
        type: dataType,
        timestamp: new Date().toISOString(),
      },
      android: {
        priority: 'high',
        notification: {
          channelId: 'tingatalk_marketing',
          priority: 'high',
          defaultSound: true,
        },
      },
      apns: {
        headers: { 'apns-priority': '10' },
        payload: {
          aps: {
            alert: { title, body },
            sound: 'default',
            'mutable-content': 1,
          },
        },
      },
    };

    try {
      const response = await messaging.sendEachForMulticast(message);
      totalSuccess += response.successCount;
      totalFailure += response.failureCount;
    } catch (err) {
      logger.error(`Marketing notification (${dataType}) batch failed: ${err.message}`);
      totalFailure += batch.length;
    }
  }

  logger.info(`Marketing notification (${dataType}) sent: success=${totalSuccess}, failed=${totalFailure}, totalTokens=${tokens.length}`);
  return { successCount: totalSuccess, failureCount: totalFailure };
}

// ============================================================================
// Main check function
// ============================================================================

async function runMarketingCheck() {
  const now = Date.now();
  logger.info('Marketing notification check running...');

  // ---- Direction 1: Notify FEMALES (always, every 30 min — Option D) ----
  // Asymmetry rationale: tracking active males in real-time is unreliable
  // (in-memory socket state misses backgrounded males with FCM-reachability).
  // The client opted for time-based marketing instead — fire every 30 min
  // regardless of who is currently connected. Throttle still applies.
  try {
    if (now - lastMaleOnlineNotifSent >= THROTTLE_MS) {
      logger.info('Marketing: time-based fire — preparing notification to females');
      const femaleTokens = await getFcmTokensForGender('female');
      if (femaleTokens.length > 0) {
        await sendMarketingNotification(
          femaleTokens,
          'TingaTalk',
          'Users are active on TingaTalk! Go online to receive calls',
          'marketing_male_online'
        );
        lastMaleOnlineNotifSent = now;
      } else {
        logger.info('Marketing: no female FCM tokens available');
      }
    } else {
      const waitMin = Math.ceil((THROTTLE_MS - (now - lastMaleOnlineNotifSent)) / 60000);
      logger.info(`Marketing: female notification throttled (wait ${waitMin}min)`);
    }
  } catch (err) {
    logger.error(`Marketing check (males→females) failed: ${err.message}`);
  }

  // ---- Direction 2: Notify MALES when female is available ----
  try {
    if (now - lastFemaleAvailableNotifSent >= THROTTLE_MS) {
      const anyFemaleAvailable = await hasAtLeastOneFemaleAvailable();
      if (anyFemaleAvailable) {
        logger.info('Marketing: female(s) available — preparing notification to males');
        const maleTokens = await getFcmTokensForGender('male');
        if (maleTokens.length > 0) {
          await sendMarketingNotification(
            maleTokens,
            'TingaTalk',
            'Females are available now! Start a call to connect',
            'marketing_female_available'
          );
          lastFemaleAvailableNotifSent = now;
        } else {
          logger.info('Marketing: no male FCM tokens available');
        }
      } else {
        logger.info('Marketing: no females available — skipping notification to males');
      }
    } else {
      const waitMin = Math.ceil((THROTTLE_MS - (now - lastFemaleAvailableNotifSent)) / 60000);
      logger.info(`Marketing: male notification throttled (wait ${waitMin}min)`);
    }
  } catch (err) {
    logger.error(`Marketing check (females→males) failed: ${err.message}`);
  }
}

// ============================================================================
// Start / Stop
// ============================================================================

export function startMarketingNotificationJob() {
  if (marketingJobId) {
    logger.warn('Marketing notification job already running');
    return;
  }
  // Run first check after initial delay so server is fully ready
  marketingJobId = setInterval(runMarketingCheck, JOB_INTERVAL_MS);
  logger.info(`Marketing notification job started (interval: ${JOB_INTERVAL_MS / 60000}min, throttle: ${THROTTLE_MS / 60000}min per direction)`);
}

export function stopMarketingNotificationJob() {
  if (marketingJobId) {
    clearInterval(marketingJobId);
    marketingJobId = null;
    logger.info('Marketing notification job stopped');
  }
}
