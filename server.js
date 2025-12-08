const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const axios = require('axios');
require('dotenv').config();
// ============================================================================
// SCALABILITY: Redis + PostgreSQL + Clustering Support
// ============================================================================
const ScalabilityManager = require('./scalability');

// ============================================================================
// STATS SYNCHRONIZATION UTILITY
// ============================================================================
const StatsSyncUtil = require('./utils/stats_sync_util');

// Enhanced logging setup
const logLevel = process.env.LOG_LEVEL || 'info';
const enableDebugLogs = process.env.ENABLE_DEBUG_LOGS === 'true' || process.env.NODE_ENV === 'development';

// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Enhanced console logging
const logger = {
  info: (message, ...args) => {
    if (logLevel === 'debug' || logLevel === 'info') {
      console.log(`[INFO] ${new Date().toISOString()} - ${message}`, ...args);
    }
  },
  debug: (message, ...args) => {
    if (enableDebugLogs && (logLevel === 'debug')) {
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

// ============================================================================
// Initialize Scalability Manager
// ============================================================================
const scalability = new ScalabilityManager(logger);

// Initialize asynchronously (non-blocking)
let statsSync = null;
(async () => {
  try {
    await scalability.initRedis();
    await scalability.initFirebase();
    
    // Initialize stats sync utility
    statsSync = new StatsSyncUtil(scalability.firestore);
    
    logger.info('✅ Scalability infrastructure and stats sync initialized');
  } catch (error) {
    logger.error('❌ Failed to initialize scalability infrastructure:', error);
  }
})();


// Twilio configuration
const twilio = require('twilio');
const AccessToken = twilio.jwt.AccessToken;
const VideoGrant = AccessToken.VideoGrant;

// Razorpay configuration
const razorpayKeyId = process.env.RAZORPAY_KEY_ID || 'rzp_test_8DmfRFT3ZEhV7F';
const razorpayKeySecret = process.env.RAZORPAY_KEY_SECRET || 'UgQXen8uDJ3QeGVsLQBMM1ar';
const razorpayAccountNumber = process.env.RAZORPAYX_ACCOUNT_NUMBER || '2323230076543210';

if (!razorpayKeyId || !razorpayKeySecret) {
  logger.error('❌ Missing Razorpay credentials. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.');
}

const razorpayClient = new Razorpay({
  key_id: razorpayKeyId,
  key_secret: razorpayKeySecret,
});

const razorpayApi = axios.create({
  baseURL: 'https://api.razorpay.com/v1',
  auth: {
    username: razorpayKeyId,
    password: razorpayKeySecret,
  },
  timeout: 10000,
});

function verifyPaymentSignature(orderId, paymentId, signature) {
  const hmac = crypto.createHmac('sha256', razorpayKeySecret);
  hmac.update(`${orderId}|${paymentId}`);
  const digest = hmac.digest('hex');
  return digest === signature;
}

// Create Express app
const app = express();
const server = http.createServer(app);

// CORS configuration - Production ready with environment-based origins
const corsOptions = {
  origin: process.env.CORS_ORIGIN === '*' ? true : process.env.CORS_ORIGIN?.split(',').map(origin => origin.trim()) || true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
  optionsSuccessStatus: 200
};

// Socket.IO configuration with keepalive settings
// 🆕 ISSUE #14 FIX: Added pingTimeout and pingInterval to prevent premature disconnections
// - pingInterval: How often server sends ping to client (25 seconds)
// - pingTimeout: How long server waits for pong before disconnecting (60 seconds)
// Total time before disconnect = pingInterval + pingTimeout = 85 seconds
// This accommodates mobile networks with variable latency
const io = socketIo(server, {
  cors: corsOptions,
  transports: ['websocket', 'polling'],
  pingInterval: 25000,    // Send ping every 25 seconds
  pingTimeout: 60000, //  CRASH FIX: Reduced to 60s for faster disconnect detection
  connectTimeout: 45000,  // 45 seconds to establish connection
  upgradeTimeout: 30000,  // 30 seconds to upgrade from polling to websocket
});

// Setup Socket.IO Redis Adapter for clustering
scalability.setupSocketIOAdapter(io);

// Middleware
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : 0);

// Security middleware
if (process.env.HELMET_ENABLED !== 'false') {
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        connectSrc: ["'self'", "wss:", "ws:"],
      },
    },
  }));
}

app.use(cors(corsOptions));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  message: 'Too many requests from this IP, please try again later.'
});
app.use('/api/', limiter);

// ============================================================================
// PRODUCTION ENHANCEMENTS: Call State Management
// ============================================================================

// Store active calls and users (In production, use Redis)
const activeCalls = new Map();
const connectedUsers = new Map();

// 🆕 PRODUCTION FEATURE: User status tracking for concurrent call prevention
const userStatus = new Map(); // userId -> { status: 'available'|'unavailable'|'busy'|'ringing', currentCallId: string }

// 🆕 PRODUCTION FEATURE: Call timers for server-side duration tracking
const callTimers = new Map(); // callId -> { interval, startTime, durationSeconds }

// 🆕 DISCONNECT TIMEOUT: Auto-mark users unavailable after disconnect
// When user disconnects, start a timer. If they don't reconnect within timeout, set isAvailable=false
const disconnectTimeouts = new Map(); // userId -> { timeoutId, disconnectedAt, userType }
// 🔧 FORCE-CLOSE FIX: Reduced from 30s to 15s for faster force-close detection
// Flutter health check runs every 10s, so 15s timeout gives enough buffer for reconnection
// but detects force-close faster (15s instead of 30s)
const DISCONNECT_TIMEOUT_MS = 15000; // 15 seconds timeout before marking unavailable

// ============================================================================
// 🆕 REDIS + FIRESTORE WRAPPERS (Non-blocking, Cluster-Safe)
// ============================================================================
// These functions keep Maps in sync with Redis/Firestore without blocking execution

function setConnectedUserSync(userId, userData) {
  connectedUsers.set(userId, userData);
  scalability.setConnectedUser(userId, userData).catch(err => 
    logger.error(`Error syncing connected user to Redis: ${err.message}`)
  );
}

function deleteConnectedUserSync(userId) {
  connectedUsers.delete(userId);
  scalability.deleteConnectedUser(userId).catch(err =>
    logger.error(`Error deleting connected user from Redis: ${err.message}`)
  );
}

function setUserStatusSync(userId, status) {
  userStatus.set(userId, status);
  scalability.setUserStatus(userId, status).catch(err => 
    logger.error(`Error syncing user status to Redis: ${err.message}`)
  );
}

function deleteUserStatusSync(userId) {
  userStatus.delete(userId);
  scalability.deleteUserStatus(userId).catch(err =>
    logger.error(`Error deleting user status from Redis: ${err.message}`)
  );
}

// 🆕 DISCONNECT TIMEOUT HELPER FUNCTIONS
// Start disconnect timeout - will mark user unavailable after DISCONNECT_TIMEOUT_MS
function startDisconnectTimeout(userId, userType) {
  // Cancel any existing timeout for this user
  cancelDisconnectTimeout(userId);

  logger.info(`⏱️ Starting disconnect timeout for user ${userId} (${userType || 'unknown'}) - ${DISCONNECT_TIMEOUT_MS / 1000}s`);

  const timeoutId = setTimeout(async () => {
    logger.warn(`⏱️ Disconnect timeout expired for user ${userId} - Marking as unavailable in Firestore`);

    try {
      // Check if user has reconnected (if they have, the timeout would have been cancelled)
      const userConnection = connectedUsers.get(userId);
      if (userConnection && userConnection.isOnline) {
        logger.info(`✅ User ${userId} has reconnected - NOT marking as unavailable`);
        disconnectTimeouts.delete(userId);
        return;
      }

      // 🔧 FORCE-CLOSE FIX: If user hasn't reconnected after timeout, it means they force-closed the app
      // In this case, set BOTH isOnline AND isAvailable to false for female users
      // This prevents "ghost" cards from appearing on the male side
      const db = scalability.firestore;
      if (db) {
        if (userType === 'female') {
          // Female user force-closed: Set BOTH fields to false
          await db.collection('users').doc(userId).update({
            isAvailable: false,  // Turn off toggle - user force-closed app
            isOnline: false,     // User is offline
            lastSeenAt: new Date(),
            disconnectedAt: new Date(),
            forceClosedAt: new Date(),  // Track when force-close was detected
          });
          logger.info(`✅ Female user ${userId} - BOTH isAvailable AND isOnline set to FALSE (force-close detected)`);

          // Emit availability_changed so males remove the card immediately
          io.emit('availability_changed', {
            femaleUserId: userId,
            isAvailable: false,
            isOnline: false,
            reason: 'force_close_detected',
            timestamp: new Date().toISOString(),
          });
        } else {
          // Male or unknown user: Only set isOnline to false
          await db.collection('users').doc(userId).update({
            isOnline: false,
            lastSeenAt: new Date(),
            disconnectedAt: new Date(),
          });
          logger.info(`✅ User ${userId} - isOnline set to FALSE (disconnect timeout)`);

          io.emit('user_status_changed', {
            userId: userId,
            isOnline: false,
            reason: 'disconnect_timeout',
            timestamp: new Date().toISOString(),
          });
        }
      } else {
        logger.error(`❌ Firestore not available - cannot update user ${userId}`);
      }
    } catch (error) {
      logger.error(`❌ Error updating Firestore for user ${userId} disconnect timeout:`, error.message);
    }

    // Clean up the timeout entry
    disconnectTimeouts.delete(userId);
  }, DISCONNECT_TIMEOUT_MS);

  // Store the timeout info
  disconnectTimeouts.set(userId, {
    timeoutId,
    disconnectedAt: new Date(),
    userType: userType || 'unknown',
  });
}

// Cancel disconnect timeout (called when user reconnects)
function cancelDisconnectTimeout(userId) {
  const existingTimeout = disconnectTimeouts.get(userId);
  if (existingTimeout) {
    clearTimeout(existingTimeout.timeoutId);
    disconnectTimeouts.delete(userId);
    logger.info(`✅ Cancelled disconnect timeout for user ${userId} (reconnected)`);
  }
}

function setActiveCallSync(callId, callData) {
  activeCalls.set(callId, callData);
  // Sync to both Redis AND Firestore (non-blocking)
  scalability.setActiveCall(callId, callData).catch(err => 
    logger.error(`Error syncing call to Redis: ${err.message}`)
  );
  scalability.saveCallToFirestore(callData).catch(err => 
    logger.error(`Error saving call to Firestore: ${err.message}`)
  );
}

function deleteActiveCallSync(callId) {
  activeCalls.delete(callId);
  scalability.deleteActiveCall(callId).catch(err =>
    logger.error(`Error deleting call from Redis: ${err.message}`)
  );
}

// For call completion, we also update Firestore with final data
function completeCallSync(callId, updates) {
  // deleteActiveCallSync already handles Redis deletion
  deleteActiveCallSync(callId);
  // Only update Firestore with final data
  scalability.updateCallInFirestore(callId, updates).catch(err =>
    logger.error(`Error updating call in Firestore: ${err.message}`)
  );
}

logger.info('✅ Redis + Firestore sync wrappers initialized');

// 🆕 PRODUCTION FEATURE: Coin rates (server-side source of truth)
const COIN_RATES = {
  audio: 0.2,   // 0.2 coins per second
  video: 1.0    // 1.0 coin per second
};

// 🆕 PRODUCTION FEATURE: Minimum balance requirements (2 minutes)
const MIN_CALL_DURATION_SECONDS = 120;
const MIN_BALANCE_AUDIO = COIN_RATES.audio * MIN_CALL_DURATION_SECONDS;  // 24 coins
const MIN_BALANCE_VIDEO = COIN_RATES.video * MIN_CALL_DURATION_SECONDS;  // 120 coins

// Twilio credentials
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const apiKeySid = process.env.TWILIO_API_KEY_SID;
const apiKeySecret = process.env.TWILIO_API_KEY_SECRET;

// Validate Twilio credentials
if (!accountSid || !apiKeySid || !apiKeySecret) {
  logger.error('❌ Missing Twilio credentials in environment variables');
  logger.error('Please set TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, and TWILIO_API_KEY_SECRET');
  process.exit(1);
}

logger.info('✅ Twilio credentials loaded successfully');

// Generate Twilio Access Token - Enhanced Security
function generateSecureAccessToken(identity, roomName, isVideo = true) {
  try {
    // Validate inputs
    if (!identity || typeof identity !== 'string' || identity.length < 3) {
      throw new Error('Invalid identity: must be string with at least 3 characters');
    }
    
    if (!roomName || typeof roomName !== 'string' || roomName.length < 5) {
      throw new Error('Invalid roomName: must be string with at least 5 characters');
    }

    // Create an access token with shorter TTL for security
    const token = new AccessToken(accountSid, apiKeySid, apiKeySecret, {
      identity: identity,
      ttl: 1800 // 30 minutes
    });

    // Create video grant with room restriction
    const videoGrant = new VideoGrant({
      room: roomName
    });

    token.addGrant(videoGrant);

    logger.info(`🔑 Generated secure ${isVideo ? 'video' : 'audio'} token for ${identity} in room ${roomName}`);
    return token.toJwt();
  } catch (error) {
    logger.error('❌ Error generating secure access token:', error);
    throw error;
  }
}

// ============================================================================
// 🆕 PRODUCTION API ENDPOINTS
// ============================================================================

// Health check endpoint
app.get('/api/health', async (req, res) => {
  const memoryUsage = process.memoryUsage();
  const uptime = process.uptime();
  
  // Get scalability infrastructure status
  const infraStatus = await scalability.getStatus();
  
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    activeCalls: activeCalls.size,
    connectedUsers: connectedUsers.size,
    busyUsers: Array.from(userStatus.values()).filter(s => s.status === 'busy').length,
    clustering: {
      enabled: process.env.ENABLE_CLUSTERING === 'true',
      instanceId: process.env.INSTANCE_ID || 0,
      processId: process.pid
    },
    infrastructure: {
      redis: infraStatus.redis,
      firestore: infraStatus.firestore
    },
    serverInfo: {
      port: PORT,
      host: HOST,
      nodeVersion: process.version,
      uptime: Math.floor(uptime),
      uptimeFormatted: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${Math.floor(uptime % 60)}s`,
      memoryUsage: {
        rss: Math.round(memoryUsage.rss / 1024 / 1024) + ' MB',
        heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024) + ' MB',
        heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024) + ' MB',
        external: Math.round(memoryUsage.external / 1024 / 1024) + ' MB'
      },
      environment: process.env.NODE_ENV || 'development',
      pid: process.pid,
      platform: process.platform,
      arch: process.arch
    }
  });
});

// 🆕 DIAGNOSTIC ENDPOINT: Check Socket.IO connections and rooms
app.get('/api/diagnostic/connections', (req, res) => {
  try {
    const diagnostics = {
      timestamp: new Date().toISOString(),
      totalSocketsConnected: io.sockets.sockets.size,
      connectedUsers: [],
      userStatus: [],
      activeCalls: [],
      socketRooms: []
    };
    
    // Get all connected users
    for (const [userId, userData] of connectedUsers.entries()) {
      const socket = io.sockets.sockets.get(userData.socketId);
      const rooms = socket ? Array.from(socket.rooms) : [];
      
      diagnostics.connectedUsers.push({
        userId,
        socketId: userData.socketId,
        userType: userData.userType,
        isOnline: userData.isOnline,
        socketExists: !!socket,
        rooms: rooms,
        connectedAt: userData.connectedAt
      });
    }
    
    // Get all user statuses
    for (const [userId, status] of userStatus.entries()) {
      diagnostics.userStatus.push({
        userId,
        status: status.status,
        currentCallId: status.currentCallId,
        lastStatusChange: status.lastStatusChange
      });
    }
    
    // Get all active calls
    for (const [callId, call] of activeCalls.entries()) {
      diagnostics.activeCalls.push({
        callId: call.callId,
        callerId: call.callerId,
        recipientId: call.recipientId,
        status: call.status,
        callType: call.callType,
        createdAt: call.createdAt
      });
    }
    
    // Get all socket room memberships
    for (const [socketId, socket] of io.sockets.sockets.entries()) {
      diagnostics.socketRooms.push({
        socketId,
        rooms: Array.from(socket.rooms)
      });
    }
    
    res.json(diagnostics);
    
  } catch (error) {
    logger.error('❌ Error in diagnostic endpoint:', error);
    res.status(500).json({ 
      error: 'Failed to get diagnostics',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// 🆕 DIAGNOSTIC ENDPOINT: Check specific user connection
app.get('/api/diagnostic/user/:userId', (req, res) => {
  try {
    const { userId } = req.params;
    
    const userData = connectedUsers.get(userId);
    const userStatusData = userStatus.get(userId);
    
    if (!userData) {
      return res.status(404).json({
        error: 'User not found',
        userId,
        isConnected: false
      });
    }
    
    const socket = io.sockets.sockets.get(userData.socketId);
    const rooms = socket ? Array.from(socket.rooms) : [];
    
    res.json({
      userId,
      isConnected: true,
      socketId: userData.socketId,
      userType: userData.userType,
      socketExists: !!socket,
      rooms: rooms,
      expectedRoom: `user_${userId}`,
      isInExpectedRoom: rooms.includes(`user_${userId}`),
      status: userStatusData ? userStatusData.status : 'unknown',
      currentCallId: userStatusData ? userStatusData.currentCallId : null,
      connectedAt: userData.connectedAt,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    logger.error('❌ Error in user diagnostic endpoint:', error);
    res.status(500).json({ 
      error: 'Failed to get user diagnostics',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// Razorpay - create order for checkout
app.post('/api/payments/orders', async (req, res) => {
  try {
    const { amount, currency = 'INR', userId, userName, packageId, coins, receipt, notes } = req.body;
    if (!amount || !userId || !packageId) {
      return res.status(400).json({ error: 'amount, userId and packageId are required' });
    }

    const amountInPaise = Math.round(Number(amount) * 100);
    const order = await razorpayClient.orders.create({
      amount: amountInPaise,
      currency,
      receipt: receipt || `order_${Date.now()}`,
      payment_capture: 1,
      notes: {
        userId,
        userName: userName || 'TingaTalk User',
        packageId,
        coins: coins || '',
        ...notes,
      },
    });

    res.json({
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      key_id: razorpayKeyId,
    });
  } catch (error) {
    logger.error('❌ Error creating Razorpay order:', error);
    res.status(500).json({ error: 'Failed to create Razorpay order' });
  }
});

// Razorpay - verify payment signature
app.post('/api/payments/verify', (req, res) => {
  try {
    const { orderId, paymentId, signature, userId } = req.body;
    if (!orderId || !paymentId || !signature) {
      return res.status(400).json({ error: 'orderId, paymentId and signature are required' });
    }

    const isValid = verifyPaymentSignature(orderId, paymentId, signature);
    if (!isValid) {
      return res.status(400).json({ error: 'Invalid payment signature' });
    }

    const verificationId = `ver_${Date.now()}`;
    res.json({
      isValid: true,
      verificationId,
      paymentId,
      userId,
      verifiedAt: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('❌ Error verifying Razorpay payment:', error);
    res.status(500).json({ error: 'Payment verification failed' });
  }
});

// RazorpayX - create/update contact and fund account
app.post('/api/razorpay/contact-sync', async (req, res) => {
  try {
    const {
      userId,
      userName,
      phoneNumber,
      accountHolderName,
      accountNumber,
      ifsc,
      bankName,
      upiId,
      accountType = 'savings',
      existingContactId,
      existingFundAccountId,
    } = req.body;

    if (!userId || !accountHolderName || (!accountNumber && !upiId)) {
      return res.status(400).json({ error: 'Missing required payout fields' });
    }

    let contactId = existingContactId;
    if (!contactId) {
      const contact = await razorpayApi.post('/contacts', {
        name: userName || accountHolderName,
        contact: phoneNumber,
        type: 'employee',
        reference_id: userId,
      });
      contactId = contact.data.id;
    }

    let fundAccountId = existingFundAccountId;
    if (!fundAccountId) {
      const payload = upiId
          ? {
              contact_id: contactId,
              account_type: 'vpa',
              vpa: { address: upiId },
            }
          : {
              contact_id: contactId,
              account_type: 'bank_account',
              bank_account: {
                name: accountHolderName,
                account_number: accountNumber,
                ifsc,
                account_type: accountType,
              },
            };

      const fundAccount = await razorpayApi.post('/fund_accounts', payload);
      fundAccountId = fundAccount.data.id;
    }

    res.json({
      contactId,
      fundAccountId,
      status: 'verified',
    });
  } catch (error) {
    logger.error('❌ Error syncing Razorpay contact:', error.response?.data || error);
    res.status(500).json({
      error: 'Failed to sync payout details',
      details: error.response?.data || error.message,
    });
  }
});

// RazorpayX - trigger female payout
app.post('/api/female/payouts', async (req, res) => {
  try {
    const { fundAccountId, amount, currency = 'INR', userId, userName, purpose = 'payout' } = req.body;
    if (!fundAccountId || !amount) {
      return res.status(400).json({ error: 'fundAccountId and amount are required' });
    }

    const payout = await razorpayApi.post('/payouts', {
      account_number: razorpayAccountNumber,
      fund_account_id: fundAccountId,
      amount: Math.round(Number(amount) * 100),
      currency,
      mode: 'IMPS',
      purpose,
      queue_if_low_balance: true,
      narration: `TingaTalk payout ${userId || ''}`.trim(),
    });

    res.json({
      payoutId: payout.data.id,
      status: payout.data.status,
      referenceId: payout.data.reference_id || '',
    });
  } catch (error) {
    logger.error('❌ Error creating Razorpay payout:', error.response?.data || error);
    res.status(500).json({
      error: 'Failed to trigger payout',
      details: error.response?.data || error.message,
    });
  }
});

// 🆕 PRODUCTION ENDPOINT: Pre-call balance validation
app.post('/api/validate_balance', async (req, res) => {
  try {
    const { user_id, call_type, current_balance } = req.body;

    if (!user_id || !call_type || current_balance === undefined) {
      return res.status(400).json({ 
        error: 'Missing required fields: user_id, call_type, current_balance' 
      });
    }

    const isVideo = call_type === 'video';
    const requiredBalance = isVideo ? MIN_BALANCE_VIDEO : MIN_BALANCE_AUDIO;
    const coinRate = isVideo ? COIN_RATES.video : COIN_RATES.audio;

    const hasEnoughBalance = current_balance >= requiredBalance;

    logger.info(`💰 Balance validation for ${user_id}: ${current_balance} coins (required: ${requiredBalance})`);

    res.json({
      success: hasEnoughBalance,
      has_sufficient_balance: hasEnoughBalance,
      current_balance: current_balance,
      required_balance: requiredBalance,
      coin_rate_per_second: coinRate,
      minimum_duration_seconds: MIN_CALL_DURATION_SECONDS,
      call_type: call_type,
      message: hasEnoughBalance 
        ? 'Sufficient balance for call' 
        : `Insufficient balance. Need at least ${requiredBalance} coins for ${MIN_CALL_DURATION_SECONDS / 60} minutes`
    });

  } catch (error) {
    logger.error('❌ Error in /api/validate_balance:', error);
    res.status(500).json({ 
      error: 'Failed to validate balance',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// 🆕 PRODUCTION ENDPOINT: Check user availability (concurrent call prevention)
app.post('/api/check_availability', async (req, res) => {
  try {
    const { recipient_id } = req.body;

    if (!recipient_id) {
      return res.status(400).json({ error: 'Missing recipient_id' });
    }

    // 🔧 UNIFIED STATUS CHECK: Use only 'available' and 'unavailable'
    // Key principle: User must have BOTH active connection AND preference=available to receive calls
    const recipientStatus = userStatus.get(recipient_id);
    const recipientConnection = connectedUsers.get(recipient_id);

    let actualStatus = 'unavailable'; // Default: unavailable (can't receive calls)
    let currentCallId = null;
    let hasConnection = false;

    // STEP 1: Check if user has active WebSocket connection
    if (recipientConnection && recipientConnection.isOnline) {
      const socket = io.sockets.sockets.get(recipientConnection.socketId);

      if (socket && socket.connected) {
        hasConnection = true;

        // STEP 2: Check user's status/preference
        if (recipientStatus) {
          // Use status from userStatus Map (could be 'available', 'unavailable', 'busy', 'ringing')
          actualStatus = recipientStatus.status;
          currentCallId = recipientStatus.currentCallId;
        } else {
          // User connected but no status entry - load from Firestore
          try {
            const userDoc = await scalability.firestore.collection('users').doc(recipient_id).get();
            if (userDoc.exists) {
              const userData = userDoc.data();
              const savedPreference = userData.isAvailable !== false; // Default to true
              actualStatus = savedPreference ? 'available' : 'unavailable';

              // Update userStatus map for future checks
              setUserStatusSync(recipient_id, {
                status: actualStatus,
                currentCallId: null,
                lastStatusChange: new Date(),
                userPreference: savedPreference
              });
              logger.info(`📞 Loaded preference from Firestore for ${recipient_id}: ${actualStatus}`);
            } else {
              // No Firestore data - default to available
              actualStatus = 'available';
              setUserStatusSync(recipient_id, {
                status: 'available',
                currentCallId: null,
                lastStatusChange: new Date(),
                userPreference: true
              });
            }
          } catch (firestoreError) {
            logger.warn(`⚠️ Could not load Firestore preference: ${firestoreError.message}`);
            actualStatus = 'available'; // Default fallback
          }
        }
      }
    }

    // STEP 3: If no connection, always return 'unavailable' (can't receive calls without WebSocket)
    if (!hasConnection) {
      actualStatus = 'unavailable';
      logger.info(`📞 User ${recipient_id} has no active connection - status: unavailable`);
    }

    const isAvailable = actualStatus === 'available';

    logger.info(`📞 Availability check for ${recipient_id}: ${actualStatus} (connection: ${hasConnection ? 'YES' : 'NO'}, socket: ${recipientConnection ? recipientConnection.socketId : 'NONE'})`);

    res.json({
      success: true,
      is_available: isAvailable,
      user_status: actualStatus,
      current_call_id: currentCallId,
      message: isAvailable
        ? 'User is available'
        : `User is currently ${actualStatus}`
    });

  } catch (error) {
    logger.error('❌ Error in /api/check_availability:', error);
    res.status(500).json({
      error: 'Failed to check availability',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// 🆕 PRODUCTION ENDPOINT: Check if a call is still active/valid
// Used by mobile app to validate call before showing ringer screen
app.post('/api/check_call_status', async (req, res) => {
  try {
    const { call_id, caller_id, recipient_id } = req.body;

    if (!call_id) {
      return res.status(400).json({ error: 'Missing call_id' });
    }

    logger.info(`📞 Checking call status for call_id: ${call_id}`);

    // Check if call exists in active calls (in-memory)
    const activeCall = activeCalls.get(call_id);

    if (activeCall) {
      // Call is in memory - check if it's actually active or already ended
      const callStatus = activeCall.status || 'unknown';
      const isRinging = callStatus === 'ringing' || callStatus === 'initiated';
      const isConnected = callStatus === 'connected' || callStatus === 'answered';
      // 🔧 FIX: Check if call is ended/cancelled even if still in memory
      const isEnded = ['ended', 'declined', 'missed', 'cancelled', 'timeout', 'no_answer'].includes(callStatus);
      const isActive = !isEnded && (isRinging || isConnected || callStatus === 'unknown');

      logger.info(`✅ Call ${call_id} found in activeCalls - Status: ${callStatus}, Active: ${isActive}`);

      return res.json({
        success: true,
        call_active: isActive,
        call_status: callStatus,
        is_ringing: isRinging,
        is_connected: isConnected,
        is_ended: isEnded,
        ended_reason: isEnded ? callStatus : null,
        call_data: {
          callId: activeCall.callId,
          callerId: activeCall.callerId,
          callerName: activeCall.callerName,
          recipientId: activeCall.recipientId,
          callType: activeCall.callType,
          roomName: activeCall.roomName,
          startedAt: activeCall.startedAt,
        },
        message: isEnded ? `Call has ended (${callStatus})` : `Call is ${callStatus}`
      });
    }

    // Call not in memory - check Firestore for call history
    logger.info(`⚠️ Call ${call_id} not in activeCalls, checking Firestore...`);

    const db = scalability.firestore;
    if (db) {
      const callDoc = await db.collection('calls').doc(call_id).get();

      if (callDoc.exists) {
        const callData = callDoc.data();
        const callStatus = callData.status || 'unknown';
        const isEnded = ['ended', 'declined', 'missed', 'cancelled', 'timeout', 'no_answer'].includes(callStatus);

        logger.info(`📋 Call ${call_id} found in Firestore - Status: ${callStatus}, Ended: ${isEnded}`);

        return res.json({
          success: true,
          call_active: !isEnded,
          call_status: callStatus,
          is_ringing: false,
          is_connected: false,
          is_ended: isEnded,
          ended_reason: isEnded ? callStatus : null,
          call_data: {
            callId: callData.callId,
            callerId: callData.callerId,
            callerName: callData.callerName,
            recipientId: callData.recipientId,
            callType: callData.callType,
            roomName: callData.roomName,
            endedAt: callData.endedAt,
            duration: callData.duration,
          },
          message: isEnded ? `Call has ended (${callStatus})` : `Call status: ${callStatus}`
        });
      }
    }

    // Call not found anywhere
    logger.warn(`❌ Call ${call_id} not found in activeCalls or Firestore`);

    return res.json({
      success: true,
      call_active: false,
      call_status: 'not_found',
      is_ringing: false,
      is_connected: false,
      is_ended: true,
      ended_reason: 'not_found',
      message: 'Call not found - may have ended or never existed'
    });

  } catch (error) {
    logger.error('❌ Error in /api/check_call_status:', error);
    res.status(500).json({
      error: 'Failed to check call status',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// 🆕 PRODUCTION ENDPOINT: Update user availability status (for female users)
app.post('/api/update_availability', async (req, res) => {
  try {
    const { user_id, is_available } = req.body;

    if (!user_id || typeof is_available !== 'boolean') {
      return res.status(400).json({
        error: 'Missing required fields',
        required: { user_id: 'string', is_available: 'boolean' }
      });
    }

    logger.info(`📱 Availability update request - User: ${user_id}, Available: ${is_available}`);

    // Get current user status
    const currentStatus = userStatus.get(user_id);

    // Check if user is currently on a call
    if (currentStatus && currentStatus.status === 'busy' && !is_available) {
      logger.warn(`⚠️ User ${user_id} is on a call, cannot set unavailable`);
      return res.status(400).json({
        success: false,
        error: 'Cannot set unavailable while on a call',
        current_status: currentStatus.status
      });
    }

    // Update status based on availability choice
    const newStatus = is_available ? 'available' : 'unavailable';

    setUserStatusSync(user_id, {
      status: newStatus,
      currentCallId: currentStatus?.currentCallId || null,
      lastStatusChange: new Date(),
      userPreference: is_available // Track user's explicit choice
    });

    logger.info(`✅ User ${user_id} availability updated to: ${newStatus}`);

    // Update Firestore to persist availability preference
    try {
      const userDoc = scalability.firestore.collection('users').doc(user_id);
      await userDoc.set({
        isAvailable: is_available,
        lastAvailabilityUpdate: new Date(),
        updatedAt: new Date()
      }, { merge: true });

      logger.info(`💾 Availability preference saved to Firestore for user ${user_id}`);
    } catch (firestoreError) {
      logger.error(`❌ Failed to save availability to Firestore: ${firestoreError.message}`);
      // Continue even if Firestore update fails - status is updated in memory/Redis
    }

    // Notify user via WebSocket if they're connected
    const userConnection = connectedUsers.get(user_id);
    if (userConnection && userConnection.isOnline) {
      const userSocket = io.sockets.sockets.get(userConnection.socketId);
      if (userSocket && userSocket.connected) {
        userSocket.emit('availability_updated', {
          is_available: is_available,
          status: newStatus,
          timestamp: new Date().toISOString()
        });
        logger.info(`📡 Availability update notification sent to user ${user_id}`);
      }
    }

    // 🆕 Broadcast availability change to all connected male users
    try {
      // Get user data to determine gender
      const db = scalability.firestore;
      const userDoc = await db.collection('users').doc(user_id).get();

      if (userDoc.exists && userDoc.data().gender === 'female') {
        // Broadcast to all connected sockets
        io.sockets.emit('availability_changed', {
          femaleUserId: user_id,
          isAvailable: is_available,
          status: newStatus,
          timestamp: new Date().toISOString()
        });
        logger.info(`📢 Broadcasted availability change for female user ${user_id} to all male users`);
      }
    } catch (broadcastError) {
      logger.error(`❌ Failed to broadcast availability change: ${broadcastError.message}`);
      // Don't fail the request if broadcast fails
    }

    res.json({
      success: true,
      user_id: user_id,
      is_available: is_available,
      status: newStatus,
      message: is_available ? 'You are now available for calls' : 'You are now unavailable for calls',
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('❌ Error in /api/update_availability:', error);
    res.status(500).json({
      error: 'Failed to update availability',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// 🆕 Get all available female users (for male dashboard) - ENHANCED WITH FALLBACK STATS
app.get('/api/get_available_females', async (req, res) => {
  try {
    logger.info('📋 Fetching available female users for male dashboard');

    // STEP 1: Query Firestore for verified female users
    const db = scalability.firestore;
    const usersRef = db.collection('users');

    // First, let's check ALL female users to debug
    const allFemalesSnapshot = await usersRef
      .where('gender', '==', 'female')
      .get();

    logger.info(`📋 Total female users in Firestore: ${allFemalesSnapshot.docs.length}`);

    // Log details of each female user for debugging
    for (const doc of allFemalesSnapshot.docs) {
      const data = doc.data();
      logger.info(`📋 Female user ${doc.id}: isVerified=${data.isVerified}, isAvailable=${data.isAvailable}, name=${data.name}`);
    }

    const femalesSnapshot = await usersRef
      .where('gender', '==', 'female')
      .where('isVerified', '==', true)
      .where('isAvailable', '==', true)
      .get();

    if (femalesSnapshot.empty) {
      logger.info('📋 No available female users found in Firestore query (after filtering)');
      return res.json({
        success: true,
        available_females: [],
        count: 0,
        timestamp: new Date().toISOString()
      });
    }

    logger.info(`📋 Found ${femalesSnapshot.docs.length} females with isAvailable=true in Firestore`);

    // STEP 2: Check connection status and FCM reachability
    // 🆕 ENHANCED: Include FCM-reachable users (background mode)
    const availableFemales = [];

    for (const doc of femalesSnapshot.docs) {
      const userData = doc.data();
      const userId = doc.id;

      logger.info(`📋 Checking user ${userId} (${userData.name})`);

      // Check if user has active WebSocket connection
      const userConnection = connectedUsers.get(userId);
      const hasActiveConnection = userConnection && userConnection.isOnline;

      logger.info(`📋   - Has connection entry: ${!!userConnection}`);
      logger.info(`📋   - Is online: ${hasActiveConnection}`);

      // Verify socket is still connected
      let isSocketConnected = false;
      if (hasActiveConnection) {
        const userSocket = io.sockets.sockets.get(userConnection.socketId);
        isSocketConnected = userSocket && userSocket.connected;
        logger.info(`📋   - Socket connected: ${isSocketConnected}`);
      }

      // 🔧 FIX: Show females based on TOGGLE (isAvailable), not WebSocket connection
      // Toggle ON = user wants to be visible, even if app is in background
      // WebSocket status only affects the online/offline indicator, not visibility

      // Verify isAvailable is true in Firestore (toggle is ON)
      if (userData.isAvailable !== true) {
        logger.info(`📋 Skipping user ${userId} (${userData.name}) - isAvailable (toggle) is not true`);
        continue;
      }

      logger.info(`📋   - User has toggle ON (isAvailable=true) - WILL BE SHOWN`);
      logger.info(`📋   - User online status: ${isSocketConnected ? 'ONLINE (WebSocket connected)' : 'OFFLINE (background/disconnected)'}`);

      // Store the actual online status for UI to display
      const actualOnlineStatus = isSocketConnected;

      // Check if user is not currently on a call
      const userStatusData = userStatus.get(userId);
      if (userStatusData && userStatusData.status === 'busy') {
        logger.debug(`📋 Skipping user ${userId} - currently on a call`);
        continue;
      }

      // 🔧 STEP 3: ENHANCED PowerUp stats fetching using StatsSyncUtil
      let powerUpStats = {
        rating: 0,
        totalCalls: 0,
        totalLikes: 0
      };

      try {
        if (statsSync) {
          // Use the new stats sync utility for robust stats fetching
          const stats = await statsSync.getUserStatsWithFallback(userId);
          powerUpStats = {
            rating: stats.rating,
            totalCalls: stats.totalCalls,
            totalLikes: stats.totalLikes
          };
          logger.info(`📋   ✅ Stats from StatsSyncUtil: rating=${powerUpStats.rating}, calls=${powerUpStats.totalCalls}, likes=${powerUpStats.totalLikes}, source=${stats.source}`);
        } else {
          // Fallback to original logic if statsSync not initialized
          logger.warn(`📋   ⚠️ StatsSyncUtil not initialized, using fallback logic`);
          
          const fallbackStats = {
            rating: userData.rating || 0,
            totalCalls: userData.totalCallsReceived || 0,
            totalLikes: userData.totalLikes || 0
          };

          try {
            const powerUpsRef = db.collection('users').doc(userId).collection('powerups');
            const powerUpsSnapshot = await powerUpsRef.get();

            if (!powerUpsSnapshot.empty) {
              let totalLikes = 0;
              let totalDislikes = 0;
              let totalCalls = powerUpsSnapshot.docs.length;

              powerUpsSnapshot.forEach(powerUpDoc => {
                const powerUpData = powerUpDoc.data();
                if (powerUpData.like) totalLikes++;
                if (powerUpData.dislike) totalDislikes++;
              });

              const rating = totalCalls > 0
                ? parseFloat(((totalLikes / totalCalls) * 10).toFixed(1))
                : 0;

              powerUpStats = {
                rating: rating,
                totalCalls: totalCalls,
                totalLikes: totalLikes
              };
            } else {
              powerUpStats = fallbackStats;
            }
          } catch (statsError) {
            powerUpStats = fallbackStats;
            logger.warn(`⚠️  Fallback stats logic failed for user ${userId}:`, statsError.message);
          }
        }
      } catch (utilError) {
        // Final fallback to main document data
        powerUpStats = {
          rating: userData.rating || 0,
          totalCalls: userData.totalCallsReceived || 0,
          totalLikes: userData.totalLikes || 0
        };
        logger.error(`❌ StatsSyncUtil failed for user ${userId}, using main document data:`, utilError.message);
      }

      // STEP 4: Build user object with all required fields
      // 🔧 FIX: Include actual online status for UI to show proper indicator
      const userObject = {
        userId: userId,
        name: userData.name || 'Unknown',
        age: userData.age || 0,
        photoUrl: userData.photoUrl || '',
        fullPhotoUrl: userData.fullPhotoUrl || userData.photoUrl || '',
        isOnline: actualOnlineStatus, // 🔧 FIX: Use actual WebSocket status, not always true
        isAvailable: true, // Always true - filtered by Firestore isAvailable (toggle) earlier
        rating: powerUpStats.rating,
        totalCalls: powerUpStats.totalCalls,
        totalLikes: powerUpStats.totalLikes,
        relationshipStatus: userData.relationshipStatus || 'single'
      };

      logger.info(`📋   ✅ Final user object: ${JSON.stringify(userObject)}`);
      availableFemales.push(userObject);
    }

    logger.info(`📋 Found ${availableFemales.length} available female users with proper stats`);

    res.json({
      success: true,
      available_females: availableFemales,
      count: availableFemales.length,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('❌ Error in /api/get_available_females:', error);
    res.status(500).json({
      error: 'Failed to fetch available females',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// Generate Twilio access token with rate validation
app.post('/api/generate_token', async (req, res) => {
  try {
    const { user_identity, room_name, is_video = true } = req.body;

    if (!user_identity || !room_name) {
      return res.status(400).json({ 
        error: 'Missing required fields: user_identity and room_name' 
      });
    }

    // Validate room name format
    if (!room_name.match(/^(video|audio)_[a-zA-Z0-9_]+$/)) {
      return res.status(400).json({
        error: 'Invalid room_name format. Must be: (video|audio)_userIds'
      });
    }

    logger.info(`🔑 Generating ${is_video ? 'video' : 'audio'} token for ${user_identity} in room ${room_name}`);

    const accessToken = generateSecureAccessToken(user_identity, room_name, is_video);

    // 🆕 Return coin rate with token for client validation
    const coinRate = is_video ? COIN_RATES.video : COIN_RATES.audio;

    res.json({
      accessToken,
      room_name,
      user_identity,
      is_video,
      coin_rate_per_second: coinRate,  // Server-side rate for validation
      expiresAt: new Date(Date.now() + 1800000).toISOString(),
      server_timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('❌ Error in /api/generate_token:', error);
    res.status(500).json({ 
      error: 'Failed to generate access token',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// 🆕 PRODUCTION ENDPOINT: Start server-side call tracking
app.post('/api/start_call_tracking', async (req, res) => {
  try {
    const { call_id, caller_id, recipient_id, call_type, room_name } = req.body;

    if (!call_id || !caller_id || !recipient_id || !call_type) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const coinRate = call_type === 'video' ? COIN_RATES.video : COIN_RATES.audio;
    const startTime = Date.now();

    // Start server-side timer for authoritative duration tracking
    const interval = setInterval(() => {
      const callTimer = callTimers.get(call_id);
      if (callTimer) {
        callTimer.durationSeconds++;
        
        // Log every 10 seconds for monitoring
        if (callTimer.durationSeconds % 10 === 0) {
          logger.debug(`⏱️  Call ${call_id} duration: ${callTimer.durationSeconds}s`);
        }
      }
    }, 1000);

    callTimers.set(call_id, {
      interval,
      startTime,
      durationSeconds: 0,
      callerId: caller_id,
      recipientId: recipient_id,
      callType: call_type,
      coinRate,
      roomName: room_name,
      lastHeartbeat: Date.now() // 🔧 CRASH FIX: Initialize lastHeartbeat to prevent undefined comparison
    });

    logger.info(`⏱️  Started server-side tracking for call ${call_id} (${call_type})`);

    res.json({
      success: true,
      call_id,
      coin_rate_per_second: coinRate,
      server_start_time: new Date(startTime).toISOString(),
      message: 'Server-side call tracking started'
    });

  } catch (error) {
    logger.error('❌ Error in /api/start_call_tracking:', error);
    res.status(500).json({ 
      error: 'Failed to start call tracking',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// 🆕 PRODUCTION ENDPOINT: End call with server-side duration validation
app.post('/api/complete_call', async (req, res) => {
  try {
    const { call_id, client_duration_seconds, client_coins_deducted } = req.body;

    if (!call_id) {
      return res.status(400).json({ error: 'Missing call_id' });
    }

    const serverTimer = callTimers.get(call_id);
    
    if (!serverTimer) {
      logger.warn(`⚠️  No server timer found for call ${call_id}, using client duration`);
      return res.json({
        success: true,
        call_id,
        duration_seconds: client_duration_seconds || 0,
        coins_deducted: client_coins_deducted || 0,
        source: 'client',
        warning: 'Server timer not found, using client-reported values'
      });
    }

    // Stop server timer
    clearInterval(serverTimer.interval);
    const serverDuration = serverTimer.durationSeconds;
    const serverCoinsDeducted = serverDuration * serverTimer.coinRate;

    // Validate client-reported duration (allow 5 second tolerance)
    const durationDiff = Math.abs(serverDuration - (client_duration_seconds || 0));
    const isFraudulent = durationDiff > 5;

    if (isFraudulent) {
      logger.warn(`⚠️  FRAUD ALERT: Call ${call_id} duration mismatch`);
      logger.warn(`   Server: ${serverDuration}s, Client: ${client_duration_seconds}s`);
    }

    // Clean up
    callTimers.delete(call_id);

    logger.info(`✅ Call ${call_id} completed: ${serverDuration}s, ${serverCoinsDeducted.toFixed(2)} coins`);

    res.json({
      success: true,
      call_id,
      duration_seconds: serverDuration,  // Use server duration as source of truth
      coins_deducted: parseFloat(serverCoinsDeducted.toFixed(2)),
      coin_rate_per_second: serverTimer.coinRate,
      call_type: serverTimer.callType,
      source: 'server',
      validation: {
        client_duration: client_duration_seconds,
        server_duration: serverDuration,
        duration_diff_seconds: durationDiff,
        is_fraudulent: isFraudulent
      }
    });

  } catch (error) {
    logger.error('❌ Error in /api/complete_call:', error);
    res.status(500).json({ 
      error: 'Failed to complete call',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});


// ============================================================================
// SERVER-AUTHORITATIVE CALL BILLING API ENDPOINTS
// ============================================================================

// 🆕 PRODUCTION ENDPOINT: Refresh user stats manually
app.post('/api/refresh_user_stats', async (req, res) => {
  try {
    const { user_id } = req.body;

    if (!user_id) {
      return res.status(400).json({ error: 'user_id is required' });
    }

    logger.info(`📊 Manual stats refresh requested for user: ${user_id}`);

    if (!statsSync) {
      return res.status(503).json({ 
        error: 'Stats sync service not available',
        details: 'StatsSyncUtil not initialized'
      });
    }

    // Get fresh stats and update main document
    const stats = await statsSync.getUserStatsWithFallback(user_id);
    
    // Validate consistency
    const isConsistent = await statsSync.validateStatsConsistency(user_id);

    res.json({
      success: true,
      user_id: user_id,
      stats: {
        rating: stats.rating,
        totalCalls: stats.totalCalls,
        totalLikes: stats.totalLikes,
        totalDislikes: stats.totalDislikes,
        source: stats.source
      },
      consistency_check: {
        is_consistent: isConsistent,
        checked_at: new Date().toISOString()
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('❌ Error in /api/refresh_user_stats:', error);
    res.status(500).json({
      error: 'Failed to refresh user stats',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// 🆕 PRODUCTION ENDPOINT: Batch refresh stats for multiple users
app.post('/api/batch_refresh_stats', async (req, res) => {
  try {
    const { user_ids } = req.body;

    if (!user_ids || !Array.isArray(user_ids) || user_ids.length === 0) {
      return res.status(400).json({ error: 'user_ids array is required' });
    }

    if (user_ids.length > 50) {
      return res.status(400).json({ error: 'Maximum 50 users allowed per batch' });
    }

    logger.info(`📊 Batch stats refresh requested for ${user_ids.length} users`);

    if (!statsSync) {
      return res.status(503).json({ 
        error: 'Stats sync service not available',
        details: 'StatsSyncUtil not initialized'
      });
    }

    const results = await statsSync.batchUpdateStats(user_ids);

    res.json({
      success: true,
      batch_results: results,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('❌ Error in /api/batch_refresh_stats:', error);
    res.status(500).json({
      error: 'Failed to batch refresh stats',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// Get user balance from Firestore
app.get('/api/user/:userId/balance', async (req, res) => {
  try {
    const { userId } = req.params;
    
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }
    
    logger.info(`💰 Getting balance for user: ${userId}`);
    
    const balance = await scalability.getUserBalance(userId);
    
    if (balance === null) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json({
      success: true,
      userId,
      balance,
      currency: 'coins',
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    logger.error('❌ Error getting user balance:', error);
    res.status(500).json({ 
      error: 'Failed to get user balance',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// Start call - Server-side tracking
app.post('/api/calls/start', async (req, res) => {
  try {
    const { callId, callerId, recipientId, callType, roomName } = req.body;

    if (!callId || !callerId || !recipientId || !callType) {
      return res.status(400).json({ error: 'Missing required fields: callId, callerId, recipientId, callType' });
    }

    logger.info(`📞 Starting call: ${callId} (${callType})`);
    logger.info(`   Caller: ${callerId}, Recipient: ${recipientId}`);

    // 🆕 STEP 1: Check recipient availability FIRST (before balance check)
    // Use unified terminology: 'available' or 'unavailable' only
    const recipientStatus = userStatus.get(recipientId);
    const recipientConnection = connectedUsers.get(recipientId);

    let actualStatus = 'unavailable'; // Default: unavailable
    let hasConnection = false;

    // Check if recipient has active WebSocket connection
    if (recipientConnection && recipientConnection.isOnline) {
      const socket = io.sockets.sockets.get(recipientConnection.socketId);
      if (socket && socket.connected) {
        hasConnection = true;
        // Use status from userStatus map, or default to 'available'
        actualStatus = recipientStatus ? recipientStatus.status : 'available';
      }
    }

    // If no connection, always unavailable (can't receive calls without WebSocket)
    if (!hasConnection) {
      actualStatus = 'unavailable';
    }

    logger.info(`📞 Recipient ${recipientId} status check: ${actualStatus} (connection: ${hasConnection ? 'YES' : 'NO'})`);

    // Block call if recipient is not available
    if (actualStatus !== 'available') {
      logger.warn(`📞 Call blocked at /api/calls/start: Recipient ${recipientId} is ${actualStatus}`);
      return res.status(400).json({
        error: 'Recipient is not available',
        recipientStatus: actualStatus,
        message: actualStatus === 'busy'
          ? 'User is currently on another call'
          : actualStatus === 'ringing'
          ? 'User is receiving another call'
          : 'User is currently unavailable for calls'
      });
    }

    logger.info(`✅ Recipient ${recipientId} is available - proceeding with call`);

    // STEP 2: Validate caller balance
    const callerBalance = await scalability.getUserBalance(callerId);
    const requiredBalance = callType === 'video' ? MIN_BALANCE_VIDEO : MIN_BALANCE_AUDIO;

    if (callerBalance === null) {
      return res.status(404).json({ error: 'Caller not found' });
    }

    if (callerBalance < requiredBalance) {
      return res.status(400).json({
        error: 'Insufficient balance',
        currentBalance: callerBalance,
        requiredBalance,
        shortfall: requiredBalance - callerBalance
      });
    }
    
    const coinRate = callType === 'video' ? COIN_RATES.video : COIN_RATES.audio;
    const startTime = Date.now();
    
    const callData = {
      callId,
      callerId,
      recipientId,
      callType,
      roomName: roomName || `${callType}_${callerId}_${recipientId}`,
      status: 'initiated',
      coinRate,
      startedAt: new Date().toISOString(),
      durationSeconds: 0,
      coinsDeducted: 0
    };
    
    await scalability.saveCallToFirestore(callData);
    
    const interval = setInterval(() => {
      const timer = callTimers.get(callId);
      if (timer) {
        timer.durationSeconds++;
      }
    }, 1000);
    
    callTimers.set(callId, {
      interval,
      durationSeconds: 0,
      coinRate,
      callerId,
      recipientId,
      callType,
      startTime,
      lastHeartbeat: Date.now()
    });
    
    logger.info(`✅ Call started: ${callId}, balance: ${callerBalance} coins`);
    
    res.json({
      success: true,
      callId,
      serverStartTime: new Date().toISOString(),
      callerBalance,
      coinRate,
      message: 'Call tracking started on server'
    });
    
  } catch (error) {
    logger.error('❌ Error starting call:', error);
    res.status(500).json({ 
      error: 'Failed to start call',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// 🆕 PHASE 1 FIX: Complete call with server-side billing + fraud detection logging + graceful fallback
app.post('/api/calls/complete', async (req, res) => {
  try {
    // Accept both new and legacy field names for backwards compatibility
    const {
      callId, call_id,
      callerId, caller_id,
      recipientId, recipient_id,
      endReason,
      client_duration_seconds,  // From legacy endpoint - for fraud detection
      client_coins_deducted     // From legacy endpoint - for fraud detection
    } = req.body;

    const finalCallId = callId || call_id;
    const finalCallerId = callerId || caller_id;
    const finalRecipientId = recipientId || recipient_id;

    if (!finalCallId) {
      return res.status(400).json({ error: 'Missing required field: callId' });
    }

    logger.info(`🏁 Completing call: ${finalCallId}`);

    const serverTimer = callTimers.get(finalCallId);

    // 🆕 GRACEFUL FALLBACK: If no server timer found, handle gracefully instead of 404
    if (!serverTimer) {
      logger.warn(`⚠️  No server timer found for call ${finalCallId}`);

      // If client provided duration, use it as fallback (with warning)
      if (client_duration_seconds !== undefined) {
        logger.warn(`⚠️  Using client-reported duration as fallback: ${client_duration_seconds}s`);

        // Still update Firestore to mark call as completed
        try {
          await scalability.updateCallInFirestore(finalCallId, {
            status: 'completed',
            durationSeconds: client_duration_seconds || 0,
            coinsDeducted: client_coins_deducted || 0,
            endedAt: new Date().toISOString(),
            endReason: endReason || 'User ended call',
            billingSource: 'client_fallback',
            warning: 'Server timer not found, used client-reported values'
          });
        } catch (firestoreError) {
          logger.error(`❌ Firestore update failed: ${firestoreError.message}`);
        }

        return res.json({
          success: true,
          callId: finalCallId,
          durationSeconds: client_duration_seconds || 0,
          coinsDeducted: client_coins_deducted || 0,
          newBalance: null,
          source: 'client_fallback',
          warning: 'Server timer not found, used client-reported values',
          message: 'Call completed with client-reported duration'
        });
      }

      // No client duration either - call may have already been completed
      return res.json({
        success: true,
        callId: finalCallId,
        durationSeconds: 0,
        coinsDeducted: 0,
        newBalance: null,
        source: 'already_completed',
        warning: 'Call not found - may have already been completed',
        message: 'Call completion acknowledged'
      });
    }

    clearInterval(serverTimer.interval);
    const serverDuration = serverTimer.durationSeconds;
    const coinsDeducted = Math.ceil(serverDuration * serverTimer.coinRate);

    logger.info(`   Server Duration: ${serverDuration}s`);
    logger.info(`   Coins to Deduct: ${coinsDeducted}`);

    // 🆕 FRAUD DETECTION LOGGING (merged from legacy /api/complete_call)
    let fraudDetection = null;
    if (client_duration_seconds !== undefined) {
      const durationDiff = Math.abs(serverDuration - client_duration_seconds);
      const isSuspicious = durationDiff > 5; // More than 5 seconds difference

      fraudDetection = {
        clientDuration: client_duration_seconds,
        serverDuration: serverDuration,
        differenceSeconds: durationDiff,
        isSuspicious: isSuspicious
      };

      if (isSuspicious) {
        logger.warn(`⚠️  FRAUD ALERT: Call ${finalCallId} duration mismatch`);
        logger.warn(`   Server: ${serverDuration}s, Client: ${client_duration_seconds}s, Diff: ${durationDiff}s`);
      } else {
        logger.info(`✅ Duration validation passed: Server ${serverDuration}s, Client ${client_duration_seconds}s`);
      }
    }

    // Deduct coins (server duration is source of truth)
    await scalability.deductUserCoins(finalCallerId || serverTimer.callerId, coinsDeducted, finalCallId);
    const newBalance = await scalability.getUserBalance(finalCallerId || serverTimer.callerId);

    await scalability.updateCallInFirestore(finalCallId, {
      status: 'completed',
      durationSeconds: serverDuration,
      coinsDeducted,
      endedAt: new Date().toISOString(),
      endReason: endReason || 'User ended call',
      billingSource: 'server',
      fraudDetection: fraudDetection
    });

    callTimers.delete(finalCallId);

    // 🆕 Reset user statuses to available
    setUserStatusSync(serverTimer.callerId, {
      status: 'available',
      currentCallId: null,
      lastStatusChange: new Date()
    });
    setUserStatusSync(serverTimer.recipientId, {
      status: 'available',
      currentCallId: null,
      lastStatusChange: new Date()
    });

    logger.info(`✅ Call completed: ${finalCallId}, deducted: ${coinsDeducted} coins, new balance: ${newBalance}`);

    res.json({
      success: true,
      callId: finalCallId,
      durationSeconds: serverDuration,
      coinsDeducted,
      newBalance,
      coinRate: serverTimer.coinRate,
      callType: serverTimer.callType,
      source: 'server',
      fraudDetection: fraudDetection,
      message: 'Call completed and billed successfully'
    });

  } catch (error) {
    logger.error('❌ Error completing call:', error);
    res.status(500).json({
      error: 'Failed to complete call',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// Heartbeat - Keep call alive
app.post('/api/calls/heartbeat', async (req, res) => {
  try {
    // 🆕 ISSUE #13 FIX: Accept both userId and callerId for backwards compatibility
    const { callId, userId, callerId } = req.body;
    const effectiveUserId = userId || callerId; // Prefer userId, fallback to callerId

    if (!callId || !effectiveUserId) {
      return res.status(400).json({ error: 'Missing required fields: callId, userId (or callerId)' });
    }
    
    const serverTimer = callTimers.get(callId);
    
    if (!serverTimer) {
      return res.status(404).json({ error: 'Call not found' });
    }
    
    const currentDuration = serverTimer.durationSeconds;
    const estimatedCoins = Math.ceil(currentDuration * serverTimer.coinRate);
    
    serverTimer.lastHeartbeat = Date.now();
    
    res.json({
      success: true,
      callId,
      currentDurationSeconds: currentDuration,
      estimatedCost: estimatedCoins,
      coinRate: serverTimer.coinRate
    });
    
  } catch (error) {
    logger.error('❌ Error in heartbeat:', error);
    res.status(500).json({ error: 'Heartbeat failed' });
  }
});

// Get call status
app.get('/api/call/:callId', (req, res) => {
  const { callId } = req.params;
  const call = activeCalls.get(callId);

  if (!call) {
    return res.status(404).json({ error: 'Call not found' });
  }

  // Add server timer info if available
  const serverTimer = callTimers.get(callId);
  if (serverTimer) {
    call.server_duration_seconds = serverTimer.durationSeconds;
    call.server_coin_rate = serverTimer.coinRate;
  }

  res.json(call);
});

// ============================================================================
// 🆕 PRODUCTION: Socket.IO with Enhanced Call Management
// ============================================================================

io.on('connection', (socket) => {
  const clientIp = socket.handshake.address;
  const userAgent = socket.handshake.headers['user-agent'];
  logger.info(`🔌 User connected: ${socket.id} from ${clientIp}`);
  logger.debug(`   User-Agent: ${userAgent}`);
  
  // Send welcome message
  socket.emit('connected', {
    socketId: socket.id,
    timestamp: new Date().toISOString(),
    message: 'Connected to TingaTalk server'
  });

  // User joins with their ID
  socket.on('join', async (data) => {
    logger.info(`🚪 === JOIN EVENT RECEIVED ===`);
    logger.info(`🚪 Socket ID: ${socket.id}`);
    logger.info(`🚪 Data: ${JSON.stringify(data)}`);
    logger.info(`🚪 Data type: ${typeof data}`);
    
    let userId, userType;
    
    if (typeof data === 'string') {
      userId = data;
      userType = 'unknown';
      logger.info(`🚪 Join format: STRING - userId: ${userId}`);
    } else if (typeof data === 'object' && data !== null) {
      userId = data.userId || data.user_id;
      userType = data.userType || data.user_type;
      logger.info(`🚪 Join format: OBJECT - userId: ${userId}, userType: ${userType}`);
    } else {
      logger.error(`🚪 ❌ Invalid join data format: ${typeof data}`);
      socket.emit('error', { message: 'Invalid join data format' });
      return;
    }
    
    if (!userId) {
      logger.error(`🚪 ❌ User ID is missing from join data`);
      socket.emit('error', { message: 'User ID is required' });
      return;
    }

    logger.info(`🚪 Processing join for user: ${userId}`);

    // 🆕 CANCEL DISCONNECT TIMEOUT if user is reconnecting
    // This prevents the user from being marked as unavailable if they reconnect within timeout
    cancelDisconnectTimeout(userId);

    // 🔧 FIX: Check if user already has an active connection
    const existingUser = connectedUsers.get(userId);
    if (existingUser && existingUser.socketId !== socket.id) {
      logger.warn(`⚠️  User ${userId} reconnecting - Previous socket: ${existingUser.socketId}, New socket: ${socket.id}`);
      // Leave previous socket from room if it exists
      const oldSocket = io.sockets.sockets.get(existingUser.socketId);
      if (oldSocket) {
        oldSocket.leave(`user_${userId}`);
        oldSocket.disconnect(true);
        logger.info(`🚪 Disconnected old socket: ${existingUser.socketId}`);
      }
    }

    // Store user connection
    setConnectedUserSync(userId, {
      socketId: socket.id,
      userType: userType || 'unknown',
      connectedAt: new Date(),
      isOnline: true
    });
    logger.info(`🚪 User ${userId} stored in connectedUsers map`);

    // 🆕 Set user status based on saved preference from Firestore (if available)
    const currentStatus = userStatus.get(userId);
    if (!currentStatus || currentStatus.status === 'unavailable' || currentStatus.status === 'disconnected') {
      // Try to get saved availability preference from Firestore
      let savedPreference = true; // Default to available
      try {
        const userDoc = await scalability.firestore.collection('users').doc(userId).get();
        if (userDoc.exists) {
          const userData = userDoc.data();
          savedPreference = userData.isAvailable !== false; // Default true if not set
          logger.info(`💾 Loaded saved availability preference for ${userId}: ${savedPreference}`);
        }
      } catch (firestoreError) {
        logger.warn(`⚠️ Could not load availability preference from Firestore: ${firestoreError.message}`);
      }

      setUserStatusSync(userId, {
        status: savedPreference ? 'available' : 'unavailable',
        currentCallId: null,
        lastStatusChange: new Date(),
        userPreference: savedPreference
      });
      logger.info(`🚪 User ${userId} status set to: ${savedPreference ? 'available' : 'unavailable'}`);
    } else {
      logger.info(`🚪 User ${userId} status remains: ${currentStatus.status}`);
    }

    // Join user-specific room
    const roomName = `user_${userId}`;
    socket.join(roomName);
    logger.info(`🚪 Socket ${socket.id} joined room: ${roomName}`);
    
    // Verify room membership
    const rooms = Array.from(socket.rooms);
    logger.info(`🚪 Socket ${socket.id} is now in rooms: ${JSON.stringify(rooms)}`);
    logger.info(`🚪 Room ${roomName} contains: ${rooms.includes(roomName) ? '✅ THIS SOCKET' : '❌ NOT FOUND'}`);
    
    const userStatusObj = userStatus.get(userId);
    logger.info(`👤 User ${userId} (${userType || 'unknown'}) joined - Socket: ${socket.id} - Status: ${userStatusObj.status}`);

    // 🆕 UPDATE FIRESTORE: Mark user as online when they connect
    try {
      const db = scalability.firestore;
      if (db) {
        await db.collection('users').doc(userId).update({
          isOnline: true,
          lastSeenAt: new Date(),
          lastConnectedAt: new Date(),
        });
        logger.info(`✅ User ${userId} marked as online in Firestore`);
      }
    } catch (firestoreError) {
      logger.warn(`⚠️ Could not update online status in Firestore: ${firestoreError.message}`);
    }

    const joinResponse = {
      userId,
      userType: userType || 'unknown',
      status: userStatusObj.status,
      socketId: socket.id,
      roomName: roomName,
      success: true
    };

    logger.info(`🚪 Sending 'joined' confirmation: ${JSON.stringify(joinResponse)}`);
    socket.emit('joined', joinResponse);
    logger.info(`🚪 === JOIN PROCESSING COMPLETE ===`);
    logger.info(``);
  });

  // 🆕 ENHANCED: Initiate call with concurrent call prevention
  socket.on('initiate_call', async (data) => {
    const { callerId, recipientId, callType = 'video', callId, roomName, callerName: providedCallerName } = data;

    logger.info(`📞 === INITIATE_CALL EVENT RECEIVED ===`);
    logger.info(`📞 Data: ${JSON.stringify(data)}`);
    logger.info(`📞 Caller: ${callerId}, Recipient: ${recipientId}, Type: ${callType}`);
    logger.info(`📞 Provided Caller Name: ${providedCallerName || 'NOT PROVIDED'}`);

    if (!callerId || !recipientId) {
      logger.error(`❌ Missing required fields - callerId: ${callerId}, recipientId: ${recipientId}`);
      socket.emit('error', { message: 'Caller ID and Recipient ID are required' });
      return;
    }

    // 🔧 UNIFIED STATUS CHECK: Use only 'available' or 'unavailable'
    const recipientStatus = userStatus.get(recipientId);
    const recipientConnection = connectedUsers.get(recipientId);

    let actualStatus = 'unavailable'; // Default: unavailable
    let hasConnection = false;

    // Check if recipient has active WebSocket connection
    if (recipientConnection && recipientConnection.isOnline) {
      const socket = io.sockets.sockets.get(recipientConnection.socketId);
      if (socket && socket.connected) {
        hasConnection = true;
        actualStatus = recipientStatus ? recipientStatus.status : 'available';
        // Fix missing status
        if (!recipientStatus) {
          setUserStatusSync(recipientId, {
            status: 'available',
            currentCallId: null,
            lastStatusChange: new Date()
          });
          logger.info(`📞 Fixed missing status for recipient ${recipientId} - set to available`);
        }
      }
    }

    // 🔧 FIX: EXPLICIT BUSY/RINGING CHECK - Must be done FIRST before any other checks
    // This prevents second caller from reaching a female who is already on a call
    if (recipientStatus && (recipientStatus.status === 'busy' || recipientStatus.status === 'ringing')) {
      logger.warn(`📞 ❌ CALL BLOCKED: Recipient ${recipientId} is ${recipientStatus.status}`);
      logger.warn(`📞    Current call ID: ${recipientStatus.currentCallId || 'unknown'}`);
      logger.warn(`📞    Caller ${callerId} will receive call_failed event`);

      socket.emit('call_failed', {
        callId: callId || `call_${Date.now()}`,
        reason: recipientStatus.status === 'busy'
          ? 'User is busy on another call'
          : 'User is receiving another call',
        recipient_status: recipientStatus.status,
        is_busy: true
      });
      return;
    }

    // 🔧 NEW: Check if user has toggle ON in Firestore (even without WebSocket)
    let hasToggleOn = false;
    let hasFcmToken = false;

    // 🔧 FIX: Get caller's display name - either from provided data or fetch from Firestore
    let callerName = providedCallerName || null;
    if (!callerName || callerName === 'Unknown' || callerName === callerId) {
      try {
        logger.info(`📞 Fetching caller name from Firestore for: ${callerId}`);
        const callerDoc = await scalability.firestore.collection('users').doc(callerId).get();
        if (callerDoc.exists) {
          const callerData = callerDoc.data();
          // Try multiple fields for the name
          callerName = callerData.displayName || callerData.name || callerData.username || 'Someone';
          logger.info(`📞 ✅ Fetched caller name: ${callerName}`);
        } else {
          callerName = 'Someone';
          logger.warn(`📞 ⚠️ Caller document not found for: ${callerId}`);
        }
      } catch (e) {
        logger.warn(`⚠️ Could not get caller name: ${e.message}`);
        callerName = 'Someone';
      }
    }
    logger.info(`📞 Final caller name for notification: ${callerName}`);

    // If no WebSocket connection, check Firestore for availability preference
    if (!hasConnection) {
      try {
        const recipientDoc = await scalability.firestore.collection('users').doc(recipientId).get();
        if (recipientDoc.exists) {
          const recipientData = recipientDoc.data();
          hasToggleOn = recipientData.isAvailable === true;
          hasFcmToken = !!recipientData.fcmToken && recipientData.fcmToken.length > 0;
          logger.info(`📞 Recipient Firestore check: isAvailable=${hasToggleOn}, hasFcmToken=${hasFcmToken}`);
        }
      } catch (e) {
        logger.warn(`⚠️ Could not check recipient Firestore data: ${e.message}`);
      }

      // If toggle is ON and has FCM token, we can try push notification
      if (hasToggleOn && hasFcmToken) {
        actualStatus = 'fcm_reachable'; // Special status for FCM-reachable users
        logger.info(`📞 Recipient ${recipientId} is FCM-reachable (toggle ON, has FCM token)`);
      } else {
        actualStatus = 'unavailable';
        logger.info(`📞 Recipient ${recipientId} is unavailable (toggle: ${hasToggleOn}, fcm: ${hasFcmToken})`);
      }
    }

    logger.info(`📞 Recipient ${recipientId} actual status: ${actualStatus} (connection: ${hasConnection ? 'YES' : 'NO'})`);

    // 🆕 PRODUCTION: Check if recipient is available or FCM-reachable
    if (actualStatus !== 'available' && actualStatus !== 'fcm_reachable') {
      logger.warn(`📞 Call blocked: Recipient ${recipientId} is ${actualStatus}`);

      socket.emit('call_failed', {
        callId: callId || `call_${Date.now()}`,
        reason: `Recipient is currently ${actualStatus}`,
        recipient_status: actualStatus
      });
      return;
    }

    const finalCallId = callId || `call_${callerId}_${recipientId}_${Date.now()}`;
    const finalRoomName = roomName || `${callType}_${callerId}_${recipientId}`;

    logger.info(`📞 Generated call ID: ${finalCallId}`);
    logger.info(`📞 Generated room name: ${finalRoomName}`);

    // Create call object
    const call = {
      callId: finalCallId,
      roomName: finalRoomName,
      callerId,
      callerName,  // 🔧 FIX: Include caller name in call object
      recipientId,
      callType,
      status: 'initiated',
      createdAt: new Date(),
      participants: [callerId]
    };

    setActiveCallSync(finalCallId, call);
    logger.info(`📞 Call object created and stored: ${finalCallId}`);

    // Check if recipient is online
    const recipient = connectedUsers.get(recipientId);
    logger.info(`📞 Recipient connection status: ${recipient ? 'ONLINE' : 'OFFLINE'}`);
    
    if (recipient && recipient.isOnline) {
      // 🆕 Mark recipient as ringing (temporary until accept/decline)
      setUserStatusSync(recipientId, {
        status: 'ringing',
        currentCallId: finalCallId,
        lastStatusChange: new Date()
      });
      logger.info(`📞 Recipient ${recipientId} status changed to: ringing`);

      const recipientSocketId = recipient.socketId;
      logger.info(`📞 Recipient socket ID: ${recipientSocketId}`);
      
      // Check which rooms the recipient socket is in
      const recipientSocket = io.sockets.sockets.get(recipientSocketId);
      if (recipientSocket) {
        const rooms = Array.from(recipientSocket.rooms);
        logger.info(`📞 Recipient socket rooms: ${JSON.stringify(rooms)}`);
      } else {
        logger.error(`❌ Recipient socket not found in io.sockets: ${recipientSocketId}`);
      }
      
      // Prepare incoming call payload with ALL required fields
      const incomingCallPayload = {
        callId: finalCallId,
        roomName: finalRoomName,
        callerId: callerId,
        callerName: callerName,  // 🔧 FIX: Include caller name
        recipientId: recipientId,
        callType: callType,
        timestamp: new Date().toISOString(),
        // Additional fields for Flutter app (snake_case format)
        caller_id: callerId,
        caller_name: callerName,  // 🔧 FIX: Include caller name (snake_case)
        recipient_id: recipientId,
        room_name: finalRoomName,
        call_type: callType,
        call_id: finalCallId
      };
      
      logger.info(`📞 Incoming call payload: ${JSON.stringify(incomingCallPayload)}`);
      logger.info(`📡 === EMITTING INCOMING_CALL EVENT ===`);
      logger.info(`📡 Target socket ID: ${recipientSocketId}`);
      logger.info(`📡 Target room: user_${recipientId}`);
      
      // FIXED: Only emit to recipient's socket directly (most reliable and prevents caller from receiving)
      logger.info(`📡 Emitting directly to recipient socket ${recipientSocketId}...`);
      io.to(recipientSocketId).emit('incoming_call', incomingCallPayload);
      logger.info(`📡 ✅ incoming_call emitted to recipient only`);

      // 🔧 ALSO send FCM as backup (in case app goes to background during call initiation)
      try {
        const fcmBackup = await scalability.sendIncomingCallNotification(recipientId, {
          callId: finalCallId,
          callerId: callerId,
          callerName: callerName,
          roomName: finalRoomName,
          callType: callType,
        });
        if (fcmBackup) {
          logger.info(`📱 Backup FCM notification also sent to ${recipientId}`);
        }
      } catch (fcmError) {
        logger.warn(`⚠️ Backup FCM failed (non-critical): ${fcmError.message}`);
      }

      call.status = 'ringing';
      call.recipientOnline = true;
      call.recipientSocketId = recipientSocketId;
      
      logger.info(`📞 Sending call_initiated confirmation to caller...`);
      socket.emit('call_initiated', {
        callId: finalCallId,
        roomName: finalRoomName,
        status: 'ringing',
        recipientOnline: true,
        recipientSocketId: recipientSocketId
      });
      logger.info(`📞 ✅ call_initiated sent to caller`);
      logger.info(`📞 === INITIATE_CALL PROCESSING COMPLETE ===`);
      logger.info(``);
      
      // 🆕 PRODUCTION: Set call timeout (30 seconds)
      setTimeout(() => {
        const currentCall = activeCalls.get(finalCallId);
        if (currentCall && currentCall.status === 'ringing') {
          logger.warn(`⏱️  Call timeout: ${finalCallId} - No response from ${recipientId}`);
          
          // Reset recipient status
          setUserStatusSync(recipientId, {
            status: 'available',
            currentCallId: null,
            lastStatusChange: new Date()
          });
          
          // Notify both parties
          io.to(recipientSocketId).emit('call_timeout', { callId: finalCallId });
          socket.emit('call_timeout', { callId: finalCallId, reason: 'No response from recipient' });
          
          // Mark call as timed out and remove - UPDATE FIRESTORE
          currentCall.status = 'timeout';
          currentCall.timeoutAt = new Date();
          completeCallSync(finalCallId, {
            status: 'timeout',
            timeoutAt: new Date(),
            endedAt: new Date(),
          });
        }
      }, 30000); // 30 seconds
      
    } else {
      // 🔧 NEW: Recipient not connected via WebSocket - try FCM push notification
      logger.info(`📞 Recipient ${recipientId} not connected via WebSocket - attempting FCM push notification`);

      // Check if we determined earlier that recipient is FCM-reachable
      if (actualStatus === 'fcm_reachable') {
        logger.info(`📱 Sending FCM push notification to ${recipientId}...`);

        // Send FCM notification
        const fcmSent = await scalability.sendIncomingCallNotification(recipientId, {
          callId: finalCallId,
          callerId: callerId,
          callerName: callerName,
          roomName: finalRoomName,
          callType: callType,
        });

        if (fcmSent) {
          logger.info(`✅ FCM notification sent successfully to ${recipientId}`);

          // Mark call as "pending_fcm" - waiting for recipient to open app
          call.status = 'pending_fcm';
          call.recipientOnline = false;
          call.fcmSent = true;
          call.fcmSentAt = new Date();

          // Notify caller that call is ringing (via FCM)
          socket.emit('call_initiated', {
            callId: finalCallId,
            roomName: finalRoomName,
            status: 'ringing_fcm',
            recipientOnline: false,
            fcmSent: true,
            message: 'Push notification sent to recipient'
          });

          // Set longer timeout for FCM calls (60 seconds)
          setTimeout(() => {
            const currentCall = activeCalls.get(finalCallId);
            if (currentCall && (currentCall.status === 'pending_fcm' || currentCall.status === 'ringing')) {
              logger.warn(`⏱️ FCM Call timeout: ${finalCallId} - No response from ${recipientId}`);

              // Notify caller
              socket.emit('call_timeout', {
                callId: finalCallId,
                reason: 'No response from recipient (FCM)',
              });

              // Mark call as timed out and remove - UPDATE FIRESTORE
              currentCall.status = 'timeout';
              currentCall.timeoutAt = new Date();
              completeCallSync(finalCallId, {
                status: 'timeout',
                timeoutAt: new Date(),
                endedAt: new Date(),
              });
            }
          }, 60000); // 60 seconds for FCM calls

        } else {
          // FCM send failed
          logger.warn(`❌ FCM notification failed for ${recipientId}`);
          call.status = 'failed';
          call.recipientOnline = false;
          call.failureReason = 'FCM notification failed';

          socket.emit('call_failed', {
            callId: finalCallId,
            reason: 'Could not reach recipient',
          });
        }
      } else {
        // Not FCM-reachable - completely offline
        call.status = 'failed';
        call.recipientOnline = false;
        call.failureReason = 'Recipient is offline';

        logger.warn(`📞 Call failed: ${finalCallId} - Recipient ${recipientId} is completely offline`);

        socket.emit('call_failed', {
          callId: finalCallId,
          reason: 'Recipient is offline',
        });
      }
    }
  });

  // 🆕 ENHANCED: Accept call with busy status update + AUTO-START SERVER BILLING TIMER
  socket.on('accept_call', async (data) => {
    const { callId, callerId, recipientId } = data;

    const call = activeCalls.get(callId);
    if (!call) {
      socket.emit('error', { message: 'Call not found' });
      return;
    }

    if (call.recipientId !== recipientId) {
      socket.emit('error', { message: 'Unauthorized to accept this call' });
      return;
    }

    // 🆕 Mark both users as busy
    setUserStatusSync(callerId, {
      status: 'busy',
      currentCallId: callId,
      lastStatusChange: new Date()
    });
    setUserStatusSync(recipientId, {
      status: 'busy',
      currentCallId: callId,
      lastStatusChange: new Date()
    });

    call.status = 'accepted';
    call.participants.push(recipientId);
    call.acceptedAt = new Date();

    // 🆕 PHASE 1 FIX: Auto-start server billing timer when call is accepted
    // This ensures server tracks call duration for billing even without explicit /api/calls/start
    if (!callTimers.has(callId)) {
      const coinRate = call.callType === 'video' ? COIN_RATES.video : COIN_RATES.audio;
      const startTime = Date.now();

      // Create server-side timer for billing
      const interval = setInterval(() => {
        const timer = callTimers.get(callId);
        if (timer) {
          timer.durationSeconds++;
          // Log every 30 seconds for monitoring
          if (timer.durationSeconds % 30 === 0) {
            logger.info(`⏱️  Call ${callId} duration: ${timer.durationSeconds}s (auto-started on accept)`);
          }
        }
      }, 1000);

      callTimers.set(callId, {
        interval,
        durationSeconds: 0,
        coinRate,
        callerId,
        recipientId,
        callType: call.callType,
        startTime,
        lastHeartbeat: Date.now(),
        autoStarted: true  // Flag to indicate this was auto-started
      });

      logger.info(`⏱️  Auto-started server billing timer for call ${callId} (${call.callType}) - Rate: ${coinRate} coins/sec`);

      // 🆕 Also save call to Firestore with 'active' status
      try {
        await scalability.saveCallToFirestore({
          callId,
          callerId,
          recipientId,
          callType: call.callType,
          roomName: call.roomName,
          status: 'active',
          coinRate,
          startedAt: new Date().toISOString(),
          acceptedAt: call.acceptedAt.toISOString(),
          durationSeconds: 0,
          coinsDeducted: 0
        });
        logger.info(`📝 Call ${callId} saved to Firestore with 'active' status`);
      } catch (firestoreError) {
        logger.error(`❌ Failed to save call to Firestore: ${firestoreError.message}`);
      }
    } else {
      logger.info(`⏱️  Server billing timer already exists for call ${callId}`);
    }

    // FIXED: Only emit to caller's socket directly
    const caller = connectedUsers.get(callerId);
    if (caller) {
      logger.info(`✅ Call accepted: ${callId} by ${recipientId} - Notifying caller ${callerId} (socket: ${caller.socketId})`);

      io.to(caller.socketId).emit('call_accepted', {
        callId,
        roomName: call.roomName,
        recipientId,
        acceptedAt: call.acceptedAt.toISOString()
      });
    } else {
      logger.warn(`⚠️  Caller ${callerId} not found in connected users`);
    }

    logger.info(`✅ Call accepted: ${callId} by ${recipientId} - Both users marked as busy, billing timer started`);
  });

  // 🆕 ENHANCED: Decline call with status cleanup
  socket.on('decline_call', (data) => {
    const { callId, callerId, recipientId } = data;
    
    const call = activeCalls.get(callId);
    if (!call) {
      socket.emit('error', { message: 'Call not found' });
      return;
    }

    call.status = 'declined';
    call.declinedAt = new Date();

    // 🆕 Reset recipient status to available
    setUserStatusSync(recipientId, {
      status: 'available',
      currentCallId: null,
      lastStatusChange: new Date()
    });

    // 🔧 FIX: Use io.to() to emit to caller
    const caller = connectedUsers.get(callerId);
    if (caller) {
      logger.info(`❌ Call declined: ${callId} by ${recipientId} - Notifying caller ${callerId} (socket: ${caller.socketId})`);
      
      // FIXED: Only emit to caller's socket directly
      io.to(caller.socketId).emit('call_declined', {
        callId,
        reason: 'Call declined by recipient',
        declinedAt: call.declinedAt.toISOString()
      });
    } else {
      logger.warn(`⚠️  Caller ${callerId} not found in connected users`);
    }

    // Remove call from active calls - UPDATE FIRESTORE
    completeCallSync(callId, {
      status: 'declined',
      declinedAt: call.declinedAt,
      endedAt: new Date(),
    });

    logger.info(`❌ Call declined: ${callId} by ${recipientId} - Recipient status reset to available`);
  });

  // 🆕 ISSUE #16 FIX: Handle WebSocket keepalive ping from Flutter during calls
  // This keeps the Socket.IO connection alive on mobile networks
  // 🔧 CRASH FIX: Also update lastHeartbeat to prevent server-side timeout
  socket.on('call_ping', (data) => {
    const { callId, userId, timestamp } = data;

    // Just acknowledge the ping - no heavy processing needed
    // The fact that the message was received keeps the connection alive
    logger.debug(`📡 Call ping received: callId=${callId}, userId=${userId}`);

    // 🔧 CRASH FIX: Update lastHeartbeat on call_ping to prevent 60s timeout
    if (callId) {
      const timer = callTimers.get(callId);
      if (timer) {
        timer.lastHeartbeat = Date.now();
        logger.debug(`📡 Updated lastHeartbeat for call ${callId} via call_ping`);
      }
    }

    // Optionally send pong back (Flutter doesn't need it, but useful for debugging)
    socket.emit('call_pong', {
      callId,
      userId,
      serverTime: Date.now(),
      clientTime: timestamp,
    });
  });

  // 🆕 ISSUE #17 FIX: Handle health check ping from Flutter
  // This is used by the WebSocketService health check system to verify connection is alive
  // 🔧 CRASH FIX: Also update lastHeartbeat for any active call by this user
  socket.on('health_ping', (data) => {
    const { userId, timestamp } = data;

    // Lightweight acknowledgment - just proves the socket is alive
    logger.debug(`📡 Health ping received from user: ${userId}`);

    // 🔧 CRASH FIX: Update lastHeartbeat for any active call by this user
    callTimers.forEach((timer, callId) => {
      if (timer.callerId === userId || timer.recipientId === userId) {
        timer.lastHeartbeat = Date.now();
        logger.debug(`📡 Updated lastHeartbeat for call ${callId} via health_ping from ${userId}`);
      }
    });

    // Send pong back so Flutter knows the connection is truly alive
    socket.emit('health_pong', {
      userId,
      serverTime: Date.now(),
      clientTime: timestamp,
      status: 'alive',
    });
  });

  // 🆕 ENHANCED: End call with status cleanup and timer stop
  socket.on('end_call', async (data) => {
    const { callId, userId } = data;
    
    const call = activeCalls.get(callId);
    if (!call) {
      socket.emit('error', { message: 'Call not found' });
      return;
    }

    call.status = 'ended';
    call.endedAt = new Date();
    call.endedBy = userId;

    // 🆕 Stop server-side timer if exists
    const serverTimer = callTimers.get(callId);
    if (serverTimer) {
      clearInterval(serverTimer.interval);
      logger.info(`⏱️  Stopped server timer for call ${callId}: ${serverTimer.durationSeconds}s`);
    }

    // 🆕 Reset both users' status to available
    if (call.participants) {
      call.participants.forEach(participantId => {
        setUserStatusSync(participantId, {
          status: 'available',
          currentCallId: null,
          lastStatusChange: new Date()
        });
        
        // 🔧 FIX: Use io.to() to notify participants
        const participant = connectedUsers.get(participantId);
        if (participant) {
          // FIXED: Only emit to participant's socket directly
          io.to(participant.socketId).emit('call_ended', {
            callId,
            endedBy: userId,
            duration: call.endedAt - call.createdAt,
            endedAt: call.endedAt.toISOString()
          });
        }
      });
    }

    // Remove call from active calls - UPDATE FIRESTORE
    completeCallSync(callId, {
      status: 'ended',
      endedAt: call.endedAt,
      endedBy: userId,
    });

    logger.info(`📞 Call ended: ${callId} by ${userId} - All participants status reset to available`);
  });

  // 🆕 NEW: Handle cancel_call - when caller cancels before recipient answers
  socket.on('cancel_call', async (data) => {
    const { callId, callerId, recipientId, userId, reason } = data;

    logger.info(`📞 ====== CANCEL_CALL EVENT ======`);
    logger.info(`📞 Call ID: ${callId}`);
    logger.info(`📞 Caller: ${callerId}, Recipient: ${recipientId}`);
    logger.info(`📞 Cancelled by: ${userId}, Reason: ${reason}`);

    const call = activeCalls.get(callId);

    if (call) {
      call.status = 'cancelled';
      call.cancelledAt = new Date();
      call.cancelledBy = userId;
      call.cancelReason = reason;

      logger.info(`📞 Found call in activeCalls, updating status to cancelled`);

      // Reset recipient status to available
      setUserStatusSync(recipientId, {
        status: 'available',
        currentCallId: null,
        lastStatusChange: new Date()
      });

      // Notify recipient that call was cancelled
      const recipient = connectedUsers.get(recipientId);
      if (recipient) {
        logger.info(`📞 Notifying recipient ${recipientId} that call was cancelled`);
        io.to(recipient.socketId).emit('call_cancelled', {
          callId,
          cancelledBy: userId,
          reason: reason || 'caller_cancelled',
          cancelledAt: call.cancelledAt.toISOString()
        });
      }

      // Also emit call_ended for compatibility
      if (recipient) {
        io.to(recipient.socketId).emit('call_ended', {
          callId,
          endedBy: userId,
          reason: 'cancelled',
          endedAt: call.cancelledAt.toISOString()
        });
      }

      // Update Firestore and remove from active calls
      completeCallSync(callId, {
        status: 'cancelled',
        cancelledAt: call.cancelledAt,
        cancelledBy: userId,
        cancelReason: reason,
        endedAt: call.cancelledAt,
      });

      logger.info(`✅ Call ${callId} cancelled successfully - Firestore updated`);
    } else {
      logger.warn(`⚠️ Call ${callId} not found in activeCalls for cancel`);

      // Even if not in memory, update Firestore
      scalability.updateCallInFirestore(callId, {
        status: 'cancelled',
        cancelledAt: new Date(),
        cancelledBy: userId,
        cancelReason: reason,
        endedAt: new Date(),
      }).catch(err => {
        logger.error(`Error updating cancelled call in Firestore: ${err.message}`);
      });

      // Still try to notify recipient
      const recipient = connectedUsers.get(recipientId);
      if (recipient) {
        io.to(recipient.socketId).emit('call_cancelled', {
          callId,
          cancelledBy: userId,
          reason: reason || 'caller_cancelled',
        });
        io.to(recipient.socketId).emit('call_ended', {
          callId,
          endedBy: userId,
          reason: 'cancelled',
        });
      }
    }
  });

  // 🆕 ENHANCED: Handle disconnection with call cleanup
  socket.on('disconnect', async (reason) => {
    logger.info(`🔌 User disconnected: ${socket.id} - Reason: ${reason}`);
    
    // 🆕 Find user and update status
    for (const [userId, user] of connectedUsers.entries()) {
      if (user.socketId === socket.id) {
        user.isOnline = false;
        user.disconnectedAt = new Date();
        
        // Check if user was in an active call
        const currentStatus = userStatus.get(userId);
        if (currentStatus && currentStatus.currentCallId) {
          const callId = currentStatus.currentCallId;
          const call = activeCalls.get(callId);
          
          if (call) {
            logger.warn(`⚠️  User ${userId} disconnected during active call ${callId}`);
            
            // Notify other participants
            if (call.participants) {
              call.participants.forEach(participantId => {
                if (participantId !== userId) {
                  const participant = connectedUsers.get(participantId);
                  if (participant && participant.isOnline) {
                    io.to(participant.socketId).emit('participant_disconnected', {
                      callId,
                      disconnectedUserId: userId,
                      reason: 'User connection lost'
                    });
                  }
                  
                  // Reset participant status
                  setUserStatusSync(participantId, {
                    status: 'available',
                    currentCallId: null,
                    lastStatusChange: new Date()
                  });
                }
              });
            }
            
            // 🆕 ISSUE #15 FIX: Properly complete call with billing on disconnect
            // This ensures call logs are updated in Firestore with duration and cost
            const serverTimer = callTimers.get(callId);

            if (serverTimer) {
              // Stop the timer first
              clearInterval(serverTimer.interval);
              const durationSeconds = serverTimer.durationSeconds || 0;
              const coinRate = serverTimer.coinRate || COIN_RATES.audio;
              const coinsDeducted = Math.ceil(durationSeconds * coinRate);

              logger.info(`⏱️ Call ${callId} disconnected - Duration: ${durationSeconds}s, Cost: ${coinsDeducted} coins`);

              // Deduct coins from caller (non-blocking)
              if (call.callerId && coinsDeducted > 0) {
                scalability.deductUserCoins(call.callerId, coinsDeducted, callId)
                  .then(() => logger.info(`💰 Deducted ${coinsDeducted} coins from ${call.callerId} for disconnected call`))
                  .catch(err => logger.error(`❌ Failed to deduct coins on disconnect: ${err.message}`));
              }

              // Update Firestore with complete call details
              completeCallSync(callId, {
                status: 'disconnected',
                endReason: 'connection_lost',
                disconnectedBy: userId,
                disconnectedAt: new Date().toISOString(),
                endedAt: new Date().toISOString(),
                durationSeconds: durationSeconds,
                coinsDeducted: coinsDeducted,
                coinRate: coinRate,
              });

              callTimers.delete(callId);
              logger.info(`✅ Call ${callId} completed on disconnect - Firestore updated`);
            } else {
              // No timer means call wasn't fully connected, just mark as disconnected
              call.status = 'disconnected';
              call.disconnectedAt = new Date();

              completeCallSync(callId, {
                status: 'disconnected',
                endReason: 'connection_lost_before_connect',
                disconnectedBy: userId,
                disconnectedAt: new Date().toISOString(),
                endedAt: new Date().toISOString(),
                durationSeconds: 0,
                coinsDeducted: 0,
              });

              logger.info(`⏱️ Call ${callId} marked disconnected (no timer) - Firestore updated`);
            }
          }
        }
        
        // 🆕 Update user status to disconnected (no connection = can't receive calls via WebSocket)
        setUserStatusSync(userId, {
          status: 'disconnected',
          currentCallId: null,
          lastStatusChange: new Date()
        });

        const userType = user.userType || 'unknown';

        // 🔧 IMMEDIATE: For female users, update Firestore AND emit event RIGHT AWAY
        // This ensures card disappears INSTANTLY and doesn't reappear when they reconnect
        if (userType === 'female') {
          logger.info(`📢 Female user ${userId} disconnected - IMMEDIATE update`);

          // 1. Emit event to connected males for instant UI update
          io.emit('user_disconnected', {
            disconnectedUserId: userId,
            userId: userId,
            userType: 'female',
            timestamp: new Date().toISOString(),
            reason: 'websocket_disconnect'
          });

          // 2. Update Firestore - ONLY set isOnline to false, preserve isAvailable (toggle)
          // FIX: isAvailable is the user's PREFERENCE (toggle) - should NOT change on disconnect
          // isOnline is the CONNECTION STATUS - should change on disconnect
          // The toggle should only turn OFF when: user manually turns it off, force closes app, or logs out
          try {
            const db = scalability.firestore;
            if (db) {
              await db.collection('users').doc(userId).update({
                // isAvailable: false, // REMOVED - Don't change toggle on background/disconnect
                isOnline: false,       // Only change connection status
                lastSeenAt: new Date(),
                disconnectedAt: new Date()
                // unavailableReason removed - toggle is still ON
              });
              logger.info(`✅ Female user ${userId} - isOnline set to FALSE (toggle preserved)`);

              // Emit status_changed instead of availability_changed
              // This tells males the female is offline but toggle is still ON
              io.emit('user_status_changed', {
                femaleUserId: userId,
                isOnline: false,
                // isAvailable is NOT included - males should check Firestore for current toggle state
                reason: 'disconnect',
                timestamp: new Date().toISOString()
              });
            }
          } catch (firestoreError) {
            logger.error(`❌ Failed to update Firestore for female ${userId} on disconnect:`, firestoreError.message);
          }
        }

        // 🆕 START DISCONNECT TIMEOUT (backup mechanism)
        // After 30 seconds of disconnect, also mark in Firestore (in case immediate update failed)
        startDisconnectTimeout(userId, userType);

        logger.info(`👤 User ${userId} (${userType}) disconnected - Started ${DISCONNECT_TIMEOUT_MS / 1000}s timeout`);
        break;
      }
    }
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('❌ Server error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    details: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// 🆕 PHASE 1 FIX: Heartbeat timeout monitoring
// 🔧 CRASH FIX: Increased timeout from 60s to 180s (3 minutes) to prevent premature call termination
// Mobile networks can have brief interruptions, 60s was too aggressive
const HEARTBEAT_TIMEOUT_MS = 180000; // 3 minutes - more tolerant of network hiccups
const HEARTBEAT_CHECK_INTERVAL_MS = 60000; // Check every 60 seconds (was 30s)

setInterval(async () => {
  const now = Date.now();
  let staleCallsFound = 0;

  // 🔧 CRASH FIX: Convert to array and use for...of to properly handle async
  const callEntries = Array.from(callTimers.entries());

  for (const [callId, timer] of callEntries) {
    // 🔧 CRASH FIX: Handle undefined lastHeartbeat (defensive check)
    if (!timer.lastHeartbeat) {
      timer.lastHeartbeat = Date.now();
      logger.warn(`⚠️ Timer for call ${callId} had no lastHeartbeat, initialized now`);
      continue;
    }

    const timeSinceLastHeartbeat = now - timer.lastHeartbeat;

    if (timeSinceLastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
      staleCallsFound++;
      logger.warn(`⚠️  STALE CALL DETECTED: ${callId} - No heartbeat for ${Math.round(timeSinceLastHeartbeat / 1000)}s`);

      // Stop the timer
      clearInterval(timer.interval);
      const finalDuration = timer.durationSeconds;
      const coinsToDeduct = Math.ceil(finalDuration * timer.coinRate);

      logger.info(`⏱️  Auto-ending stale call ${callId}: ${finalDuration}s, ${coinsToDeduct} coins`);

      // Deduct coins and update Firestore
      try {
        await scalability.deductUserCoins(timer.callerId, coinsToDeduct, callId);
        await scalability.updateCallInFirestore(callId, {
          status: 'timeout_heartbeat',
          durationSeconds: finalDuration,
          coinsDeducted: coinsToDeduct,
          endedAt: new Date().toISOString(),
          endReason: 'No heartbeat received - connection lost'
        });
        logger.info(`✅ Stale call ${callId} billed and closed: ${coinsToDeduct} coins deducted`);
      } catch (error) {
        logger.error(`❌ Error closing stale call ${callId}: ${error.message}`);
      }

      // Clean up
      callTimers.delete(callId);

      // Reset user statuses
      setUserStatusSync(timer.callerId, {
        status: 'available',
        currentCallId: null,
        lastStatusChange: new Date()
      });
      setUserStatusSync(timer.recipientId, {
        status: 'available',
        currentCallId: null,
        lastStatusChange: new Date()
      });

      // Notify users via WebSocket if connected
      const callerConn = connectedUsers.get(timer.callerId);
      const recipientConn = connectedUsers.get(timer.recipientId);

      if (callerConn) {
        io.to(callerConn.socketId).emit('call_ended', {
          callId,
          endedBy: 'server',
          reason: 'Connection timeout - no heartbeat',
          duration: finalDuration
        });
      }
      if (recipientConn) {
        io.to(recipientConn.socketId).emit('call_ended', {
          callId,
          endedBy: 'server',
          reason: 'Connection timeout - no heartbeat',
          duration: finalDuration
        });
      }

      // Also clean up from activeCalls
      deleteActiveCallSync(callId);
    }
  }

  if (staleCallsFound > 0) {
    logger.info(`🧹 Heartbeat monitor: Found and cleaned ${staleCallsFound} stale call(s)`);
  }
}, HEARTBEAT_CHECK_INTERVAL_MS);

// 🔧 CRASH FIX: Additional memory protection - limit max call timers
const MAX_CONCURRENT_CALLS = 1000;
setInterval(() => {
  if (callTimers.size > MAX_CONCURRENT_CALLS) {
    logger.warn(`⚠️ MEMORY WARNING: ${callTimers.size} call timers active (max: ${MAX_CONCURRENT_CALLS})`);
    // Find and cleanup oldest timers
    const sortedTimers = Array.from(callTimers.entries())
      .sort((a, b) => (a[1].startTime || 0) - (b[1].startTime || 0));

    const toRemove = sortedTimers.slice(0, callTimers.size - MAX_CONCURRENT_CALLS);
    toRemove.forEach(([callId, timer]) => {
      logger.warn(`🧹 Force cleaning old call timer: ${callId}`);
      // 🔧 CRASH FIX: Also clear the interval to prevent orphaned timers
      if (timer.interval) {
        clearInterval(timer.interval);
      }
      callTimers.delete(callId);
    });
  }
}, 60000); // Check every minute

logger.info(`✅ Heartbeat timeout monitor initialized (timeout: ${HEARTBEAT_TIMEOUT_MS / 1000}s, check interval: ${HEARTBEAT_CHECK_INTERVAL_MS / 1000}s)`);

// Start server
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
  logger.info(`🚀 TingaTalk Enhanced Backend Server running on ${HOST}:${PORT}`);
  logger.info(`📡 WebSocket server ready for connections`);
  logger.info(`🔑 Twilio integration enabled`);
  logger.info(`💰 Coin rates: Audio ${COIN_RATES.audio}/s, Video ${COIN_RATES.video}/s`);
  logger.info(`⏱️  Minimum balance: Audio ${MIN_BALANCE_AUDIO} coins, Video ${MIN_BALANCE_VIDEO} coins`);
  logger.info(`🔒 Concurrent call prevention: ENABLED`);
  logger.info(`🌍 CORS enabled for: ${corsOptions.origin}`);
  logger.info(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);  logger.info(`📊 Process ID: ${process.pid}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('🛑 SIGTERM received, shutting down gracefully');
  
  // Clean up all timers
  callTimers.forEach((timer, callId) => {
    clearInterval(timer.interval);
    logger.info(`⏱️  Stopped timer for call ${callId}`);
  });
  
  server.close(() => {
    logger.info('✅ Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('🛑 SIGINT received, shutting down gracefully');
  
  // Clean up all timers
  callTimers.forEach((timer, callId) => {
    clearInterval(timer.interval);
    logger.info(`⏱️  Stopped timer for call ${callId}`);
  });
  
  server.close(() => {
    logger.info('✅ Server closed');
    process.exit(0);
  });
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  logger.error('💥 Uncaught Exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// ============================================================================
// 🔧 SECURITY FIX: Admin authentication middleware for diagnostic endpoints
// ============================================================================
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'tingatalk-admin-key-2024';

const adminAuth = (req, res, next) => {
  const apiKey = req.headers['x-admin-key'];

  // Allow requests without auth in development mode
  if (process.env.NODE_ENV !== 'production') {
    return next();
  }

  // Check API key
  if (apiKey !== ADMIN_API_KEY) {
    logger.warn(`Unauthorized access attempt to ${req.path} from ${req.ip}`);
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Valid admin API key required for this endpoint'
    });
  }

  next();
};

// ============================================================================
// 🔧 REDIS TIMER PERSISTENCE: Store timer metadata for crash recovery
// ============================================================================
async function storeCallTimerInRedis(callId, callData) {
  try {
    const timerKey = `call_timer:${callId}`;
    await scalability.redis.hset(timerKey, {
      startTime: Date.now().toString(),
      callerId: callData.callerId || '',
      recipientId: callData.recipientId || '',
      callType: callData.callType || 'video',
      coinRate: (callData.callType === 'video' ? 1.0 : 0.2).toString(),
      roomName: callData.roomName || ''
    });
    await scalability.redis.expire(timerKey, 14400); // 4 hour expiry
    logger.info(`✅ Call timer stored in Redis: ${callId}`);
  } catch (error) {
    logger.error(`❌ Failed to store call timer in Redis: ${callId}`, error.message);
  }
}

async function removeCallTimerFromRedis(callId) {
  try {
    await scalability.redis.del(`call_timer:${callId}`);
    logger.info(`✅ Call timer removed from Redis: ${callId}`);
  } catch (error) {
    logger.error(`❌ Failed to remove call timer from Redis: ${callId}`, error.message);
  }
}

async function recoverCallTimersFromRedis() {
  try {
    const keys = await scalability.redis.keys('call_timer:*');
    logger.info(`🔄 Found ${keys.length} call timers to recover from Redis`);

    for (const key of keys) {
      const timerData = await scalability.redis.hgetall(key);
      const callId = key.replace('call_timer:', '');
      const elapsed = Math.floor((Date.now() - parseInt(timerData.startTime)) / 1000);

      if (elapsed > 14400) {
        await scalability.redis.del(key);
        logger.warn(`🧹 Cleaned up stale call timer: ${callId} (${elapsed}s old)`);
        continue;
      }

      activeCalls.set(callId, {
        ...timerData,
        startTime: parseInt(timerData.startTime),
        elapsedSeconds: elapsed,
        recovered: true
      });
      logger.info(`✅ Recovered call timer: ${callId} (${elapsed}s elapsed)`);
    }
  } catch (error) {
    logger.error('❌ Error recovering call timers:', error.message);
  }
}

// ============================================================================
// 🔧 FIRESTORE TRANSACTION ATOMICITY: Atomic coin deduction
// ============================================================================
async function deductCoinsAtomically(callerId, amount, callId) {
  const db = scalability.firestore;
  if (!db) {
    logger.error('❌ Firestore not initialized for atomic deduction');
    return { success: false, error: 'Firestore not available' };
  }

  try {
    return await db.runTransaction(async (transaction) => {
      const userRef = db.collection('users').doc(callerId);
      const userDoc = await transaction.get(userRef);

      if (!userDoc.exists) {
        throw new Error('User not found');
      }

      const userData = userDoc.data();
      const currentBalance = userData.coins || 0;

      if (currentBalance < amount) {
        throw new Error('Insufficient balance');
      }

      const newBalance = currentBalance - amount;

      transaction.update(userRef, {
        coins: newBalance,
        lastDeductedAt: scalability.admin.firestore.FieldValue.serverTimestamp()
      });

      const txnRef = db.collection('transactions').doc();
      transaction.set(txnRef, {
        userId: callerId,
        callId: callId,
        amount: -amount,
        type: 'call_charge',
        previousBalance: currentBalance,
        newBalance: newBalance,
        createdAt: scalability.admin.firestore.FieldValue.serverTimestamp()
      });

      logger.info(`✅ Atomic deduction: ${callerId} - ${amount} coins (${currentBalance} -> ${newBalance})`);

      return {
        success: true,
        previousBalance: currentBalance,
        newBalance: newBalance,
        deducted: amount
      };
    });
  } catch (error) {
    logger.error(`❌ Atomic deduction failed for ${callerId}:`, error.message);
    return { success: false, error: error.message };
  }
}

// Call timer recovery on startup (delayed to allow Redis connection)
setTimeout(async () => {
  if (scalability.redis) {
    await recoverCallTimersFromRedis();
  }
}, 5000);

logger.info('✅ Server patches applied: Admin auth, Redis timer persistence, Atomic billing');

