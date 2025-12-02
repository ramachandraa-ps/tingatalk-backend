/**
 * SOLUTION #12: Centralized Configuration
 * All hardcoded values moved to environment variables with sensible defaults
 */

require('dotenv').config();

// Parse integer with fallback
const parseIntEnv = (key, defaultValue) => {
  const value = process.env[key];
  if (value === undefined || value === '') return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
};

// Parse boolean with fallback
const parseBoolEnv = (key, defaultValue) => {
  const value = process.env[key];
  if (value === undefined || value === '') return defaultValue;
  return value.toLowerCase() === 'true';
};

const config = {
  // Server
  port: parseIntEnv('PORT', 3000),
  host: process.env.HOST || '0.0.0.0',
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',

  // Twilio
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    apiKeySid: process.env.TWILIO_API_KEY_SID,
    apiKeySecret: process.env.TWILIO_API_KEY_SECRET,
  },

  // Razorpay
  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID || 'rzp_test_8DmfRFT3ZEhV7F',
    keySecret: process.env.RAZORPAY_KEY_SECRET || 'UgQXen8uDJ3QeGVsLQBMM1ar',
    accountNumber: process.env.RAZORPAYX_ACCOUNT_NUMBER || '2323230076543210',
  },

  // Redis
  redis: {
    url: process.env.REDIS_URL,
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseIntEnv('REDIS_PORT', 6379),
    password: process.env.REDIS_PASSWORD || '',
  },

  // Rate Limiting
  rateLimit: {
    windowMs: parseIntEnv('RATE_LIMIT_WINDOW_MS', 60 * 1000), // 1 minute
    maxRequests: parseIntEnv('RATE_LIMIT_MAX_REQUESTS', 60),
    strictMax: parseIntEnv('RATE_LIMIT_STRICT_MAX', 10),
  },

  // Logging
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    enableDebug: parseBoolEnv('ENABLE_DEBUG_LOGS', false),
  },

  // Security
  security: {
    trustProxy: parseBoolEnv('TRUST_PROXY', true),
    helmetEnabled: parseBoolEnv('HELMET_ENABLED', true),
    diagnosticApiKey: process.env.DIAGNOSTIC_API_KEY || '',
  },

  // Call Timeouts (milliseconds)
  timeouts: {
    call: parseIntEnv('CALL_TIMEOUT_MS', 30000), // 30 seconds
    fcmCall: parseIntEnv('FCM_CALL_TIMEOUT_MS', 60000), // 60 seconds
    disconnect: parseIntEnv('DISCONNECT_TIMEOUT_MS', 30000), // 30 seconds
    fcmBackupThreshold: parseIntEnv('FCM_BACKUP_THRESHOLD_MS', 30000), // 30 seconds
  },

  // Timer Cleanup
  cleanup: {
    staleTimerThreshold: parseIntEnv('STALE_TIMER_THRESHOLD_MS', 3600 * 1000), // 1 hour
    cleanupInterval: parseIntEnv('CLEANUP_INTERVAL_MS', 60 * 1000), // 1 minute
  },

  // Socket.IO
  socketio: {
    pingTimeout: parseIntEnv('SOCKET_PING_TIMEOUT_MS', 60000),
    pingInterval: parseIntEnv('SOCKET_PING_INTERVAL_MS', 25000),
    upgradeTimeout: parseIntEnv('SOCKET_UPGRADE_TIMEOUT_MS', 30000),
  },

  // CORS
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
  },
};

// Validate required config
const validateConfig = () => {
  const errors = [];

  if (!config.twilio.accountSid) {
    errors.push('TWILIO_ACCOUNT_SID is required');
  }
  if (!config.twilio.apiKeySid) {
    errors.push('TWILIO_API_KEY_SID is required');
  }
  if (!config.twilio.apiKeySecret) {
    errors.push('TWILIO_API_KEY_SECRET is required');
  }

  if (errors.length > 0 && config.isProduction) {
    console.error('Configuration errors:', errors);
    // Don't exit in development
    if (config.isProduction) {
      process.exit(1);
    }
  }

  return errors;
};

module.exports = {
  ...config,
  validateConfig,
};
