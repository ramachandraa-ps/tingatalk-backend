// ============================================================================
// Enhanced Console Logger
// ============================================================================

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
