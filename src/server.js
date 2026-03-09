// ============================================================================
// TingaTalk Server Bootstrap
// ============================================================================

import http from 'http';
import { config } from './config/index.js';
import { initFirebase } from './config/firebase.js';
import { initRedis, cleanupRedis } from './config/redis.js';
import { createApp } from './app.js';
import { createSocketServer } from './socket/index.js';
import { startBackgroundJobs, stopBackgroundJobs } from './backgroundJobs.js';
import { getAllCallTimers } from './socket/state/connectionManager.js';
import { logger } from './utils/logger.js';
import { COIN_RATES, MIN_BALANCE } from './shared/constants.js';

async function main() {
  // 1. Initialize infrastructure
  initFirebase();
  await initRedis();

  // 2. Create Express app
  const { app, corsOptions } = createApp();

  // 3. Create HTTP server
  const server = http.createServer(app);

  // 4. Attach Socket.IO
  const io = createSocketServer(server, corsOptions);

  // 5. Start background jobs (pass io for emitting events)
  startBackgroundJobs(io);

  // 6. Recover call timers from Redis (delayed to ensure connections are ready)
  setTimeout(async () => {
    const { recoverCallTimersFromRedis } = await import('./backgroundJobs.js');
    await recoverCallTimersFromRedis();
  }, 5000);

  // 7. Start listening
  server.listen(config.port, config.host, () => {
    logger.info(`TingaTalk Backend running on ${config.host}:${config.port}`);
    logger.info(`WebSocket server ready for connections`);
    logger.info(`Twilio integration enabled`);
    logger.info(`Coin rates: Audio ${COIN_RATES.audio}/s, Video ${COIN_RATES.video}/s`);
    logger.info(`Minimum balance: Audio ${MIN_BALANCE.audio} coins, Video ${MIN_BALANCE.video} coins`);
    logger.info(`CORS enabled for: ${config.cors.origins.join(', ')}`);
    logger.info(`Environment: ${config.nodeEnv}`);
    logger.info(`Process ID: ${process.pid}`);
  });

  // Graceful shutdown
  const gracefulShutdown = (signal) => {
    logger.info(`${signal} received, shutting down gracefully`);

    // Stop background jobs
    stopBackgroundJobs();

    // Clean up all call timers
    const timers = getAllCallTimers();
    timers.forEach((timer, callId) => {
      if (timer.interval) clearInterval(timer.interval);
      logger.info(`Stopped timer for call ${callId}`);
    });

    // Close Redis connections
    cleanupRedis();

    // Close HTTP server
    server.close(() => {
      logger.info('Server closed');
      process.exit(0);
    });

    // Force close after 10s
    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    logger.error('Uncaught Exception:', err);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
  });
}

main().catch((err) => {
  logger.error('Failed to start server:', err);
  process.exit(1);
});
