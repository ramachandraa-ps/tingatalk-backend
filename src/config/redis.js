import Redis from 'ioredis';
import { createAdapter } from '@socket.io/redis-adapter';
import { config } from './index.js';
import { logger } from '../utils/logger.js';

let redis = null;
let redisPub = null;
let redisSub = null;

export async function initRedis() {
  const redisConfig = {
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password,
    retryStrategy: (times) => Math.min(times * 50, 2000),
    maxRetriesPerRequest: 3,
    lazyConnect: false
  };

  redis = new Redis(redisConfig);
  redisPub = new Redis(redisConfig);
  redisSub = redisPub.duplicate();

  redis.on('connect', () => logger.info('Redis connected successfully'));
  redis.on('error', (err) => logger.error('Redis error:', err.message));
  redis.on('ready', () => logger.info('Redis ready to accept commands'));

  try {
    await redis.ping();
    logger.info('Redis PING successful');
  } catch (error) {
    logger.error('Redis PING failed:', error.message);
  }
}

export function getRedis() {
  return redis;
}

export function getRedisPub() {
  return redisPub;
}

export function getRedisSub() {
  return redisSub;
}

export function setupSocketIOAdapter(io) {
  try {
    if (redisPub && redisSub) {
      io.adapter(createAdapter(redisPub, redisSub));
      logger.info('Socket.IO Redis adapter configured');
    }
  } catch (error) {
    logger.error('Failed to setup Socket.IO Redis adapter:', error.message);
  }
}

export async function cleanupRedis() {
  try {
    if (redis) await redis.quit();
    if (redisPub) await redisPub.quit();
    if (redisSub) await redisSub.quit();
    logger.info('Redis cleanup completed');
  } catch (error) {
    logger.error('Error during Redis cleanup:', error.message);
  }
}
