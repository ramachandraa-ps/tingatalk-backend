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
