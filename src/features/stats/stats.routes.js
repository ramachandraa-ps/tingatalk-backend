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
