# TingaTalk Backend Restructure — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rewrite the monolithic 3731-line `server.js` into a modular feature-based Node.js/Express backend with zero API contract changes.

**Architecture:** Feature-based modules under `src/features/`, each with routes → controllers → services. Socket.IO handlers separated into `src/socket/`. Shared config, constants, errors, and middleware extracted into dedicated modules.

**Tech Stack:** Node.js (ES Modules), Express.js, Socket.IO, Firestore, Redis (ioredis), Twilio, Razorpay, Firebase Admin SDK, Vitest (tests), swagger-jsdoc + swagger-ui-express (docs).

**Reference files:**
- Current monolith: `server.js` (3731 lines)
- Scalability module: `scalability.js` (585 lines)
- Stats utility: `utils/stats_sync_util.js` (289 lines)
- Logger: `logger.js`
- PM2 config: `ecosystem.config.js`
- Package: `package.json`

---

## Phase 1: Project Foundation

### Task 1: Initialize project structure and update package.json

**Files:**
- Modify: `package.json`
- Create: `src/` directory tree
- Create: `.env.example`

**Step 1: Create directory structure**

Run:
```bash
mkdir -p src/{config,middleware,features/{auth,users,calls,payments,rewards,packages,availability,stats,payouts,diagnostics,health},socket/{handlers,state},shared,utils}
mkdir -p tests/{features,helpers}
```

**Step 2: Update package.json**

Change `package.json` to add `"type": "module"`, update scripts, and add new dependencies:

```json
{
  "name": "tingatalk-backend",
  "version": "2.0.0",
  "type": "module",
  "description": "Backend server for TingaTalk video calling app",
  "main": "src/server.js",
  "scripts": {
    "start": "node src/server.js",
    "dev": "nodemon src/server.js",
    "prod": "NODE_ENV=production node src/server.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "swagger:export": "node scripts/export-swagger.js",
    "pm2:start": "pm2 start ecosystem.config.cjs --env production",
    "pm2:stop": "pm2 stop tingatalk-backend",
    "pm2:restart": "pm2 restart tingatalk-backend",
    "pm2:logs": "pm2 logs tingatalk-backend",
    "pm2:status": "pm2 status",
    "build": "node --check src/server.js && echo 'Syntax check passed'"
  },
  "dependencies": {
    "@socket.io/redis-adapter": "^8.3.0",
    "axios": "^1.7.7",
    "cors": "^2.8.5",
    "dotenv": "^16.3.1",
    "express": "^4.18.2",
    "express-rate-limit": "^7.1.5",
    "firebase-admin": "^13.6.0",
    "helmet": "^7.1.0",
    "ioredis": "^5.8.2",
    "razorpay": "^2.9.3",
    "socket.io": "^4.7.5",
    "swagger-jsdoc": "^6.2.8",
    "swagger-ui-express": "^5.0.0",
    "twilio": "^4.19.0",
    "uuid": "^9.0.1"
  },
  "devDependencies": {
    "nodemon": "^3.0.2",
    "vitest": "^1.6.0"
  },
  "engines": {
    "node": ">=18.0.0"
  }
}
```

**Step 3: Create .env.example**

```env
# Server
PORT=3000
HOST=0.0.0.0
NODE_ENV=development

# Firebase
FIREBASE_PROJECT_ID=tingatalk-53057
FIREBASE_SERVICE_ACCOUNT=./path-to-service-account.json

# Redis
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASSWORD=

# Twilio
TWILIO_ACCOUNT_SID=
TWILIO_API_KEY_SID=
TWILIO_API_KEY_SECRET=

# Razorpay
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAYX_ACCOUNT_NUMBER=

# Admin
ADMIN_API_KEY=

# Security
CORS_ORIGIN=https://api.tingatalk.in,https://tingatalk.in
TRUST_PROXY=false
HELMET_ENABLED=true

# Rate Limiting
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100

# Clustering
ENABLE_CLUSTERING=false
INSTANCE_ID=0

# Logging
LOG_LEVEL=info
ENABLE_DEBUG_LOGS=false
```

**Step 4: Commit**
```bash
git add -A && git commit -m "chore: initialize modular project structure"
```

---

### Task 2: Create shared constants and error classes

**Files:**
- Create: `src/shared/constants.js`
- Create: `src/shared/errors.js`
- Create: `src/shared/responseHelper.js`

**Step 1: Create `src/shared/constants.js`**

Port all hardcoded constants from `server.js` lines 409-427, 576, 254, 3435-3436, 3528:

```js
// Coin rates (server-side source of truth)
export const COIN_RATES = {
  audio: 0.2,   // coins per second
  video: 1.0    // coins per second
};

// Minimum call requirements
export const MIN_CALL_DURATION_SECONDS = 120;
export const MIN_BALANCE = {
  audio: COIN_RATES.audio * MIN_CALL_DURATION_SECONDS,  // 24 coins
  video: COIN_RATES.video * MIN_CALL_DURATION_SECONDS   // 120 coins
};

// Female earning rates (INR per second)
export const FEMALE_EARNING_RATES = {
  audio: 0.15,
  video: 0.80
};

// Coin packages
export const COIN_PACKAGES = {
  'starter_pack':  { id: 'starter_pack',  name: 'Starter Pack',  coinAmount: 100,  priceInRupees: 99,   discountPercent: 10, isPopular: false, isActive: true },
  'popular_pack':  { id: 'popular_pack',  name: 'Popular Pack',  coinAmount: 500,  priceInRupees: 399,  discountPercent: 20, isPopular: true,  isActive: true },
  'value_pack':    { id: 'value_pack',    name: 'Value Pack',    coinAmount: 1000, priceInRupees: 699,  discountPercent: 30, isPopular: false, isActive: true },
  'premium_pack':  { id: 'premium_pack',  name: 'Premium Pack',  coinAmount: 2500, priceInRupees: 1499, discountPercent: 25, isPopular: false, isActive: true }
};

// Daily rewards
export const DAILY_REWARD_COINS = 10;

// Timeouts
export const DISCONNECT_TIMEOUT_MS = 15000;       // 15 seconds
export const HEARTBEAT_TIMEOUT_MS = 60000;         // 60 seconds
export const HEARTBEAT_CHECK_INTERVAL_MS = 15000;  // 15 seconds
export const CALL_RING_TIMEOUT_MS = 30000;         // 30 seconds
export const FCM_CALL_TIMEOUT_MS = 60000;          // 60 seconds
export const TWILIO_TOKEN_TTL = 1800;              // 30 minutes

// Limits
export const MAX_CONCURRENT_CALLS = 1000;
export const MAX_BATCH_STATS_USERS = 50;
export const REDIS_CALL_TIMER_EXPIRY = 14400;      // 4 hours

// User statuses
export const USER_STATUS = {
  AVAILABLE: 'available',
  UNAVAILABLE: 'unavailable',
  BUSY: 'busy',
  RINGING: 'ringing',
  DISCONNECTED: 'disconnected'
};

// Call statuses
export const CALL_STATUS = {
  INITIATED: 'initiated',
  RINGING: 'ringing',
  PENDING_FCM: 'pending_fcm',
  ACCEPTED: 'accepted',
  ACTIVE: 'active',
  COMPLETED: 'completed',
  DECLINED: 'declined',
  ENDED: 'ended',
  CANCELLED: 'cancelled',
  TIMEOUT: 'timeout',
  TIMEOUT_HEARTBEAT: 'timeout_heartbeat',
  FAILED: 'failed',
  DISCONNECTED: 'disconnected'
};

// Ended call statuses (for checking if call is over)
export const ENDED_CALL_STATUSES = [
  'ended', 'declined', 'missed', 'cancelled', 'timeout', 'no_answer'
];
```

**Step 2: Create `src/shared/errors.js`**

```js
export class AppError extends Error {
  constructor(message, statusCode = 500, isOperational = true) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.name = this.constructor.name;
  }
}

export class AuthenticationError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, 401);
  }
}

export class AuthorizationError extends AppError {
  constructor(message = 'Access denied') {
    super(message, 403);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(message, 404);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Invalid input') {
    super(message, 400);
  }
}

export class InsufficientBalanceError extends AppError {
  constructor(currentBalance, requiredBalance) {
    super(`Insufficient balance. Have: ${currentBalance}, Need: ${requiredBalance}`, 400);
    this.currentBalance = currentBalance;
    this.requiredBalance = requiredBalance;
  }
}

export class ConcurrentCallError extends AppError {
  constructor(message = 'User is already in a call') {
    super(message, 409);
  }
}

export class DuplicatePaymentError extends AppError {
  constructor(existingData) {
    super('Payment already verified', 409);
    this.existingData = existingData;
  }
}
```

**Step 3: Create `src/shared/responseHelper.js`**

```js
export function success(res, data = {}, statusCode = 200) {
  return res.status(statusCode).json({
    success: true,
    ...data,
    timestamp: new Date().toISOString()
  });
}

export function error(res, message, statusCode = 500, details = null) {
  const response = { error: message };
  if (details && process.env.NODE_ENV === 'development') {
    response.details = details;
  }
  return res.status(statusCode).json(response);
}
```

**Step 4: Commit**
```bash
git add src/shared/ && git commit -m "feat: add shared constants, error classes, and response helpers"
```

---

### Task 3: Create config modules

**Files:**
- Create: `src/config/index.js`
- Create: `src/config/firebase.js`
- Create: `src/config/redis.js`
- Create: `src/config/razorpay.js`
- Create: `src/config/twilio.js`

**Step 1: Create `src/config/index.js`**

Extract from `server.js` lines 16-17, 87-89, 209-213, and env vars throughout:

```js
import 'dotenv/config';

export const config = {
  port: parseInt(process.env.PORT) || 3000,
  host: process.env.HOST || '0.0.0.0',
  nodeEnv: process.env.NODE_ENV || 'development',

  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID || 'tingatalk-53057',
    serviceAccountPath: process.env.FIREBASE_SERVICE_ACCOUNT || null
  },

  redis: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || undefined
  },

  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID,
    keySecret: process.env.RAZORPAY_KEY_SECRET,
    accountNumber: process.env.RAZORPAYX_ACCOUNT_NUMBER || ''
  },

  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    apiKeySid: process.env.TWILIO_API_KEY_SID,
    apiKeySecret: process.env.TWILIO_API_KEY_SECRET
  },

  admin: {
    apiKey: process.env.ADMIN_API_KEY
  },

  cors: {
    origins: process.env.CORS_ORIGIN
      ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
      : ['https://api.tingatalk.in', 'https://tingatalk.in']
  },

  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100
  },

  clustering: {
    enabled: process.env.ENABLE_CLUSTERING === 'true',
    instanceId: process.env.INSTANCE_ID || '0'
  },

  helmet: {
    enabled: process.env.HELMET_ENABLED !== 'false'
  },

  trustProxy: process.env.TRUST_PROXY === 'true',

  logging: {
    level: process.env.LOG_LEVEL || 'info',
    debugEnabled: process.env.ENABLE_DEBUG_LOGS === 'true' || process.env.NODE_ENV === 'development'
  }
};
```

**Step 2: Create `src/config/firebase.js`**

Port from `scalability.js` lines 23-73 and `server.js` line 13:

```js
import admin from 'firebase-admin';
import { config } from './index.js';
import { createRequire } from 'module';
import { logger } from '../utils/logger.js';

const require = createRequire(import.meta.url);

let firestore = null;
let messaging = null;

export async function initFirebase() {
  try {
    if (admin.apps.length > 0) {
      logger.info('Firebase Admin already initialized');
      firestore = admin.firestore();
      messaging = admin.messaging();
      return;
    }

    if (config.firebase.serviceAccountPath) {
      const serviceAccount = require(config.firebase.serviceAccountPath);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: config.firebase.projectId
      });
      logger.info('Firebase Admin initialized with service account');
    } else if (config.firebase.projectId) {
      admin.initializeApp({ projectId: config.firebase.projectId });
      logger.info('Firebase Admin initialized with project ID');
    } else {
      admin.initializeApp({ projectId: 'tingatalk-53057' });
      logger.info('Firebase Admin initialized with default config');
    }

    firestore = admin.firestore();
    messaging = admin.messaging();

    // Test connection
    await firestore.collection('_health_check').doc('test').set({
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      status: 'ok'
    });

    logger.info('Firestore connection test successful');
  } catch (error) {
    logger.error('Firebase initialization error:', error.message);
    logger.warn('Continuing without Firebase - some features may not work');
  }
}

export function getFirestore() { return firestore; }
export function getMessaging() { return messaging; }
export { admin };
```

**Step 3: Create `src/config/redis.js`**

Port from `scalability.js` lines 77-123:

```js
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

export function getRedis() { return redis; }
export function getRedisPub() { return redisPub; }
export function getRedisSub() { return redisSub; }

export function setupSocketIOAdapter(io) {
  try {
    io.adapter(createAdapter(redisPub, redisSub));
    logger.info('Socket.IO Redis adapter configured');
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
```

**Step 4: Create `src/config/razorpay.js`**

Port from `server.js` lines 87-115:

```js
import Razorpay from 'razorpay';
import axios from 'axios';
import crypto from 'crypto';
import { config } from './index.js';
import { logger } from '../utils/logger.js';

if (!config.razorpay.keyId || !config.razorpay.keySecret) {
  logger.error('FATAL: Missing Razorpay credentials. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET');
  process.exit(1);
}

export const razorpayClient = new Razorpay({
  key_id: config.razorpay.keyId,
  key_secret: config.razorpay.keySecret
});

export const razorpayApi = axios.create({
  baseURL: 'https://api.razorpay.com/v1',
  auth: {
    username: config.razorpay.keyId,
    password: config.razorpay.keySecret
  },
  timeout: 10000
});

export function verifyPaymentSignature(orderId, paymentId, signature) {
  const hmac = crypto.createHmac('sha256', config.razorpay.keySecret);
  hmac.update(`${orderId}|${paymentId}`);
  return hmac.digest('hex') === signature;
}
```

**Step 5: Create `src/config/twilio.js`**

Port from `server.js` lines 82-84, 429-474:

```js
import twilio from 'twilio';
import { config } from './index.js';
import { logger } from '../utils/logger.js';
import { TWILIO_TOKEN_TTL } from '../shared/constants.js';

const { accountSid, apiKeySid, apiKeySecret } = config.twilio;

if (!accountSid || !apiKeySid || !apiKeySecret) {
  logger.error('Missing Twilio credentials. Set TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET');
  process.exit(1);
}

const AccessToken = twilio.jwt.AccessToken;
const VideoGrant = AccessToken.VideoGrant;

export function generateAccessToken(identity, roomName, isVideo = true) {
  if (!identity || typeof identity !== 'string' || identity.length < 3) {
    throw new Error('Invalid identity: must be string with at least 3 characters');
  }
  if (!roomName || typeof roomName !== 'string' || roomName.length < 5) {
    throw new Error('Invalid roomName: must be string with at least 5 characters');
  }

  const token = new AccessToken(accountSid, apiKeySid, apiKeySecret, {
    identity,
    ttl: TWILIO_TOKEN_TTL
  });

  token.addGrant(new VideoGrant({ room: roomName }));

  logger.info(`Generated ${isVideo ? 'video' : 'audio'} token for ${identity} in room ${roomName}`);
  return token.toJwt();
}
```

**Step 6: Commit**
```bash
git add src/config/ && git commit -m "feat: add config modules for firebase, redis, razorpay, twilio"
```

---

### Task 4: Create logger and utils

**Files:**
- Create: `src/utils/logger.js`
- Create: `src/utils/statsSyncUtil.js`

**Step 1: Create `src/utils/logger.js`**

Port from `server.js` lines 30-57:

```js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logsDir = path.join(__dirname, '../../logs');

if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const logLevel = process.env.LOG_LEVEL || 'info';
const enableDebugLogs = process.env.ENABLE_DEBUG_LOGS === 'true' || process.env.NODE_ENV === 'development';

export const logger = {
  info: (message, ...args) => {
    if (logLevel === 'debug' || logLevel === 'info') {
      console.log(`[INFO] ${new Date().toISOString()} - ${message}`, ...args);
    }
  },
  debug: (message, ...args) => {
    if (enableDebugLogs && logLevel === 'debug') {
      console.log(`[DEBUG] ${new Date().toISOString()} - ${message}`, ...args);
    }
  },
  warn: (message, ...args) => {
    console.warn(`[WARN] ${new Date().toISOString()} - ${message}`, ...args);
  },
  error: (message, ...args) => {
    console.error(`[ERROR] ${new Date().toISOString()} - ${message}`, ...args);
  }
};
```

**Step 2: Create `src/utils/statsSyncUtil.js`**

Port from `utils/stats_sync_util.js` — convert from CommonJS class to ES Module class:

```js
import { logger } from './logger.js';

export class StatsSyncUtil {
  constructor(firestore) {
    this.firestore = firestore;
  }

  async getUserStatsWithFallback(userId) {
    try {
      const userDoc = await this.firestore.collection('users').doc(userId).get();
      if (!userDoc.exists) return this.getDefaultStats(userId);

      const userData = userDoc.data();
      const fallbackStats = {
        userId,
        rating: userData.rating || 0,
        totalCalls: userData.totalCallsReceived || 0,
        totalLikes: userData.totalLikes || 0,
        totalDislikes: userData.totalDislikes || 0,
        source: 'main_document'
      };

      try {
        const powerUpsSnapshot = await this.firestore
          .collection('users').doc(userId).collection('powerups').get();

        if (!powerUpsSnapshot.empty) {
          let totalLikes = 0, totalDislikes = 0;
          const totalCalls = powerUpsSnapshot.docs.length;

          powerUpsSnapshot.docs.forEach(doc => {
            const data = doc.data();
            if (data.like === true) totalLikes++;
            if (data.dislike === true) totalDislikes++;
          });

          const rating = totalCalls > 0
            ? parseFloat(((totalLikes / totalCalls) * 10).toFixed(1))
            : 0;

          const freshStats = { userId, rating, totalCalls, totalLikes, totalDislikes, source: 'powerups_subcollection' };
          this.updateMainDocumentStats(userId, freshStats).catch(err =>
            logger.error(`Failed to update main document stats: ${err.message}`)
          );
          return freshStats;
        }
        return fallbackStats;
      } catch (subcollectionError) {
        logger.warn(`PowerUps query failed for ${userId}: ${subcollectionError.message}`);
        return fallbackStats;
      }
    } catch (error) {
      logger.error(`Error getting user stats for ${userId}: ${error.message}`);
      return this.getDefaultStats(userId);
    }
  }

  async updateMainDocumentStats(userId, stats) {
    await this.firestore.collection('users').doc(userId).update({
      rating: stats.rating,
      totalCallsReceived: stats.totalCalls,
      totalLikes: stats.totalLikes,
      totalDislikes: stats.totalDislikes,
      lastStatsUpdate: new Date(),
      statsSource: stats.source
    });
  }

  getDefaultStats(userId) {
    return { userId, rating: 0, totalCalls: 0, totalLikes: 0, totalDislikes: 0, source: 'default' };
  }

  async validateStatsConsistency(userId) {
    try {
      const mainDocStats = await this.getStatsFromMainDocument(userId);
      const subcollectionStats = await this.getStatsFromSubcollection(userId);
      if (!mainDocStats || !subcollectionStats) return false;

      const ratingDiff = Math.abs(mainDocStats.rating - subcollectionStats.rating);
      const callsDiff = Math.abs(mainDocStats.totalCalls - subcollectionStats.totalCalls);
      const likesDiff = Math.abs(mainDocStats.totalLikes - subcollectionStats.totalLikes);

      const isConsistent = ratingDiff < 0.5 && callsDiff <= 2 && likesDiff <= 2;
      if (!isConsistent) {
        logger.warn(`Stats inconsistency for ${userId}: main=${JSON.stringify(mainDocStats)}, sub=${JSON.stringify(subcollectionStats)}`);
      }
      return isConsistent;
    } catch (error) {
      logger.error(`Error validating stats consistency for ${userId}: ${error.message}`);
      return false;
    }
  }

  async getStatsFromMainDocument(userId) {
    const doc = await this.firestore.collection('users').doc(userId).get();
    if (!doc.exists) return null;
    const data = doc.data();
    return { userId, rating: data.rating || 0, totalCalls: data.totalCallsReceived || 0, totalLikes: data.totalLikes || 0, totalDislikes: data.totalDislikes || 0, source: 'main_document' };
  }

  async getStatsFromSubcollection(userId) {
    const snapshot = await this.firestore.collection('users').doc(userId).collection('powerups').get();
    if (snapshot.empty) return null;
    let totalLikes = 0, totalDislikes = 0;
    const totalCalls = snapshot.docs.length;
    snapshot.docs.forEach(doc => { const d = doc.data(); if (d.like === true) totalLikes++; if (d.dislike === true) totalDislikes++; });
    const rating = totalCalls > 0 ? parseFloat(((totalLikes / totalCalls) * 10).toFixed(1)) : 0;
    return { userId, rating, totalCalls, totalLikes, totalDislikes, source: 'powerups_subcollection' };
  }

  async batchUpdateStats(userIds) {
    const results = { success: [], failed: [], total: userIds.length };
    for (const userId of userIds) {
      try {
        const stats = await this.getUserStatsWithFallback(userId);
        if (stats.source !== 'default') {
          await this.updateMainDocumentStats(userId, stats);
          results.success.push(userId);
        } else {
          results.failed.push({ userId, error: 'No valid stats found' });
        }
      } catch (error) {
        results.failed.push({ userId, error: error.message });
      }
    }
    return results;
  }
}
```

**Step 3: Commit**
```bash
git add src/utils/ && git commit -m "feat: add logger and stats sync utility"
```

---

### Task 5: Create middleware

**Files:**
- Create: `src/middleware/auth.js`
- Create: `src/middleware/adminAuth.js`
- Create: `src/middleware/rateLimiter.js`
- Create: `src/middleware/errorHandler.js`

**Step 1: Create `src/middleware/auth.js`**

Port from `server.js` lines 120-141:

```js
import { admin } from '../config/firebase.js';
import { logger } from '../utils/logger.js';

export const authenticate = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization header' });
  }

  try {
    const idToken = authHeader.split('Bearer ')[1];
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.authenticatedUserId = decodedToken.uid;
    next();
  } catch (error) {
    logger.warn(`Auth failed: ${error.message}`);
    return res.status(401).json({ error: 'Invalid or expired auth token' });
  }
};
```

**Step 2: Create `src/middleware/adminAuth.js`**

Port from `server.js` lines 719-733:

```js
import { config } from '../config/index.js';

export const adminAuth = (req, res, next) => {
  const apiKey = req.headers['x-admin-api-key'];
  if (!config.admin.apiKey) {
    return res.status(503).json({ error: 'Admin API key not configured' });
  }
  if (apiKey !== config.admin.apiKey) {
    return res.status(403).json({ error: 'Invalid admin API key' });
  }
  next();
};
```

**Step 3: Create `src/middleware/rateLimiter.js`**

Port from `server.js` lines 209-213:

```js
import rateLimit from 'express-rate-limit';
import { config } from '../config/index.js';

export const apiLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.maxRequests,
  message: 'Too many requests from this IP, please try again later.'
});
```

**Step 4: Create `src/middleware/errorHandler.js`**

Port from `server.js` lines 3419-3431:

```js
import { AppError } from '../shared/errors.js';
import { logger } from '../utils/logger.js';

export const errorHandler = (err, req, res, next) => {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      error: err.message,
      ...(err.existingData && { data: err.existingData })
    });
  }

  logger.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    details: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
};

export const notFoundHandler = (req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
};
```

**Step 5: Commit**
```bash
git add src/middleware/ && git commit -m "feat: add authentication, rate limiting, and error handling middleware"
```

---

## Phase 2: Socket.IO Infrastructure

### Task 6: Create Connection Manager

**Files:**
- Create: `src/socket/state/connectionManager.js`

Port all global Maps and helper functions from `server.js` lines 239-404:

```js
import { logger } from '../../utils/logger.js';
import { getRedis } from '../../config/redis.js';
import { getFirestore, admin } from '../../config/firebase.js';

// In-memory state (synced to Redis)
const connectedUsers = new Map();   // userId -> { socketId, userType, connectedAt, isOnline }
const userStatus = new Map();       // userId -> { status, currentCallId, lastStatusChange, userPreference }
const activeCalls = new Map();      // callId -> { callId, callerId, recipientId, callType, ... }
const callTimers = new Map();       // callId -> { interval, startTime, durationSeconds, coinRate, ... }
const disconnectTimeouts = new Map(); // userId -> { timeoutId, disconnectedAt, userType }

// --- Connected Users ---
export function setConnectedUser(userId, userData) {
  connectedUsers.set(userId, userData);
  const redis = getRedis();
  if (redis) {
    redis.hset('connected_users', userId, JSON.stringify(userData)).catch(err =>
      logger.error(`Error syncing connected user to Redis: ${err.message}`)
    );
  }
}

export function getConnectedUser(userId) {
  return connectedUsers.get(userId);
}

export function deleteConnectedUser(userId) {
  connectedUsers.delete(userId);
  const redis = getRedis();
  if (redis) {
    redis.hdel('connected_users', userId).catch(err =>
      logger.error(`Error deleting connected user from Redis: ${err.message}`)
    );
  }
}

export function getAllConnectedUsers() {
  return connectedUsers;
}

// --- User Status ---
export function setUserStatus(userId, status) {
  userStatus.set(userId, status);
  const redis = getRedis();
  if (redis) {
    redis.hset('user_status', userId, JSON.stringify(status)).catch(err =>
      logger.error(`Error syncing user status to Redis: ${err.message}`)
    );
  }
}

export function getUserStatus(userId) {
  return userStatus.get(userId);
}

export function deleteUserStatus(userId) {
  userStatus.delete(userId);
  const redis = getRedis();
  if (redis) {
    redis.hdel('user_status', userId).catch(err =>
      logger.error(`Error deleting user status from Redis: ${err.message}`)
    );
  }
}

export function getAllUserStatuses() {
  return userStatus;
}

// --- Active Calls ---
export function setActiveCall(callId, callData) {
  activeCalls.set(callId, callData);
  const redis = getRedis();
  if (redis) {
    redis.hset('active_calls', callId, JSON.stringify(callData)).catch(err =>
      logger.error(`Error syncing call to Redis: ${err.message}`)
    );
  }
  // Also save to Firestore
  const db = getFirestore();
  if (db) {
    db.collection('calls').doc(callId).set({
      ...callData,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true }).catch(err =>
      logger.error(`Error saving call to Firestore: ${err.message}`)
    );
  }
}

export function getActiveCall(callId) {
  return activeCalls.get(callId);
}

export function deleteActiveCall(callId) {
  activeCalls.delete(callId);
  const redis = getRedis();
  if (redis) {
    redis.hdel('active_calls', callId).catch(err =>
      logger.error(`Error deleting call from Redis: ${err.message}`)
    );
  }
}

export function getAllActiveCalls() {
  return activeCalls;
}

export function completeCall(callId, updates) {
  deleteActiveCall(callId);
  const db = getFirestore();
  if (db) {
    const updateData = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    if (updates.durationSeconds !== undefined) updateData.durationSeconds = updates.durationSeconds;
    if (updates.coinsDeducted !== undefined) updateData.coinsDeducted = updates.coinsDeducted;
    if (updates.status !== undefined) updateData.status = updates.status;
    if (updates.endedAt !== undefined) updateData.endedAt = admin.firestore.Timestamp.fromDate(new Date(updates.endedAt));
    if (updates.endReason !== undefined) updateData.endReason = updates.endReason;
    Object.keys(updates).forEach(key => {
      if (!(key in updateData)) updateData[key] = updates[key];
    });
    db.collection('calls').doc(callId).update(updateData).catch(err =>
      logger.error(`Error updating call in Firestore: ${err.message}`)
    );
  }
}

// --- Call Timers ---
export function setCallTimer(callId, timerData) {
  callTimers.set(callId, timerData);
}

export function getCallTimer(callId) {
  return callTimers.get(callId);
}

export function deleteCallTimer(callId) {
  const timer = callTimers.get(callId);
  if (timer && timer.interval) {
    clearInterval(timer.interval);
  }
  callTimers.delete(callId);
}

export function getAllCallTimers() {
  return callTimers;
}

// --- Disconnect Timeouts ---
export function startDisconnectTimeout(userId, userType, io) {
  cancelDisconnectTimeout(userId);

  logger.info(`Starting disconnect timeout for ${userId} (${userType || 'unknown'})`);

  const timeoutId = setTimeout(async () => {
    const userConnection = connectedUsers.get(userId);
    if (userConnection && userConnection.isOnline) {
      logger.info(`User ${userId} has reconnected - NOT marking as unavailable`);
      disconnectTimeouts.delete(userId);
      return;
    }

    try {
      const db = getFirestore();
      if (db) {
        if (userType === 'female') {
          await db.collection('users').doc(userId).update({
            isAvailable: false,
            isOnline: false,
            lastSeenAt: new Date(),
            disconnectedAt: new Date(),
            forceClosedAt: new Date()
          });
          logger.info(`Female user ${userId} - BOTH isAvailable AND isOnline set to FALSE (force-close)`);

          io.emit('availability_changed', {
            femaleUserId: userId,
            isAvailable: false,
            isOnline: false,
            reason: 'force_close_detected',
            timestamp: new Date().toISOString()
          });
        } else {
          await db.collection('users').doc(userId).update({
            isOnline: false,
            lastSeenAt: new Date(),
            disconnectedAt: new Date()
          });
          io.emit('user_status_changed', {
            userId,
            isOnline: false,
            reason: 'disconnect_timeout',
            timestamp: new Date().toISOString()
          });
        }
      }
    } catch (error) {
      logger.error(`Error updating Firestore for ${userId} disconnect:`, error.message);
    }

    disconnectTimeouts.delete(userId);
  }, 15000); // DISCONNECT_TIMEOUT_MS

  disconnectTimeouts.set(userId, { timeoutId, disconnectedAt: new Date(), userType: userType || 'unknown' });
}

export function cancelDisconnectTimeout(userId) {
  const existing = disconnectTimeouts.get(userId);
  if (existing) {
    clearTimeout(existing.timeoutId);
    disconnectTimeouts.delete(userId);
    logger.info(`Cancelled disconnect timeout for ${userId} (reconnected)`);
  }
}

// --- Stats ---
export function getStats() {
  return {
    connectedUsers: connectedUsers.size,
    activeCalls: activeCalls.size,
    activeTimers: callTimers.size,
    busyUsers: Array.from(userStatus.values()).filter(s => s.status === 'busy').length,
    disconnectTimeouts: disconnectTimeouts.size
  };
}
```

**Step 2: Commit**
```bash
git add src/socket/ && git commit -m "feat: add connection manager with in-memory state + Redis sync"
```

---

### Task 7: Create Socket.IO handlers

**Files:**
- Create: `src/socket/index.js`
- Create: `src/socket/handlers/connection.handler.js`
- Create: `src/socket/handlers/call.handler.js`
- Create: `src/socket/handlers/heartbeat.handler.js`

**Step 1: Create `src/socket/index.js`**

Port Socket.IO setup from `server.js` lines 175-186:

```js
import { Server } from 'socket.io';
import { setupSocketIOAdapter } from '../config/redis.js';
import { logger } from '../utils/logger.js';
import { registerConnectionHandlers } from './handlers/connection.handler.js';
import { registerCallHandlers } from './handlers/call.handler.js';
import { registerHeartbeatHandlers } from './handlers/heartbeat.handler.js';

export function createSocketServer(httpServer, corsOptions) {
  const io = new Server(httpServer, {
    cors: corsOptions,
    transports: ['websocket', 'polling'],
    pingInterval: 25000,
    pingTimeout: 60000,
    connectTimeout: 45000,
    upgradeTimeout: 30000
  });

  setupSocketIOAdapter(io);

  io.on('connection', (socket) => {
    const clientIp = socket.handshake.address;
    logger.info(`User connected: ${socket.id} from ${clientIp}`);

    socket.emit('connected', {
      socketId: socket.id,
      timestamp: new Date().toISOString(),
      message: 'Connected to TingaTalk server'
    });

    registerConnectionHandlers(io, socket);
    registerCallHandlers(io, socket);
    registerHeartbeatHandlers(io, socket);
  });

  return io;
}
```

**Step 2: Create `src/socket/handlers/connection.handler.js`**

Port `join` and `disconnect` events from `server.js` lines 2442-3416:

```js
import { logger } from '../../utils/logger.js';
import { getFirestore } from '../../config/firebase.js';
import {
  setConnectedUser, getConnectedUser, getAllConnectedUsers,
  setUserStatus, getUserStatus,
  getActiveCall, getAllActiveCalls,
  getCallTimer, deleteCallTimer,
  startDisconnectTimeout, cancelDisconnectTimeout,
  completeCall
} from '../state/connectionManager.js';
import { COIN_RATES } from '../../shared/constants.js';

export function registerConnectionHandlers(io, socket) {

  socket.on('join', async (data) => {
    let userId, userType;

    if (typeof data === 'string') {
      userId = data;
      userType = 'unknown';
    } else if (typeof data === 'object' && data !== null) {
      userId = data.userId || data.user_id;
      userType = data.userType || data.user_type;
    } else {
      socket.emit('error', { message: 'Invalid join data format' });
      return;
    }

    if (!userId) {
      socket.emit('error', { message: 'User ID is required' });
      return;
    }

    cancelDisconnectTimeout(userId);

    // Handle existing connection
    const existingUser = getConnectedUser(userId);
    if (existingUser && existingUser.socketId !== socket.id) {
      const oldSocket = io.sockets.sockets.get(existingUser.socketId);
      if (oldSocket) {
        oldSocket.leave(`user_${userId}`);
        oldSocket.disconnect(true);
      }
    }

    setConnectedUser(userId, {
      socketId: socket.id,
      userType: userType || 'unknown',
      connectedAt: new Date(),
      isOnline: true
    });

    // Set user status from Firestore preference
    const currentStatus = getUserStatus(userId);
    if (!currentStatus || currentStatus.status === 'unavailable' || currentStatus.status === 'disconnected') {
      let savedPreference = true;
      try {
        const db = getFirestore();
        if (db) {
          const userDoc = await db.collection('users').doc(userId).get();
          if (userDoc.exists) {
            savedPreference = userDoc.data().isAvailable !== false;
          }
        }
      } catch (err) {
        logger.warn(`Could not load availability preference: ${err.message}`);
      }

      setUserStatus(userId, {
        status: savedPreference ? 'available' : 'unavailable',
        currentCallId: null,
        lastStatusChange: new Date(),
        userPreference: savedPreference
      });
    }

    // Join room
    socket.join(`user_${userId}`);

    // Update Firestore online status
    try {
      const db = getFirestore();
      if (db) {
        await db.collection('users').doc(userId).update({
          isOnline: true,
          lastSeenAt: new Date(),
          lastConnectedAt: new Date()
        });
      }
    } catch (err) {
      logger.warn(`Could not update online status in Firestore: ${err.message}`);
    }

    const userStatusObj = getUserStatus(userId);
    socket.emit('joined', {
      userId,
      userType: userType || 'unknown',
      status: userStatusObj?.status || 'available',
      socketId: socket.id,
      roomName: `user_${userId}`,
      success: true
    });

    logger.info(`User ${userId} (${userType || 'unknown'}) joined - Socket: ${socket.id}`);
  });

  socket.on('disconnect', async (reason) => {
    logger.info(`User disconnected: ${socket.id} - Reason: ${reason}`);

    const allUsers = getAllConnectedUsers();
    for (const [userId, user] of allUsers.entries()) {
      if (user.socketId !== socket.id) continue;

      user.isOnline = false;
      user.disconnectedAt = new Date();

      // Handle active call cleanup
      const currentStatus = getUserStatus(userId);
      if (currentStatus && currentStatus.currentCallId) {
        const callId = currentStatus.currentCallId;
        const call = getActiveCall(callId);

        if (call) {
          logger.warn(`User ${userId} disconnected during active call ${callId}`);

          // Notify other participants
          if (call.participants) {
            call.participants.forEach(pid => {
              if (pid !== userId) {
                const participant = getConnectedUser(pid);
                if (participant && participant.isOnline) {
                  io.to(participant.socketId).emit('participant_disconnected', {
                    callId, disconnectedUserId: userId, reason: 'User connection lost'
                  });
                }
                setUserStatus(pid, { status: 'available', currentCallId: null, lastStatusChange: new Date() });
              }
            });
          }

          // Complete call with billing
          const serverTimer = getCallTimer(callId);
          if (serverTimer) {
            clearInterval(serverTimer.interval);
            const durationSeconds = serverTimer.durationSeconds || 0;
            const coinRate = serverTimer.coinRate || COIN_RATES.audio;
            const coinsDeducted = Math.ceil(durationSeconds * coinRate);

            if (call.callerId && coinsDeducted > 0) {
              const { getFirestore, admin } = await import('../../config/firebase.js');
              const db = getFirestore();
              if (db) {
                // Deduct coins
                const userRef = db.collection('users').doc(call.callerId);
                const userDoc = await userRef.get();
                const data = userDoc.data() || {};
                const balanceField = data.coinBalance !== undefined ? 'coinBalance' : 'coins';
                await userRef.set({
                  [balanceField]: admin.firestore.FieldValue.increment(-coinsDeducted),
                  lastSpendAt: admin.firestore.FieldValue.serverTimestamp()
                }, { merge: true });
              }
            }

            completeCall(callId, {
              status: 'disconnected',
              endReason: 'connection_lost',
              disconnectedBy: userId,
              disconnectedAt: new Date().toISOString(),
              endedAt: new Date().toISOString(),
              durationSeconds,
              coinsDeducted
            });
            deleteCallTimer(callId);
          } else {
            completeCall(callId, {
              status: 'disconnected',
              endReason: 'connection_lost_before_connect',
              disconnectedBy: userId,
              disconnectedAt: new Date().toISOString(),
              endedAt: new Date().toISOString(),
              durationSeconds: 0,
              coinsDeducted: 0
            });
          }
        }
      }

      setUserStatus(userId, { status: 'disconnected', currentCallId: null, lastStatusChange: new Date() });

      // Female-specific immediate updates
      if (user.userType === 'female') {
        io.emit('user_disconnected', {
          disconnectedUserId: userId, userId, userType: 'female',
          timestamp: new Date().toISOString(), reason: 'websocket_disconnect'
        });

        try {
          const db = getFirestore();
          if (db) {
            await db.collection('users').doc(userId).update({
              isOnline: false, lastSeenAt: new Date(), disconnectedAt: new Date()
            });
            io.emit('user_status_changed', {
              femaleUserId: userId, isOnline: false, reason: 'disconnect',
              timestamp: new Date().toISOString()
            });
          }
        } catch (err) {
          logger.error(`Failed to update Firestore for female ${userId}:`, err.message);
        }
      }

      startDisconnectTimeout(userId, user.userType, io);
      break;
    }
  });
}
```

**Step 3: Create `src/socket/handlers/call.handler.js`**

Port `initiate_call`, `accept_call`, `decline_call`, `end_call`, `cancel_call` events from `server.js` lines 2569-3256. This is the largest handler — port the complete logic from `server.js` including FCM fallback, caller name resolution, busy/ringing checks, call timeouts, auto-start billing timer on accept.

**IMPORTANT:** This file should contain ALL the call event logic exactly as in the original `server.js`. Reference lines 2569-3256 for the complete implementation. Every edge case (FCM-reachable, busy check, ringing check, timeout, cancel, decline, end with participant notification) must be preserved.

**Step 4: Create `src/socket/handlers/heartbeat.handler.js`**

Port `call_ping` and `health_ping` events from `server.js` lines 3064-3113:

```js
import { logger } from '../../utils/logger.js';
import { getAllCallTimers } from '../state/connectionManager.js';

export function registerHeartbeatHandlers(io, socket) {

  socket.on('call_ping', (data) => {
    const { callId, userId, timestamp } = data;
    logger.debug(`Call ping received: callId=${callId}, userId=${userId}`);

    if (callId) {
      const timer = getAllCallTimers().get(callId);
      if (timer) timer.lastHeartbeat = Date.now();
    }

    socket.emit('call_pong', { callId, userId, serverTime: Date.now(), clientTime: timestamp });
  });

  socket.on('health_ping', (data) => {
    const { userId, timestamp } = data;
    logger.debug(`Health ping from: ${userId}`);

    getAllCallTimers().forEach((timer, callId) => {
      if (timer.callerId === userId || timer.recipientId === userId) {
        timer.lastHeartbeat = Date.now();
      }
    });

    socket.emit('health_pong', { userId, serverTime: Date.now(), clientTime: timestamp, status: 'alive' });
  });
}
```

**Step 5: Commit**
```bash
git add src/socket/ && git commit -m "feat: add Socket.IO server with connection, call, and heartbeat handlers"
```

---

## Phase 3: Feature Modules (REST API)

### Task 8: Health feature

**Files:**
- Create: `src/features/health/health.routes.js`

Port from `server.js` lines 481-521:

```js
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

  // Check infrastructure
  let redisStatus = 'unknown', firestoreStatus = 'unknown';
  try { const redis = getRedis(); if (redis) { await redis.ping(); redisStatus = 'connected'; } }
  catch (e) { redisStatus = 'error: ' + e.message; }
  try { const db = getFirestore(); if (db) { await db.collection('_health_check').doc('test').get(); firestoreStatus = 'connected'; } else { firestoreStatus = 'not initialized'; } }
  catch (e) { firestoreStatus = 'error: ' + e.message; }

  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    activeCalls: stats.activeCalls,
    connectedUsers: stats.connectedUsers,
    busyUsers: stats.busyUsers,
    clustering: { enabled: config.clustering.enabled, instanceId: config.clustering.instanceId, processId: process.pid },
    infrastructure: { redis: redisStatus, firestore: firestoreStatus },
    serverInfo: {
      port: config.port, host: config.host, nodeVersion: process.version,
      uptime: Math.floor(uptime),
      uptimeFormatted: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${Math.floor(uptime % 60)}s`,
      memoryUsage: {
        rss: Math.round(memoryUsage.rss / 1024 / 1024) + ' MB',
        heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024) + ' MB',
        heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024) + ' MB',
        external: Math.round(memoryUsage.external / 1024 / 1024) + ' MB'
      },
      environment: config.nodeEnv, pid: process.pid, platform: process.platform, arch: process.arch
    }
  });
});

export default router;
```

**Step 1: Commit**
```bash
git add src/features/health/ && git commit -m "feat: add health check endpoint"
```

---

### Task 9: Auth feature

Port from `server.js` lines 534-571.

### Task 10: Packages feature

Port from `server.js` lines 524-527.

### Task 11: Users feature

Port from `server.js` lines 1966-1997.

### Task 12: Availability feature

Port from `server.js` lines 1202-1701 — `check_availability`, `update_availability`, `get_available_females`. This is one of the larger features with complex Firestore queries, Socket.IO broadcasts, and stats enrichment.

### Task 13: Calls feature

Port from `server.js` lines 2000-2422 AND lines 1161-1199, 1297-1400, 1704-1801 — `calls/start`, `calls/complete`, `calls/heartbeat`, `call/:callId`, `check_call_status`, `validate_balance`, `generate_token`, `start_call_tracking` (legacy), `complete_call` (legacy).

**This is the largest feature.** Split into:
- `calls.routes.js` — All route definitions
- `calls.controller.js` — Request parsing, response sending
- `calls.service.js` — Balance validation, timer management, coin deduction, fraud detection, female earnings recording, spend transactions, admin analytics updates
- `calls.validators.js` — Input validation for call start/complete

### Task 14: Payments feature

Port from `server.js` lines 848-1056 — `payments/orders`, `payments/verify`. Includes atomic Firestore transactions, idempotency checks, admin analytics.

### Task 15: Rewards feature

Port from `server.js` lines 578-714 — `rewards/daily-claim`. Includes streak tracking, atomic Firestore transactions, double-claim prevention.

### Task 16: Payouts feature

Port from `server.js` lines 1059-1158 — `razorpay/contact-sync`, `female/payouts`.

### Task 17: Stats feature

Port from `server.js` lines 1877-1963 — `refresh_user_stats`, `batch_refresh_stats`.

### Task 18: Diagnostics feature

Port from `server.js` lines 736-845 — `diagnostic/connections`, `diagnostic/user/:userId`.

**For each task (9-18):**
1. Create `{feature}.routes.js` with route definitions
2. Create `{feature}.controller.js` with request handling
3. Create `{feature}.service.js` with business logic (where needed)
4. Commit after each feature

---

## Phase 4: Application Assembly

### Task 19: Create Express app (`src/app.js`)

**Files:**
- Create: `src/app.js`

Wire all middleware and feature routes together:

```js
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config/index.js';
import { authenticate } from './middleware/auth.js';
import { apiLimiter } from './middleware/rateLimiter.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

// Feature routes
import healthRoutes from './features/health/health.routes.js';
import authRoutes from './features/auth/auth.routes.js';
import packagesRoutes from './features/packages/packages.routes.js';
import usersRoutes from './features/users/users.routes.js';
import availabilityRoutes from './features/availability/availability.routes.js';
import callsRoutes from './features/calls/calls.routes.js';
import paymentsRoutes from './features/payments/payments.routes.js';
import rewardsRoutes from './features/rewards/rewards.routes.js';
import payoutsRoutes from './features/payouts/payouts.routes.js';
import statsRoutes from './features/stats/stats.routes.js';
import diagnosticsRoutes from './features/diagnostics/diagnostics.routes.js';

// Swagger
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './swagger.js';

const app = express();

// CORS config
const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (config.cors.origins.includes(origin) || config.cors.origins.includes('*')) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
  optionsSuccessStatus: 200
};

// Global middleware
app.set('trust proxy', config.trustProxy ? 1 : 0);

if (config.helmet.enabled) {
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        connectSrc: ["'self'", "wss:", "ws:"]
      }
    }
  }));
}

app.use(cors(corsOptions));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use('/api/', apiLimiter);

// Swagger docs
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Public routes (no auth)
app.use('/api/health', healthRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/packages', packagesRoutes);

// Protected routes (Firebase auth)
app.use('/api/user', authenticate, usersRoutes);
app.use('/api/payments', authenticate, paymentsRoutes);
app.use('/api/rewards', authenticate, rewardsRoutes);
app.use('/api/calls', authenticate, callsRoutes);
app.use('/api/razorpay', authenticate, payoutsRoutes);
app.use('/api/female', authenticate, payoutsRoutes);

// Protected standalone endpoints (auth applied in routes)
app.use('/api', authenticate, availabilityRoutes);
app.use('/api', authenticate, statsRoutes);
app.use('/api', authenticate, callsRoutes);  // Legacy endpoints

// Admin routes
app.use('/api/diagnostic', diagnosticsRoutes);

// Error handling
app.use(errorHandler);
app.use('*', notFoundHandler);

export { app, corsOptions };
```

**Note:** The exact route mounting will need fine-tuning during implementation to ensure legacy endpoint paths (`/api/validate_balance`, `/api/check_availability`, etc.) are preserved exactly.

---

### Task 20: Create server bootstrap (`src/server.js`)

**Files:**
- Create: `src/server.js`

```js
import http from 'http';
import { app, corsOptions } from './app.js';
import { config } from './config/index.js';
import { initFirebase } from './config/firebase.js';
import { initRedis } from './config/redis.js';
import { createSocketServer } from './socket/index.js';
import { startBackgroundJobs } from './backgroundJobs.js';
import { logger } from './utils/logger.js';
import { COIN_RATES, MIN_BALANCE } from './shared/constants.js';

const server = http.createServer(app);

// Initialize infrastructure
(async () => {
  try {
    await initRedis();
    await initFirebase();
    logger.info('Infrastructure initialized');
  } catch (error) {
    logger.error('Failed to initialize infrastructure:', error);
  }
})();

// Create Socket.IO server
const io = createSocketServer(server, corsOptions);

// Make io accessible to routes that need it (availability broadcast, etc.)
app.set('io', io);

// Start background jobs (heartbeat monitor, memory protection, timer recovery)
startBackgroundJobs(io);

// Start listening
server.listen(config.port, config.host, () => {
  logger.info(`TingaTalk Backend running on ${config.host}:${config.port}`);
  logger.info(`Coin rates: Audio ${COIN_RATES.audio}/s, Video ${COIN_RATES.video}/s`);
  logger.info(`Min balance: Audio ${MIN_BALANCE.audio}, Video ${MIN_BALANCE.video}`);
  logger.info(`Environment: ${config.nodeEnv}`);
  logger.info(`API docs: http://${config.host}:${config.port}/api/docs`);
});

// Graceful shutdown
const shutdown = (signal) => {
  logger.info(`${signal} received, shutting down gracefully`);
  const { getAllCallTimers } = await import('./socket/state/connectionManager.js');
  getAllCallTimers().forEach((timer, callId) => {
    clearInterval(timer.interval);
  });
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => { logger.error('Uncaught Exception:', err); process.exit(1); });
process.on('unhandledRejection', (reason) => { logger.error('Unhandled Rejection:', reason); process.exit(1); });
```

---

### Task 21: Create background jobs

**Files:**
- Create: `src/backgroundJobs.js`

Port from `server.js` lines 3433-3546 (heartbeat monitor, memory protection) and lines 3608-3728 (Redis timer recovery):

```js
import { logger } from './utils/logger.js';
import { getRedis } from './config/redis.js';
import { getFirestore, admin } from './config/firebase.js';
import {
  getAllCallTimers, deleteCallTimer, setUserStatus,
  getConnectedUser, deleteActiveCall, setActiveCall
} from './socket/state/connectionManager.js';
import { HEARTBEAT_TIMEOUT_MS, HEARTBEAT_CHECK_INTERVAL_MS, MAX_CONCURRENT_CALLS, COIN_RATES } from './shared/constants.js';

export function startBackgroundJobs(io) {
  // Heartbeat timeout monitor
  setInterval(async () => {
    const now = Date.now();
    const callEntries = Array.from(getAllCallTimers().entries());

    for (const [callId, timer] of callEntries) {
      if (!timer.lastHeartbeat) {
        timer.lastHeartbeat = Date.now();
        continue;
      }

      const timeSinceLastHeartbeat = now - timer.lastHeartbeat;
      if (timeSinceLastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
        logger.warn(`STALE CALL: ${callId} - No heartbeat for ${Math.round(timeSinceLastHeartbeat / 1000)}s`);

        clearInterval(timer.interval);
        const finalDuration = timer.durationSeconds;
        const coinsToDeduct = Math.ceil(finalDuration * timer.coinRate);

        try {
          const db = getFirestore();
          if (db && timer.callerId && coinsToDeduct > 0) {
            const userRef = db.collection('users').doc(timer.callerId);
            const userDoc = await userRef.get();
            const data = userDoc.data() || {};
            const field = data.coinBalance !== undefined ? 'coinBalance' : 'coins';
            await userRef.set({ [field]: admin.firestore.FieldValue.increment(-coinsToDeduct) }, { merge: true });
          }

          if (db) {
            await db.collection('calls').doc(callId).update({
              status: 'timeout_heartbeat', durationSeconds: finalDuration,
              coinsDeducted: coinsToDeduct, endedAt: new Date().toISOString(),
              endReason: 'No heartbeat received', updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
          }
        } catch (error) {
          logger.error(`Error closing stale call ${callId}: ${error.message}`);
        }

        deleteCallTimer(callId);
        deleteActiveCall(callId);

        setUserStatus(timer.callerId, { status: 'available', currentCallId: null, lastStatusChange: new Date() });
        setUserStatus(timer.recipientId, { status: 'available', currentCallId: null, lastStatusChange: new Date() });

        // Notify users
        const callerConn = getConnectedUser(timer.callerId);
        const recipientConn = getConnectedUser(timer.recipientId);
        const endPayload = { callId, endedBy: 'server', reason: 'Connection timeout', duration: finalDuration };
        if (callerConn) io.to(callerConn.socketId).emit('call_ended', endPayload);
        if (recipientConn) io.to(recipientConn.socketId).emit('call_ended', endPayload);
      }
    }
  }, HEARTBEAT_CHECK_INTERVAL_MS);

  // Memory protection
  setInterval(() => {
    const timers = getAllCallTimers();
    if (timers.size > MAX_CONCURRENT_CALLS) {
      logger.warn(`MEMORY WARNING: ${timers.size} call timers active (max: ${MAX_CONCURRENT_CALLS})`);
      const sorted = Array.from(timers.entries()).sort((a, b) => (a[1].startTime || 0) - (b[1].startTime || 0));
      sorted.slice(0, timers.size - MAX_CONCURRENT_CALLS).forEach(([callId, timer]) => {
        if (timer.interval) clearInterval(timer.interval);
        timers.delete(callId);
      });
    }
  }, 60000);

  // Redis timer recovery (5s delay for connection)
  setTimeout(async () => {
    const redis = getRedis();
    if (!redis) return;

    try {
      const keys = await redis.keys('call_timer:*');
      logger.info(`Found ${keys.length} call timers to recover from Redis`);

      for (const key of keys) {
        const timerData = await redis.hgetall(key);
        const callId = key.replace('call_timer:', '');
        const elapsed = Math.floor((Date.now() - parseInt(timerData.startTime)) / 1000);

        if (elapsed > 14400) {
          await redis.del(key);
          continue;
        }

        setActiveCall(callId, { ...timerData, startTime: parseInt(timerData.startTime), elapsedSeconds: elapsed, recovered: true });
        logger.info(`Recovered call timer: ${callId} (${elapsed}s elapsed)`);
      }
    } catch (error) {
      logger.error('Error recovering call timers:', error.message);
    }
  }, 5000);

  logger.info('Background jobs started');
}
```

---

## Phase 5: Swagger Documentation

### Task 22: Create Swagger/OpenAPI spec

**Files:**
- Create: `src/swagger.js`
- Create: `scripts/export-swagger.js`

**Step 1: Create `src/swagger.js`**

```js
import swaggerJsdoc from 'swagger-jsdoc';

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'TingaTalk Backend API',
      version: '2.0.0',
      description: 'Backend API for TingaTalk video/audio calling app with coin-based billing, Razorpay payments, and real-time Socket.IO signaling.'
    },
    servers: [
      { url: 'http://147.79.66.3:3000', description: 'Production VPS' },
      { url: 'http://localhost:3000', description: 'Local development' }
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'Firebase ID Token'
        },
        adminApiKey: {
          type: 'apiKey',
          in: 'header',
          name: 'X-Admin-API-Key'
        }
      }
    }
  },
  apis: ['./src/features/**/*.routes.js']
};

export const swaggerSpec = swaggerJsdoc(options);
```

**Step 2:** Add JSDoc swagger annotations to every route file. Each endpoint gets `@swagger` comments documenting path, method, parameters, request body, responses, and auth requirements.

**Step 3: Create `scripts/export-swagger.js`**

```js
import { writeFileSync } from 'fs';
import { dump } from 'js-yaml';  // Add js-yaml to dependencies
import { swaggerSpec } from '../src/swagger.js';

writeFileSync('docs/swagger.yaml', dump(swaggerSpec));
writeFileSync('docs/swagger.json', JSON.stringify(swaggerSpec, null, 2));
console.log('Swagger spec exported to docs/swagger.yaml and docs/swagger.json');
```

---

## Phase 6: Testing

### Task 23: Setup test infrastructure and write critical tests

**Files:**
- Create: `vitest.config.js`
- Create: `tests/setup.js`
- Create: `tests/helpers/mockFirestore.js`
- Create: `tests/features/payments.test.js`
- Create: `tests/features/calls.test.js`
- Create: `tests/features/health.test.js`

**Critical tests to include:**

1. **Payment signature verification** — correct HMAC passes, tampered fails
2. **Payment idempotency** — duplicate orderId returns existing, no double-credit
3. **Coin deduction (video)** — `duration × 1.0`
4. **Coin deduction (audio)** — `duration × 0.2`
5. **Balance validation (video)** — rejects < 120, accepts >= 120
6. **Balance validation (audio)** — rejects < 24, accepts >= 24
7. **Fraud detection** — flags when server vs client duration > 5s
8. **Daily reward cooldown** — rejects within 24h, accepts after
9. **Female earnings** — audio ₹0.15/sec, video ₹0.80/sec

---

## Phase 7: Deployment Preparation

### Task 24: Update PM2 config and prepare deployment

**Files:**
- Rename: `ecosystem.config.js` → `ecosystem.config.cjs` (CommonJS for PM2 compatibility with ESM project)
- Update script path to `src/server.js`

```js
// ecosystem.config.cjs
module.exports = {
  apps: [{
    name: 'tingatalk-backend',
    script: 'src/server.js',
    instances: 1,
    exec_mode: 'fork',
    env: { NODE_ENV: 'development', PORT: 3000 },
    env_production: { NODE_ENV: 'production', PORT: 3000 },
    max_memory_restart: '2G',
    node_args: '--max-old-space-size=2048',
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_file: './logs/combined.log',
    time: true,
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
    watch: false,
    ignore_watch: ['node_modules', 'logs'],
    kill_timeout: 5000,
    instance_var: 'INSTANCE_ID',
    merge_logs: true
  }]
};
```

### Task 25: End-to-end verification

**Verification checklist — run locally before deploying:**

1. `npm install` — all dependencies install
2. `npm run build` — syntax check passes
3. `npm test` — all critical tests pass
4. `npm start` — server starts, health endpoint responds
5. Verify ALL 25+ endpoints return correct JSON structure
6. Verify Socket.IO connection and `join` event
7. Verify `/api/docs` serves Swagger UI
8. `npm run swagger:export` — generates `docs/swagger.yaml`

### Task 26: Deploy to VPS

**Deployment steps:**
1. SSH into VPS: `ssh root@147.79.66.3`
2. Navigate to TingaTalk server directory
3. `git pull` latest code
4. `npm install` (adds new dependencies)
5. Test on port 3001: `PORT=3001 node src/server.js`
6. Smoke test all critical endpoints on port 3001
7. `pm2 stop tingatalk-backend`
8. `pm2 start ecosystem.config.cjs --env production`
9. `pm2 logs tingatalk-backend` — monitor for errors
10. Keep old `server.js` as rollback for 48 hours

---

## Task Dependency Graph

```
Phase 1 (Foundation):
  Task 1 → Task 2 → Task 3 → Task 4 → Task 5

Phase 2 (Socket.IO):
  Task 5 → Task 6 → Task 7

Phase 3 (Features) — can be parallelized after Task 6:
  Task 6 → Task 8  (health)
  Task 6 → Task 9  (auth)
  Task 6 → Task 10 (packages)
  Task 6 → Task 11 (users)
  Task 6 → Task 12 (availability)
  Task 6 → Task 13 (calls) — largest
  Task 6 → Task 14 (payments)
  Task 6 → Task 15 (rewards)
  Task 6 → Task 16 (payouts)
  Task 6 → Task 17 (stats)
  Task 6 → Task 18 (diagnostics)

Phase 4 (Assembly):
  Tasks 8-18 → Task 19 (app.js) → Task 20 (server.js) → Task 21 (background jobs)

Phase 5 (Docs):
  Task 19 → Task 22 (swagger)

Phase 6 (Tests):
  Tasks 13-14 → Task 23 (tests)

Phase 7 (Deploy):
  Tasks 20-23 → Task 24 (PM2) → Task 25 (verify) → Task 26 (deploy)
```

---

## Critical Edge Cases to Preserve

These are non-obvious behaviors in the current code that MUST be carried over:

1. **Dual balance field** — `coinBalance` vs `coins` (legacy). Always check which exists (`server.js:347-348`, `scalability.js:347`)
2. **FCM-reachable status** — Users with toggle ON but no WebSocket can receive calls via FCM push (`server.js:2667-2669`)
3. **Auto-start billing timer on accept** — If `/api/calls/start` wasn't called before `accept_call`, timer starts automatically (`server.js:2944-2996`)
4. **Legacy endpoint support** — `/api/start_call_tracking` and `/api/complete_call` must still work (`server.js:1749-1868`)
5. **Graceful fallback for missing timer** — `calls/complete` handles missing server timer by using client duration (`server.js:2151-2195`)
6. **Female disconnect preserves toggle** — On disconnect, only set `isOnline=false`, NOT `isAvailable=false` (`server.js:3377-3389`)
7. **Force-close detection** — Disconnect timeout sets BOTH `isAvailable` and `isOnline` to false for females (`server.js:3314-3323`)
8. **Streak tracking in daily rewards** — Track currentStreak, highestStreak, streakBroken, isFirstTime (`server.js:594-626`)
9. **Both camelCase and snake_case in FCM data** — Flutter expects both formats (`scalability.js:443-456`)
10. **Payment verify fetches packageId from Razorpay order notes** — Not from request body (`server.js:927-929`)
