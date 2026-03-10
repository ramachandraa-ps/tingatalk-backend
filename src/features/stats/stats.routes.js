import { Router } from 'express';
import { getFirestore } from '../../config/firebase.js';
import { logger } from '../../utils/logger.js';
import { StatsSyncUtil } from '../../utils/statsSyncUtil.js';
import { MAX_BATCH_STATS_USERS } from '../../shared/constants.js';

const router = Router();

let statsSync = null;
function getStatsSync() {
  if (!statsSync) {
    const db = getFirestore();
    if (db) statsSync = new StatsSyncUtil(db);
  }
  return statsSync;
}

/**
 * @openapi
 * /api/refresh_user_stats:
 *   post:
 *     tags:
 *       - Stats
 *     summary: Refresh stats for a single user
 *     description: Fetches and returns the latest stats (rating, total calls, likes, dislikes) for a user, and runs a consistency check between data sources.
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - user_id
 *             properties:
 *               user_id:
 *                 type: string
 *     responses:
 *       200:
 *         description: User stats refreshed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 user_id:
 *                   type: string
 *                 stats:
 *                   type: object
 *                   properties:
 *                     rating:
 *                       type: number
 *                     totalCalls:
 *                       type: integer
 *                     totalLikes:
 *                       type: integer
 *                     totalDislikes:
 *                       type: integer
 *                     source:
 *                       type: string
 *                 consistency_check:
 *                   type: object
 *                   properties:
 *                     is_consistent:
 *                       type: boolean
 *                     checked_at:
 *                       type: string
 *                       format: date-time
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *       400:
 *         description: Missing user_id
 *       503:
 *         description: Stats sync service not available
 *       500:
 *         description: Server error
 */
router.post('/refresh_user_stats', async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });

    const sync = getStatsSync();
    if (!sync) return res.status(503).json({ error: 'Stats sync service not available' });

    const stats = await sync.getUserStatsWithFallback(user_id);
    const isConsistent = await sync.validateStatsConsistency(user_id);

    res.json({
      success: true, user_id,
      stats: {
        rating: stats.rating, totalCalls: stats.totalCalls,
        totalLikes: stats.totalLikes, totalDislikes: stats.totalDislikes,
        source: stats.source
      },
      consistency_check: { is_consistent: isConsistent, checked_at: new Date().toISOString() },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error in refresh_user_stats:', error);
    res.status(500).json({
      error: 'Failed to refresh user stats',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

/**
 * @openapi
 * /api/batch_refresh_stats:
 *   post:
 *     tags:
 *       - Stats
 *     summary: Batch refresh stats for multiple users
 *     description: Refreshes stats for multiple users in a single request. Limited to a maximum number of users per batch.
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - user_ids
 *             properties:
 *               user_ids:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Array of user IDs to refresh stats for
 *     responses:
 *       200:
 *         description: Batch stats refreshed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 batch_results:
 *                   type: object
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *       400:
 *         description: Missing or invalid user_ids array, or exceeds max batch size
 *       503:
 *         description: Stats sync service not available
 *       500:
 *         description: Server error
 */
router.post('/batch_refresh_stats', async (req, res) => {
  try {
    const { user_ids } = req.body;
    if (!user_ids || !Array.isArray(user_ids) || user_ids.length === 0) {
      return res.status(400).json({ error: 'user_ids array is required' });
    }
    if (user_ids.length > MAX_BATCH_STATS_USERS) {
      return res.status(400).json({ error: `Maximum ${MAX_BATCH_STATS_USERS} users allowed per batch` });
    }

    const sync = getStatsSync();
    if (!sync) return res.status(503).json({ error: 'Stats sync service not available' });

    const results = await sync.batchUpdateStats(user_ids);

    res.json({ success: true, batch_results: results, timestamp: new Date().toISOString() });
  } catch (error) {
    logger.error('Error in batch_refresh_stats:', error);
    res.status(500).json({
      error: 'Failed to batch refresh stats',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

export default router;
