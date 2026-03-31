import { Router } from 'express';
import { getFirestore, admin } from '../../config/firebase.js';
import { logger } from '../../utils/logger.js';
import { DAILY_REWARD_COINS } from '../../shared/constants.js';

const router = Router();

/**
 * @openapi
 * /api/rewards/daily-claim:
 *   post:
 *     tags:
 *       - Rewards
 *     summary: Claim daily reward coins
 *     description: Claims the daily coin reward for the authenticated user. Tracks streaks (consecutive days claimed) and prevents double-claiming on the same UTC day using a Firestore transaction.
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Daily reward claimed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 coinsCredited:
 *                   type: integer
 *                 transactionId:
 *                   type: string
 *                 currentStreak:
 *                   type: integer
 *                 highestStreak:
 *                   type: integer
 *                 streakBroken:
 *                   type: boolean
 *                 isFirstTime:
 *                   type: boolean
 *                 newBalance:
 *                   type: number
 *                 nextClaimTime:
 *                   type: string
 *                   format: date-time
 *       400:
 *         description: Already claimed today
 *       401:
 *         description: Authentication required
 *       404:
 *         description: User not found
 *       500:
 *         description: Server error
 */
router.post('/daily-claim', async (req, res) => {
  // 🔒 Daily rewards feature is currently disabled by client request.
  // To re-enable: remove the early return below.
  return res.status(403).json({ success: false, message: 'Daily rewards are currently disabled' });

  try {
    const userId = req.authenticatedUserId;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const db = getFirestore();
    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return res.status(404).json({ error: 'User not found' });

    const userData = userDoc.data();
    const lastRewardAt = userData.lastDailyRewardAt;
    const currentStreak = userData.currentStreak || 0;
    const highestStreak = userData.highestStreak || 0;

    const now = new Date();
    const todayMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    let nextStreak = 1;
    let streakBroken = false;
    let isFirstTime = false;

    if (!lastRewardAt) {
      isFirstTime = true;
    } else {
      const lastDate = lastRewardAt.toDate ? lastRewardAt.toDate() : new Date(lastRewardAt);
      const lastMidnight = new Date(Date.UTC(lastDate.getUTCFullYear(), lastDate.getUTCMonth(), lastDate.getUTCDate()));

      if (lastMidnight.getTime() === todayMidnight.getTime()) {
        return res.status(400).json({
          error: 'Already claimed today',
          nextClaimTime: new Date(todayMidnight.getTime() + 86400000).toISOString()
        });
      }

      const yesterdayMidnight = new Date(todayMidnight.getTime() - 86400000);
      if (lastMidnight.getTime() === yesterdayMidnight.getTime()) {
        nextStreak = currentStreak + 1;
      } else {
        streakBroken = currentStreak > 0;
        nextStreak = 1;
      }
    }

    const transactionId = `daily_reward_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;
    const txnData = {
      id: transactionId, userId, type: 'bonus', status: 'success',
      coinAmount: DAILY_REWARD_COINS, description: 'Daily reward claimed',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      metadata: {
        rewardType: 'daily_reward', claimDate: todayMidnight.toISOString(),
        streak: nextStreak, streakBroken, isFirstTime
      }
    };

    const updateData = {
      coins: admin.firestore.FieldValue.increment(DAILY_REWARD_COINS),
      lastDailyRewardAt: admin.firestore.FieldValue.serverTimestamp(),
      totalDailyRewardsCollected: admin.firestore.FieldValue.increment(1),
      currentStreak: nextStreak,
      lastActiveAt: admin.firestore.FieldValue.serverTimestamp()
    };
    if (nextStreak > highestStreak) updateData.highestStreak = nextStreak;

    try {
      await db.runTransaction(async (t) => {
        const freshUserDoc = await t.get(userRef);
        const freshData = freshUserDoc.data();
        const freshLastReward = freshData.lastDailyRewardAt;

        if (freshLastReward) {
          const lastDate = freshLastReward.toDate ? freshLastReward.toDate() : new Date(freshLastReward);
          const lastMidnight = new Date(Date.UTC(lastDate.getUTCFullYear(), lastDate.getUTCMonth(), lastDate.getUTCDate()));
          if (lastMidnight.getTime() === todayMidnight.getTime()) {
            throw new Error('ALREADY_CLAIMED');
          }
        }

        t.set(db.collection('users').doc(userId).collection('transactions').doc(transactionId), txnData);
        t.update(userRef, updateData);
      });
    } catch (txnError) {
      if (txnError.message === 'ALREADY_CLAIMED') {
        return res.status(400).json({
          error: 'Already claimed today',
          nextClaimTime: new Date(todayMidnight.getTime() + 86400000).toISOString()
        });
      }
      throw txnError;
    }

    // Get updated balance
    const updatedDoc = await db.collection('users').doc(userId).get();
    const newBalance = updatedDoc.data()?.coins ?? 0;

    res.json({
      success: true, coinsCredited: DAILY_REWARD_COINS, transactionId,
      currentStreak: nextStreak, highestStreak: Math.max(nextStreak, highestStreak),
      streakBroken, isFirstTime, newBalance,
      nextClaimTime: new Date(todayMidnight.getTime() + 86400000).toISOString()
    });
  } catch (error) {
    logger.error('Error claiming daily reward:', error);
    res.status(500).json({ error: 'Failed to claim daily reward' });
  }
});

export default router;
