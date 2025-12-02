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
    this.messaging = null; // FCM Messaging instance
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

      // Initialize FCM Messaging
      this.messaging = admin.messaging();
      this.logger.info('✅ FCM Messaging initialized');

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
  // SOLUTION #3: Redis-based Distributed Locking for Call Initiation
  // Prevents race conditions when multiple calls target same recipient
  // ============================================================================

  /**
   * Acquire a lock for calling a specific recipient
   * @param {string} recipientId - The user being called
   * @param {string} callerId - The user making the call
   * @param {number} ttlSeconds - Lock expiry time (default 30s)
   * @returns {boolean} - True if lock acquired, false if recipient is already being called
   */
  async acquireCallLock(recipientId, callerId, ttlSeconds = 30) {
    try {
      const lockKey = `call_lock:${recipientId}`;
      // NX = only set if not exists, EX = expiry in seconds
      const result = await this.redis.set(lockKey, callerId, 'NX', 'EX', ttlSeconds);
      if (result === 'OK') {
        this.logger.info(`🔒 Call lock acquired for recipient ${recipientId} by caller ${callerId}`);
        return true;
      } else {
        // Check who holds the lock
        const currentHolder = await this.redis.get(lockKey);
        this.logger.warn(`🔒 Call lock DENIED for ${recipientId} - already locked by ${currentHolder}`);
        return false;
      }
    } catch (error) {
      this.logger.error(`❌ Error acquiring call lock: ${error.message}`);
      return false;
    }
  }

  /**
   * Release the call lock for a recipient
   * @param {string} recipientId - The user who was being called
   * @param {string} callerId - The caller who holds the lock (for verification)
   */
  async releaseCallLock(recipientId, callerId) {
    try {
      const lockKey = `call_lock:${recipientId}`;
      // Only release if we own the lock
      const currentHolder = await this.redis.get(lockKey);
      if (currentHolder === callerId) {
        await this.redis.del(lockKey);
        this.logger.info(`🔓 Call lock released for recipient ${recipientId}`);
        return true;
      } else {
        this.logger.warn(`⚠️ Cannot release lock for ${recipientId} - not owned by ${callerId}`);
        return false;
      }
    } catch (error) {
      this.logger.error(`❌ Error releasing call lock: ${error.message}`);
      return false;
    }
  }

  /**
   * Check if a recipient is currently locked (being called)
   * @param {string} recipientId - The user to check
   * @returns {string|null} - Caller ID if locked, null if not
   */
  async getCallLockHolder(recipientId) {
    try {
      const lockKey = `call_lock:${recipientId}`;
      return await this.redis.get(lockKey);
    } catch (error) {
      this.logger.error(`❌ Error checking call lock: ${error.message}`);
      return null;
    }
  }

  // ============================================================================
  // SOLUTION #8: Persist Call Timers to Redis (survive server crash)
  // ============================================================================

  /**
   * Save call timer state to Redis
   * @param {string} callId - Call identifier
   * @param {object} timerData - Timer data (startTime, callerId, recipientId, callType, coinRate)
   */
  async saveCallTimer(callId, timerData) {
    try {
      const timerKey = `call_timer:${callId}`;
      await this.redis.hset(timerKey, {
        startTime: timerData.startTime.toString(),
        callerId: timerData.callerId,
        recipientId: timerData.recipientId,
        callType: timerData.callType || 'audio',
        coinRate: timerData.coinRate.toString(),
        durationSeconds: (timerData.durationSeconds || 0).toString()
      });
      // Auto-expire after 4 hours (14400 seconds)
      await this.redis.expire(timerKey, 14400);
      this.logger.debug(`💾 Call timer saved to Redis: ${callId}`);
      return true;
    } catch (error) {
      this.logger.error(`❌ Error saving call timer to Redis: ${error.message}`);
      return false;
    }
  }

  /**
   * Get call timer from Redis
   * @param {string} callId - Call identifier
   */
  async getCallTimer(callId) {
    try {
      const timerKey = `call_timer:${callId}`;
      const data = await this.redis.hgetall(timerKey);
      if (!data || Object.keys(data).length === 0) {
        return null;
      }
      return {
        startTime: parseInt(data.startTime),
        callerId: data.callerId,
        recipientId: data.recipientId,
        callType: data.callType,
        coinRate: parseFloat(data.coinRate),
        durationSeconds: parseInt(data.durationSeconds) || 0
      };
    } catch (error) {
      this.logger.error(`❌ Error getting call timer from Redis: ${error.message}`);
      return null;
    }
  }

  /**
   * Update call timer duration in Redis
   * @param {string} callId - Call identifier
   * @param {number} durationSeconds - Current duration
   */
  async updateCallTimerDuration(callId, durationSeconds) {
    try {
      const timerKey = `call_timer:${callId}`;
      await this.redis.hset(timerKey, 'durationSeconds', durationSeconds.toString());
      return true;
    } catch (error) {
      this.logger.error(`❌ Error updating call timer duration: ${error.message}`);
      return false;
    }
  }

  /**
   * Delete call timer from Redis
   * @param {string} callId - Call identifier
   */
  async deleteCallTimer(callId) {
    try {
      const timerKey = `call_timer:${callId}`;
      await this.redis.del(timerKey);
      this.logger.debug(`🗑️ Call timer deleted from Redis: ${callId}`);
      return true;
    } catch (error) {
      this.logger.error(`❌ Error deleting call timer from Redis: ${error.message}`);
      return false;
    }
  }

  /**
   * Get all active call timers from Redis (for recovery after crash)
   */
  async getAllCallTimers() {
    try {
      const keys = await this.redis.keys('call_timer:*');
      const timers = {};
      for (const key of keys) {
        const callId = key.replace('call_timer:', '');
        const timerData = await this.getCallTimer(callId);
        if (timerData) {
          timers[callId] = timerData;
        }
      }
      return timers;
    } catch (error) {
      this.logger.error(`❌ Error getting all call timers: ${error.message}`);
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
      // PHASE 1 FIX: Support endReason and autoCompleted fields
      if (updates.endReason !== undefined) updateData.endReason = updates.endReason;
      if (updates.autoCompleted !== undefined) updateData.autoCompleted = updates.autoCompleted;

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

  // ============================================================================
  // SOLUTION #4: Atomic coin deduction using Firestore transactions
  // Prevents race conditions and ensures data consistency
  // ============================================================================

  /**
   * Atomically deduct coins from user wallet (for male users)
   * Uses Firestore transaction to prevent race conditions
   * @param {string} userId - User ID
   * @param {number} amount - Amount to deduct
   * @param {string} callId - Call ID for tracking
   * @returns {Promise<{success: boolean, newBalance?: number, error?: string}>}
   */
  async deductUserCoins(userId, amount, callId) {
    if (!this.firestore) {
      this.logger.warn('⚠️  Firestore not initialized, skipping coin deduction');
      return { success: false, error: 'Firestore not initialized' };
    }

    try {
      const userRef = this.firestore.collection('users').doc(userId);

      const result = await this.firestore.runTransaction(async (transaction) => {
        const userDoc = await transaction.get(userRef);

        if (!userDoc.exists) {
          throw new Error('User not found');
        }

        const data = userDoc.data();

        // Determine which field to use (prefer coinBalance, fallback to coins)
        const useNewField = data.coinBalance !== undefined;
        const balanceField = useNewField ? 'coinBalance' : 'coins';
        const currentBalance = data[balanceField] || 0;

        // Check if sufficient balance
        if (currentBalance < amount) {
          throw new Error(`Insufficient balance: has ${currentBalance}, needs ${amount}`);
        }

        const newBalance = currentBalance - amount;

        // Update balance atomically within transaction
        transaction.update(userRef, {
          [balanceField]: newBalance,
          lastSpendAt: admin.firestore.FieldValue.serverTimestamp(),
          lastCallId: callId
        });

        // Create spending record in transaction
        const spendingRef = this.firestore.collection('users').doc(userId).collection('spending').doc();
        transaction.set(spendingRef, {
          amount: amount,
          callId: callId,
          previousBalance: currentBalance,
          newBalance: newBalance,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          type: 'call_charge'
        });

        return { newBalance, previousBalance: currentBalance };
      });

      this.logger.info(`💸 Atomically deducted ${amount} coins from user ${userId}: ${result.previousBalance} → ${result.newBalance}`);
      return { success: true, newBalance: result.newBalance };

    } catch (error) {
      this.logger.error(`❌ Error deducting user coins (atomic): ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Atomically check balance and deduct coins in one operation
   * Use this when starting a call to prevent race conditions
   * @param {string} userId - User ID
   * @param {number} amount - Amount to deduct
   * @param {number} minRequired - Minimum balance required
   * @param {string} callId - Call ID for tracking
   * @returns {Promise<{success: boolean, newBalance?: number, error?: string}>}
   */
  async checkAndDeductCoins(userId, amount, minRequired, callId) {
    if (!this.firestore) {
      return { success: false, error: 'Firestore not initialized' };
    }

    try {
      const userRef = this.firestore.collection('users').doc(userId);

      const result = await this.firestore.runTransaction(async (transaction) => {
        const userDoc = await transaction.get(userRef);

        if (!userDoc.exists) {
          throw new Error('User not found');
        }

        const data = userDoc.data();
        const useNewField = data.coinBalance !== undefined;
        const balanceField = useNewField ? 'coinBalance' : 'coins';
        const currentBalance = data[balanceField] || 0;

        // Check minimum required balance
        if (currentBalance < minRequired) {
          throw new Error(`INSUFFICIENT_BALANCE: has ${currentBalance}, requires ${minRequired}`);
        }

        const newBalance = currentBalance - amount;

        // Reserve/deduct atomically
        transaction.update(userRef, {
          [balanceField]: newBalance,
          lastSpendAt: admin.firestore.FieldValue.serverTimestamp(),
          lastCallId: callId,
          lastCallStartBalance: currentBalance
        });

        // Log the transaction
        const spendingRef = this.firestore.collection('users').doc(userId).collection('spending').doc();
        transaction.set(spendingRef, {
          amount: amount,
          callId: callId,
          previousBalance: currentBalance,
          newBalance: newBalance,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          type: 'call_charge'
        });

        return { newBalance, previousBalance: currentBalance };
      });

      this.logger.info(`💰 Check+Deduct successful for ${userId}: ${result.previousBalance} → ${result.newBalance}`);
      return { success: true, newBalance: result.newBalance };

    } catch (error) {
      if (error.message.startsWith('INSUFFICIENT_BALANCE')) {
        this.logger.warn(`💰 Insufficient balance for ${userId}: ${error.message}`);
        return { success: false, error: 'INSUFFICIENT_BALANCE', message: error.message };
      }
      this.logger.error(`❌ Error in checkAndDeductCoins: ${error.message}`);
      return { success: false, error: error.message };
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
  // FCM PUSH NOTIFICATIONS
  // ============================================================================

  /**
   * Send FCM push notification for incoming call
   * @param {string} userId - Recipient user ID
   * @param {object} callData - Call details (callId, callerId, callerName, roomName, callType)
   * @returns {Promise<boolean>} - True if sent successfully
   */
  async sendIncomingCallNotification(userId, callData) {
    if (!this.messaging) {
      this.logger.warn('⚠️ FCM Messaging not initialized, cannot send notification');
      return false;
    }

    if (!this.firestore) {
      this.logger.warn('⚠️ Firestore not initialized, cannot get FCM token');
      return false;
    }

    try {
      // Get user's FCM token from Firestore
      const userDoc = await this.firestore.collection('users').doc(userId).get();

      if (!userDoc.exists) {
        this.logger.warn(`⚠️ User ${userId} not found in Firestore`);
        return false;
      }

      const userData = userDoc.data();
      const fcmToken = userData.fcmToken;

      if (!fcmToken) {
        this.logger.warn(`⚠️ No FCM token for user ${userId}`);
        return false;
      }

      this.logger.info(`📱 Sending FCM notification to user ${userId}`);
      this.logger.info(`📱 FCM Token: ${fcmToken.substring(0, 20)}...`);

      // Build the FCM message
      const message = {
        token: fcmToken,
        notification: {
          title: 'Incoming Call',
          body: `${callData.callerName || 'Someone'} is calling you...`,
        },
        data: {
          // Include both camelCase and snake_case for compatibility
          type: 'incoming_call',
          callId: callData.callId || '',
          call_id: callData.callId || '',
          callerId: callData.callerId || '',
          caller_id: callData.callerId || '',
          callerName: callData.callerName || 'Unknown',
          caller_name: callData.callerName || 'Unknown',
          roomName: callData.roomName || '',
          room_name: callData.roomName || '',
          callType: callData.callType || 'video',
          call_type: callData.callType || 'video',
          recipientId: userId,
          recipient_id: userId,
          timestamp: new Date().toISOString(),
        },
        android: {
          priority: 'high',
          ttl: 60000, // 60 seconds TTL
          notification: {
            channelId: 'incoming_calls',
            priority: 'max',
            defaultSound: true,
            defaultVibrateTimings: true,
            visibility: 'public',
            clickAction: 'FLUTTER_NOTIFICATION_CLICK',
          },
        },
        apns: {
          headers: {
            'apns-priority': '10', // High priority
            'apns-push-type': 'alert',
          },
          payload: {
            aps: {
              alert: {
                title: 'Incoming Call',
                body: `${callData.callerName || 'Someone'} is calling you...`,
              },
              sound: 'default',
              badge: 1,
              'content-available': 1,
              'mutable-content': 1,
              'interruption-level': 'time-sensitive',
            },
          },
        },
      };

      // Send the notification
      const response = await this.messaging.send(message);
      this.logger.info(`✅ FCM notification sent successfully: ${response}`);
      return true;

    } catch (error) {
      this.logger.error(`❌ FCM send error for user ${userId}:`, error.message);

      // Handle specific FCM errors
      if (error.code === 'messaging/invalid-registration-token' ||
          error.code === 'messaging/registration-token-not-registered') {
        this.logger.warn(`⚠️ Invalid/expired FCM token for user ${userId} - clearing token`);
        // Clear invalid token from Firestore
        try {
          await this.firestore.collection('users').doc(userId).update({
            fcmToken: admin.firestore.FieldValue.delete(),
            fcmTokenInvalidAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        } catch (clearError) {
          this.logger.error(`❌ Failed to clear invalid FCM token: ${clearError.message}`);
        }
      }

      return false;
    }
  }

  /**
   * Check if user has valid FCM token
   * @param {string} userId - User ID to check
   * @returns {Promise<boolean>} - True if user has FCM token
   */
  async hasValidFCMToken(userId) {
    if (!this.firestore) return false;

    try {
      const userDoc = await this.firestore.collection('users').doc(userId).get();
      if (!userDoc.exists) return false;

      const fcmToken = userDoc.data()?.fcmToken;
      return !!fcmToken && fcmToken.length > 0;
    } catch (error) {
      this.logger.error(`❌ Error checking FCM token for user ${userId}: ${error.message}`);
      return false;
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
