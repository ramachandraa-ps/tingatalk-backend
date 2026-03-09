// ============================================================================
// TingaTalk Server Constants — Single source of truth
// ============================================================================

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

// Coin packages — server-authoritative pricing
export const COIN_PACKAGES = {
  'starter_pack':  { id: 'starter_pack',  name: 'Starter Pack',  coinAmount: 100,  priceInRupees: 99,   discountPercent: 10, isPopular: false, isActive: true },
  'popular_pack':  { id: 'popular_pack',  name: 'Popular Pack',  coinAmount: 500,  priceInRupees: 399,  discountPercent: 20, isPopular: true,  isActive: true },
  'value_pack':    { id: 'value_pack',    name: 'Value Pack',    coinAmount: 1000, priceInRupees: 699,  discountPercent: 30, isPopular: false, isActive: true },
  'premium_pack':  { id: 'premium_pack',  name: 'Premium Pack',  coinAmount: 2500, priceInRupees: 1499, discountPercent: 25, isPopular: false, isActive: true }
};

// Daily rewards
export const DAILY_REWARD_COINS = 10;

// Timeouts (milliseconds)
export const DISCONNECT_TIMEOUT_MS = 15000;        // 15 seconds before marking user offline
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
