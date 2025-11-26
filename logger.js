/**
 * Simple Logger Utility
 * 
 * Provides consistent logging across the backend application
 */

const logLevel = process.env.LOG_LEVEL || 'info';
const enableDebugLogs = process.env.ENABLE_DEBUG_LOGS === 'true' || process.env.NODE_ENV === 'development';

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

module.exports = logger;