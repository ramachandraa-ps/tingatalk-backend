// ============================================================================
// TingaTalk Server Constants — Single source of truth
// ============================================================================

// Coin rates (server-side source of truth) — 1 coin = ₹1
// Video: 30 coins/min = 0.5 coins/sec | Audio: 10 coins/min ≈ 0.1667 coins/sec
export const COIN_RATES = {
  audio: 10 / 60,  // 10 coins per minute
  video: 30 / 60   // 30 coins per minute (0.5 coins/sec)
};

// Minimum call requirements (2 minute minimum)
export const MIN_CALL_DURATION_SECONDS = 120;
export const MIN_BALANCE = {
  audio: Math.ceil(COIN_RATES.audio * MIN_CALL_DURATION_SECONDS),  // 20 coins
  video: Math.ceil(COIN_RATES.video * MIN_CALL_DURATION_SECONDS)   // 60 coins
};

// Female earning rates (INR per second)
// Revenue split: 50% owner / 50% host, then 18% GST on host share
// Video: ₹30/min × 50% = ₹15/min → minus 18% GST = ₹12.30/min = ₹0.205/sec
// Audio: ₹10/min × 50% = ₹5/min  → minus 18% GST = ₹4.10/min  ≈ ₹0.06833/sec
export const FEMALE_EARNING_RATES = {
  audio: 4.10 / 60,   // ₹4.10 per minute after 50% split + 18% GST
  video: 12.30 / 60   // ₹12.30 per minute after 50% split + 18% GST
};

// Coin packages — server-authoritative pricing (1 coin = ₹1)
export const COIN_PACKAGES = {
  'starter_pack':  { id: 'starter_pack',  name: 'Starter Pack',  coinAmount: 100,  priceInRupees: 100,  discountPercent: 0,  isPopular: false, isActive: true },
  'small_pack':    { id: 'small_pack',    name: 'Small Pack',    coinAmount: 300,  priceInRupees: 300,  discountPercent: 0,  isPopular: false, isActive: true },
  'medium_pack':   { id: 'medium_pack',   name: 'Medium Pack',   coinAmount: 600,  priceInRupees: 600,  discountPercent: 0,  isPopular: true,  isActive: true },
  'large_pack':    { id: 'large_pack',    name: 'Large Pack',    coinAmount: 1200, priceInRupees: 1200, discountPercent: 0,  isPopular: false, isActive: true },
  'premium_pack':  { id: 'premium_pack',  name: 'Premium Pack',  coinAmount: 3000, priceInRupees: 3000, discountPercent: 0,  isPopular: false, isActive: true }
};

// Daily rewards
export const DAILY_REWARD_COINS = 10;

// Timeouts (milliseconds)
export const DISCONNECT_TIMEOUT_MS = 15000;        // 15 seconds before marking user offline (Tier 1: isOnline=false)
export const AVAILABILITY_TIMEOUT_MS = 600000;     // 10 minutes safety net (Tier 2: isAvailable=false for backgrounded app)
export const FCM_PING_TIMEOUT_MS = 45000;           // 45 seconds to wait for FCM ping response (Tier 1.5: force-close detection)
export const HEARTBEAT_TIMEOUT_MS = 60000;          // 60 seconds before stale call detection
export const HEARTBEAT_CHECK_INTERVAL_MS = 15000;   // Check every 15 seconds
export const CALL_RING_TIMEOUT_MS = 30000;           // 30 seconds ring timeout (WebSocket)
export const FCM_CALL_TIMEOUT_MS = 60000;            // 60 seconds ring timeout (FCM push)
export const TWILIO_TOKEN_TTL = 1800;                // 30 minutes

// Limits
export const MAX_CONCURRENT_CALLS = 1000;
export const MAX_BATCH_STATS_USERS = 50;
export const REDIS_CALL_TIMER_EXPIRY = 14400;       // 4 hours in seconds

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
