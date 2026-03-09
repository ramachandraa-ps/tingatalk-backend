import { Router } from 'express';
import { getStats } from '../../socket/state/connectionManager.js';
import { config } from '../../config/index.js';
import { getRedis } from '../../config/redis.js';
import { getFirestore } from '../../config/firebase.js';

const router = Router();

router.get('/', async (req, res) => {
  const memoryUsage = process.memoryUsage();
  const uptime = process.uptime();
  const stats = getStats();

  let redisStatus = 'unknown';
  let firestoreStatus = 'unknown';

  try {
    const redis = getRedis();
    if (redis) { await redis.ping(); redisStatus = 'connected'; }
  } catch (e) { redisStatus = 'error: ' + e.message; }

  try {
    const db = getFirestore();
    if (db) {
      await db.collection('_health_check').doc('test').get();
      firestoreStatus = 'connected';
    } else {
      firestoreStatus = 'not initialized';
    }
  } catch (e) { firestoreStatus = 'error: ' + e.message; }

  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    activeCalls: stats.activeCalls,
    connectedUsers: stats.connectedUsers,
    busyUsers: stats.busyUsers,
    clustering: {
      enabled: config.clustering.enabled,
      instanceId: config.clustering.instanceId,
      processId: process.pid
    },
    infrastructure: { redis: redisStatus, firestore: firestoreStatus },
    serverInfo: {
      port: config.port,
      host: config.host,
      nodeVersion: process.version,
      uptime: Math.floor(uptime),
      uptimeFormatted: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${Math.floor(uptime % 60)}s`,
      memoryUsage: {
        rss: Math.round(memoryUsage.rss / 1024 / 1024) + ' MB',
        heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024) + ' MB',
        heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024) + ' MB',
        external: Math.round(memoryUsage.external / 1024 / 1024) + ' MB'
      },
      environment: config.nodeEnv,
      pid: process.pid,
      platform: process.platform,
      arch: process.arch
    }
  });
});

export default router;
