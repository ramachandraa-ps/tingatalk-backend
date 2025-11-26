// ============================================================================
// TingaTalk Scalability Module - Firebase + Redis
// Redis: Real-time state (ephemeral)
// Firestore: Persistent data (permanent)
// ============================================================================

const Redis = require('ioredis');
const { createAdapter } = require('@socket.io/redis-adapter');
const admin = require('firebase-admin');

class ScalabilityManager {
  constructor(logger) {
    this.logger = logger;
    this.redis = null;
    this.redisPub = null;
    this.redisSub = null;
    this.firestore = null;
    this.initialized = false;
  }

  // Initialize Firebase Admin SDK
  async initFirebase() {
    try {
      // Check if already initialized
      if (admin.apps.length > 0) {
        this.logger.info('✅ Firebase Admin already initialized');
        this.firestore = admin.firestore();
        return;
      }

      // Initialize with service account or default credentials
      if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        // Use service account JSON file
        const serviceAccount = require(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount),
          projectId: process.env.FIREBASE_PROJECT_ID || 'tingatalk-53057'
        });
        this.logger.info('✅ Firebase Admin initialized with service account');
      } else if (process.env.FIREBASE_PROJECT_ID) {
        // Use project ID only (for development)
        admin.initializeApp({
          projectId: process.env.FIREBASE_PROJECT_ID
        });
        this.logger.info('✅ Firebase Admin initialized with project ID');
      } else {
        // Default initialization
        admin.initializeApp({
          projectId: 'tingatalk-53057'
        });
        this.logger.info('✅ Firebase Admin initialized with default config');
      }

      this.firestore = admin.firestore();
      
      // Test connection
      await this.firestore.collection('_health_check').doc('test').set({
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        status: 'ok'
      });
      
      this.logger.info('✅ Firestore connection test successful');
      
    } catch (error) {
      this.logger.error('❌ Firebase initialization error:', error.message);
      // Continue without Firebase for now
      this.logger.warn('⚠️  Continuing without Firebase - some features may not work');
    }
  }

  // Initialize Redis connection
  async initRedis() {
    const redisConfig = {
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: parseInt(process.env.REDIS_PORT) || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
      retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
      maxRetriesPerRequest: 3,
      lazyConnect: false
    };

    this.redis = new Redis(redisConfig);
    this.redisPub = new Redis(redisConfig);
    this.redisSub = this.redisPub.duplicate();

    this.redis.on('connect', () => {
      this.logger.info('✅ Redis connected successfully');
    });

    this.redis.on('error', (err) => {
      this.logger.error('❌ Redis error:', err.message);
    });

    this.redis.on('ready', () => {
      this.logger.info('✅ Redis ready to accept commands');
    });

    // Test connection
    try {
      await this.redis.ping();
      this.logger.info('✅ Redis PING successful');
    } catch (error) {
      this.logger.error('❌ Redis PING failed:', error.message);
    }
  }

  // Setup Socket.IO Redis adapter
  setupSocketIOAdapter(io) {
    try {
      io.adapter(createAdapter(this.redisPub, this.redisSub));
      this.logger.info('✅ Socket.IO Redis adapter configured for clustering');
    } catch (error) {
      this.logger.error('❌ Failed to setup Socket.IO Redis adapter:', error.message);
    }
  }

  // ============================================================================
  // REDIS STATE MANAGEMENT (Ephemeral - Real-time)
  // ============================================================================

  async setUserStatus(userId, status) {
    try {
      await this.redis.hset('user_status', userId, JSON.stringify(status));
      return true;
    } catch (error) {
      this.logger.error(`❌ Error setting user status in Redis: ${error.message}`);
      return false;
    }
  }

  async getUserStatus(userId) {
    try {
      const data = await this.redis.hget('user_status', userId);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      this.logger.error(`❌ Error getting user status from Redis: ${error.message}`);
      return null;
    }
  }

  async deleteUserStatus(userId) {
    try {
      await this.redis.hdel('user_status', userId);
      return true;
    } catch (error) {
      this.logger.error(`❌ Error deleting user status from Redis: ${error.message}`);
      return false;
    }
  }

  async setActiveCall(callId, callData) {
    try {
      await this.redis.hset('active_calls', callId, JSON.stringify(callData));
      return true;
    } catch (error) {
      this.logger.error(`❌ Error setting active call in Redis: ${error.message}`);
      return false;
    }
  }

  async getActiveCall(callId) {
    try {
      const data = await this.redis.hget('active_calls', callId);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      this.logger.error(`❌ Error getting active call from Redis: ${error.message}`);
      return null;
    }
  }

  async deleteActiveCall(callId) {
    try {
      await this.redis.hdel('active_calls', callId);
      return true;
    } catch (error) {
      this.logger.error(`❌ Error deleting active call from Redis: ${error.message}`);
      return false;
    }
  }

  async setConnectedUser(userId, userData) {
    try {
      await this.redis.hset('connected_users', userId, JSON.stringify(userData));
      return true;
    } catch (error) {
      this.logger.error(`❌ Error setting connected user in Redis: ${error.message}`);
      return false;
    }
  }

  async getConnectedUser(userId) {
    try {
      const data = await this.redis.hget('connected_users', userId);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      this.logger.error(`❌ Error getting connected user from Redis: ${error.message}`);
      return null;
    }
  }

  async deleteConnectedUser(userId) {
    try {
      await this.redis.hdel('connected_users', userId);
      return true;
    } catch (error) {
      this.logger.error(`❌ Error deleting connected user from Redis: ${error.message}`);
      return false;
    }
  }

  // Get all connected users (for diagnostics)
  async getAllConnectedUsers() {
    try {
      const data = await this.redis.hgetall('connected_users');
      const users = {};
      for (const [userId, userData] of Object.entries(data)) {
        users[userId] = JSON.parse(userData);
      }
      return users;
    } catch (error) {
      this.logger.error(`❌ Error getting all connected users: ${error.message}`);
      return {};
    }
  }

  // ============================================================================
  // FIRESTORE OPERATIONS (Persistent - For Admin Panel)
  // ============================================================================

  async saveCallToFirestore(callData) {
    if (!this.firestore) {
      this.logger.warn('⚠️  Firestore not initialized, skipping call save');
      return false;
    }

    try {
      const callRef = this.firestore.collection('calls').doc(callData.callId);
      
      await callRef.set({
        callId: callData.callId,
        callerId: callData.callerId,
        recipientId: callData.recipientId,
        callType: callData.callType,
        roomName: callData.roomName || '',
        status: callData.status || 'initiated',
        coinRatePerSecond: callData.coinRate || 0,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        // Additional fields
        durationSeconds: callData.durationSeconds || 0,
        coinsDeducted: callData.coinsDeducted || 0
      }, { merge: true });
      
      this.logger.debug(`💾 Call ${callData.callId} saved to Firestore`);
      return true;
    } catch (error) {
      this.logger.error(`❌ Error saving call to Firestore: ${error.message}`);
      return false;
    }
  }

  async updateCallInFirestore(callId, updates) {
    if (!this.firestore) {
      this.logger.warn('⚠️  Firestore not initialized, skipping call update');
      return false;
    }

    try {
      const callRef = this.firestore.collection('calls').doc(callId);
      
      const updateData = {
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      };

      if (updates.durationSeconds !== undefined) updateData.durationSeconds = updates.durationSeconds;
      if (updates.coinsDeducted !== undefined) updateData.coinsDeducted = updates.coinsDeducted;
      if (updates.status !== undefined) updateData.status = updates.status;
      if (updates.endedAt !== undefined) updateData.endedAt = admin.firestore.Timestamp.fromDate(new Date(updates.endedAt));
      if (updates.serverDurationSeconds !== undefined) updateData.serverDurationSeconds = updates.serverDurationSeconds;
      if (updates.clientDurationSeconds !== undefined) updateData.clientDurationSeconds = updates.clientDurationSeconds;
      if (updates.isFraudulent !== undefined) updateData.isFraudulent = updates.isFraudulent;
      
      await callRef.update(updateData);
      
      this.logger.debug(`💾 Call ${callId} updated in Firestore`);
      return true;
    } catch (error) {
      this.logger.error(`❌ Error updating call in Firestore: ${error.message}`);
      return false;
    }
  }

  // Update user earnings (for female users)
  async updateUserEarnings(userId, amount, callId) {
    if (!this.firestore) {
      this.logger.warn('⚠️  Firestore not initialized, skipping earnings update');
      return false;
    }

    try {
      const userRef = this.firestore.collection('users').doc(userId);
      
      await userRef.set({
        totalEarnings: admin.firestore.FieldValue.increment(amount),
        lastEarningAt: admin.firestore.FieldValue.serverTimestamp(),
        lastCallId: callId
      }, { merge: true });
      
      // Also add to earnings history
      await this.firestore.collection('users').doc(userId).collection('earnings').add({
        amount: amount,
        callId: callId,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
      
      this.logger.debug(`💰 Updated earnings for user ${userId}: +${amount} coins`);
      return true;
    } catch (error) {
      this.logger.error(`❌ Error updating user earnings: ${error.message}`);
      return false;
    }
  }

  // Deduct coins from user wallet (for male users)
  async deductUserCoins(userId, amount, callId) {
    if (!this.firestore) {
      this.logger.warn('⚠️  Firestore not initialized, skipping coin deduction');
      return false;
    }

    try {
      const userRef = this.firestore.collection('users').doc(userId);

      // Get current document to check which field to use
      const userDoc = await userRef.get();
      const data = userDoc.data() || {};

      // Determine which field to update (prefer coinBalance, fallback to coins)
      const useNewField = data.coinBalance !== undefined;
      const balanceField = useNewField ? 'coinBalance' : 'coins';

      const updates = {
        [balanceField]: admin.firestore.FieldValue.increment(-amount),
        lastSpendAt: admin.firestore.FieldValue.serverTimestamp(),
        lastCallId: callId
      };

      await userRef.set(updates, { merge: true });

      // Add to spending history
      await this.firestore.collection('users').doc(userId).collection('spending').add({
        amount: amount,
        callId: callId,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });

      this.logger.debug(`💸 Deducted coins from user ${userId}: -${amount} coins (field: ${balanceField})`);
      return true;
    } catch (error) {
      this.logger.error(`❌ Error deducting user coins: ${error.message}`);
      return false;
    }
  }

  // Get user balance from Firestore
  async getUserBalance(userId) {
    if (!this.firestore) {
      return null;
    }

    try {
      const userDoc = await this.firestore.collection('users').doc(userId).get();
      if (userDoc.exists) {
        const data = userDoc.data();
        // Support both 'coinBalance' (new) and 'coins' (legacy) during migration
        return data.coinBalance || data.coins || 0;
      }
      return null;
    } catch (error) {
      this.logger.error(`❌ Error getting user balance: ${error.message}`);
      return null;
    }
  }

  // ============================================================================
  // INFRASTRUCTURE STATUS
  // ============================================================================

  async getStatus() {
    const status = {
      redis: 'unknown',
      firestore: 'unknown'
    };

    // Check Redis
    try {
      await this.redis.ping();
      status.redis = 'connected';
    } catch (error) {
      status.redis = 'error: ' + error.message;
    }

    // Check Firestore
    try {
      if (this.firestore) {
        await this.firestore.collection('_health_check').doc('test').get();
        status.firestore = 'connected';
      } else {
        status.firestore = 'not initialized';
      }
    } catch (error) {
      status.firestore = 'error: ' + error.message;
    }

    return status;
  }

  // Cleanup on shutdown
  async cleanup() {
    try {
      if (this.redis) await this.redis.quit();
      if (this.redisPub) await this.redisPub.quit();
      if (this.redisSub) await this.redisSub.quit();
      this.logger.info('✅ Scalability manager cleanup completed');
    } catch (error) {
      this.logger.error('❌ Error during cleanup:', error.message);
    }
  }
}

module.exports = ScalabilityManager;
