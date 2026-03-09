# TingaTalk Backend Restructure — Design Document

**Date:** 2026-03-09
**Status:** Approved
**Goal:** Rewrite the monolithic single-file backend (`server.js` ~3731 lines) into a modular, feature-based, production-grade Node.js/Express architecture — without changing any API contracts or app behavior.

---

## 1. Current State

### Architecture
- Single `server.js` file containing all 25+ REST endpoints, Socket.IO handlers, business logic, database operations, and in-memory state management.
- Supporting files: `scalability.js` (Firebase/Redis), `logger.js`, `utils/stats_sync_util.js`
- Deployed on VPS (`root@147.79.66.3`) via PM2

### Tech Stack (unchanged)
- **Runtime:** Node.js + Express.js
- **Database:** Firestore (Firebase)
- **Cache/State:** Redis
- **Auth:** Firebase Authentication (Bearer tokens)
- **Video/Audio:** Twilio Programmable Video
- **Payments:** Razorpay (orders, verification, payouts)
- **Real-time:** Socket.IO
- **Push Notifications:** Firebase Cloud Messaging (FCM)
- **Process Manager:** PM2

### Problems
- 3731-line monolith — difficult to navigate, debug, and maintain
- Business logic mixed with route definitions and database calls
- No separation of concerns
- No tests for critical payment/billing logic
- No API documentation
- Global mutable state scattered throughout

---

## 2. Target Architecture

### Approach
Clean rewrite — build modular structure from scratch, porting logic feature-by-feature. API contracts remain 100% identical.

### Language & Modules
ES Modules (`import/export`) — modern syntax, no build step, native Node.js 18+ support.

### Project Structure

```
tingatalk-backend/
├── src/
│   ├── app.js                          # Express app setup (middleware, routes)
│   ├── server.js                       # HTTP + Socket.IO server bootstrap
│   ├── config/
│   │   ├── index.js                    # Central config (env vars, defaults)
│   │   ├── firebase.js                 # Firebase Admin SDK init
│   │   ├── redis.js                    # Redis client init
│   │   ├── razorpay.js                 # Razorpay client init
│   │   └── twilio.js                   # Twilio credentials
│   ├── middleware/
│   │   ├── auth.js                     # Firebase token verification
│   │   ├── adminAuth.js                # Admin API key verification
│   │   ├── rateLimiter.js              # Rate limiting
│   │   ├── errorHandler.js             # Global error handler
│   │   └── requestLogger.js            # Request logging
│   ├── features/
│   │   ├── auth/
│   │   │   ├── auth.routes.js
│   │   │   ├── auth.controller.js
│   │   │   └── auth.service.js
│   │   ├── users/
│   │   │   ├── users.routes.js
│   │   │   ├── users.controller.js
│   │   │   └── users.service.js
│   │   ├── calls/
│   │   │   ├── calls.routes.js
│   │   │   ├── calls.controller.js
│   │   │   ├── calls.service.js
│   │   │   └── calls.validators.js
│   │   ├── payments/
│   │   │   ├── payments.routes.js
│   │   │   ├── payments.controller.js
│   │   │   └── payments.service.js
│   │   ├── rewards/
│   │   │   ├── rewards.routes.js
│   │   │   ├── rewards.controller.js
│   │   │   └── rewards.service.js
│   │   ├── packages/
│   │   │   ├── packages.routes.js
│   │   │   └── packages.controller.js
│   │   ├── availability/
│   │   │   ├── availability.routes.js
│   │   │   ├── availability.controller.js
│   │   │   └── availability.service.js
│   │   ├── stats/
│   │   │   ├── stats.routes.js
│   │   │   ├── stats.controller.js
│   │   │   └── stats.service.js
│   │   ├── payouts/
│   │   │   ├── payouts.routes.js
│   │   │   ├── payouts.controller.js
│   │   │   └── payouts.service.js
│   │   ├── diagnostics/
│   │   │   ├── diagnostics.routes.js
│   │   │   └── diagnostics.controller.js
│   │   └── health/
│   │       └── health.routes.js
│   ├── socket/
│   │   ├── index.js                    # Socket.IO setup + middleware
│   │   ├── handlers/
│   │   │   ├── connection.handler.js   # join, disconnect, reconnect
│   │   │   ├── call.handler.js         # initiate, accept, decline, end, cancel
│   │   │   └── heartbeat.handler.js    # health_ping, call_ping
│   │   └── state/
│   │       └── connectionManager.js    # In-memory user/call state management
│   ├── shared/
│   │   ├── constants.js                # COIN_RATES, MIN_BALANCE, PACKAGES, etc.
│   │   ├── errors.js                   # Custom error classes
│   │   └── responseHelper.js           # Standardized API responses
│   └── utils/
│       ├── logger.js                   # Logging utility
│       └── statsSyncUtil.js            # Stats sync utility
├── tests/
│   ├── setup.js                        # Test config + mocks
│   ├── features/
│   │   ├── payments.test.js            # Payment verification tests
│   │   ├── calls.test.js               # Call billing tests
│   │   └── health.test.js              # Health endpoint test
│   └── helpers/
│       └── mockFirestore.js            # Firestore test mocks
├── docs/
│   ├── swagger.yaml                    # Static OpenAPI spec (exported)
│   └── plans/                          # Design & plan documents
├── ecosystem.config.js                 # PM2 config (updated path)
├── package.json                        # Updated with type: "module"
└── .env.example                        # All env vars documented
```

---

## 3. Layer Responsibilities

### Routes
- Define endpoint paths, HTTP methods
- Attach middleware (auth, validation)
- Delegate to controller
- **No business logic**

### Controllers
- Parse request params/body
- Call service methods
- Return HTTP responses via `responseHelper`
- **No database access, no business logic**

### Services
- All business logic
- Database operations (Firestore reads/writes)
- External API calls (Razorpay, Twilio)
- Calculations (coin deduction, earnings, fraud detection)
- Services can call other services

### Validators
- Request body validation for complex inputs
- Only used where needed (calls, payments)

---

## 4. Feature Specifications

### 4.1 Auth (`/api/auth`)

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/auth/check-user` | POST | Public | Check if user exists by phone number |

**Service logic:**
- Query Firestore `users` where `phoneNumber == input`
- Return sanitized user object (userId, name, gender, isVerified, profileImageUrl)
- Return `{ exists: false }` if not found

---

### 4.2 Health (`/api/health`)

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/health` | GET | Public | Server health + infrastructure status |

**Response includes:**
- Server status, memory usage (RSS, heap), uptime
- Active connections count, active calls count
- Redis connectivity status
- Firestore connectivity status

---

### 4.3 Diagnostics (`/api/diagnostic`)

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/diagnostic/connections` | GET | Admin API Key | All Socket.IO connections |
| `/api/diagnostic/user/:userId` | GET | Admin API Key | Specific user connection state |

**Data source:** `connectionManager` in-memory state

---

### 4.4 Packages (`/api/packages`)

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/packages` | GET | Public | Available coin packages |

**Packages (from constants):**
| ID | Coins | Price (INR) | Discount |
|----|-------|-------------|----------|
| starter_pack | 100 | 99 | 10% |
| popular_pack | 500 | 399 | 20% |
| value_pack | 1000 | 699 | 30% |
| premium_pack | 2500 | 1499 | 25% |

---

### 4.5 Users (`/api/user`)

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/user/:userId/balance` | GET | Firebase Token | Get coin balance |

**Service logic:**
- Read Firestore `users/{userId}`
- Return `coinBalance` field (with fallback to `coins` field for legacy compat)
- Return `lastUpdated` timestamp

---

### 4.6 Availability

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/check_availability` | POST | Firebase Token | Check if recipient is available |
| `/api/update_availability` | POST | Firebase Token | Toggle user availability |
| `/api/get_available_females` | GET | Firebase Token | List available female users |

**check_availability logic:**
1. Check Redis `user_status:{recipientId}` first
2. Fallback to Firestore `users/{recipientId}.isAvailable`
3. Check `connectionManager` for active call status
4. Return `{ is_available, user_status, current_call_id }`

**update_availability logic:**
1. Update Redis `user_status:{userId}`
2. Update Firestore `users/{userId}.isAvailable`
3. Broadcast `availability_changed` event via Socket.IO

**get_available_females logic:**
1. Query Firestore: `gender == 'female' AND isAvailable == true`
2. Enrich with online status from `connectionManager`
3. Enrich with stats (rating, totalCalls, totalLikes)
4. Sort: online users first, then by rating descending

---

### 4.7 Calls

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/calls/start` | POST | Firebase Token | Start call + server-side billing |
| `/api/calls/complete` | POST | Firebase Token | Complete call + deduct coins |
| `/api/calls/heartbeat` | POST | Firebase Token | Call keep-alive |
| `/api/call/:callId` | GET | Firebase Token | Get call details |
| `/api/check_call_status` | POST | Firebase Token | Check if call is active |
| `/api/validate_balance` | POST | Firebase Token | Validate sufficient balance |
| `/api/generate_token` | POST | Firebase Token | Generate Twilio token |
| `/api/start_call_tracking` | POST | Firebase Token | **Legacy** — redirects to calls/start |
| `/api/complete_call` | POST | Firebase Token | **Legacy** — redirects to calls/complete |

**calls/start — Critical path:**
1. Validate caller balance: video ≥ 120 coins, audio ≥ 24 coins
2. Check no concurrent active call for caller OR recipient
3. Create Firestore `calls/{callId}` doc with status `initiated`
4. Start server-side timer in `connectionManager.activeCalls`
5. Return `{ success, callId, callerBalance, coinRate }`

**calls/complete — Critical path:**
1. Get server-side duration from `connectionManager` timer
2. Compare with client-reported `client_duration_seconds`
3. Flag fraud if difference > 5 seconds
4. Calculate coins: `serverDuration × coinRate`
5. Deduct from caller balance via **Firestore transaction** (atomic)
6. Calculate female earnings: audio ₹0.15/sec, video ₹0.80/sec
7. Update `female_earnings/{recipientId}` main doc + `daily/{date}` subdoc
8. Create earning transaction in `female_earnings/{recipientId}/transactions/{callId}`
9. Update `calls/{callId}` with final status, duration, coins
10. Update `admin_analytics/call_stats` and `admin_analytics/financial_stats`
11. Clean up `connectionManager.activeCalls` entry

**generate_token logic:**
- Create Twilio AccessToken with VideoGrant
- Grant access to specified room
- TTL: 30 minutes
- Return `{ accessToken, room_name, coin_rate_per_second, expiresAt }`

**validate_balance logic:**
- Calculate: `MIN_CALL_DURATION × coinRate`
- Compare with `current_balance`
- Return `{ success, current_balance, required_balance, coin_rate_per_second }`

---

### 4.8 Payments (`/api/payments`)

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/payments/orders` | POST | Firebase Token | Create Razorpay order |
| `/api/payments/verify` | POST | Firebase Token | Verify payment + credit coins |

**orders logic:**
- Look up package by `packageId` from constants
- Create Razorpay order with `payment_capture: 1` (auto-capture)
- Return `{ order_id, amount, currency, key_id }`

**verify — Critical path:**
1. Compute HMAC-SHA256 signature: `orderId + "|" + paymentId` with Razorpay secret
2. Compare with provided signature
3. Check `payment_verifications/{orderId}` for duplicate (idempotency)
4. If duplicate, return existing verification (don't double-credit)
5. Credit coins via **Firestore transaction** (atomic):
   - Increment `users/{userId}.coinBalance`
   - Create `transactions/{txnId}` document
   - Create `payment_verifications/{orderId}` document
6. Return `{ isValid, verificationId, coinsCredited, newBalance }`

---

### 4.9 Rewards (`/api/rewards`)

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/rewards/daily-claim` | POST | Firebase Token | Claim daily 10 coins |

**Logic:**
1. Read `users/{userId}.lastDailyRewardAt`
2. Check 24-hour cooldown elapsed
3. Credit 10 coins via Firestore transaction
4. Update `lastDailyRewardAt`
5. Create transaction record
6. Return `{ success, coins, claimedAt, nextClaimTime }`

---

### 4.10 Payouts

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/razorpay/contact-sync` | POST | Firebase Token | Sync bank/UPI account to Razorpay |
| `/api/female/payouts` | POST | Firebase Token | Initiate payout |

**contact-sync logic:**
1. Create/update Razorpay Contact
2. Create Razorpay Fund Account (bank_account or vpa/UPI)
3. Store `contactId` and `fundAccountId` in Firestore
4. Return `{ contactId, fundAccountId, status }`

**payouts logic:**
1. Validate `availableBalanceINR` in `female_earnings/{userId}`
2. Create Razorpay Payout (mode: IMPS)
3. Deduct from available balance
4. Return `{ payoutId, status, referenceId }`

---

### 4.11 Stats

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/refresh_user_stats` | POST | Firebase Token | Refresh single user stats |
| `/api/batch_refresh_stats` | POST | Firebase Token | Refresh up to 50 users |

**Logic:**
1. Read all docs from `users/{userId}/powerups` subcollection
2. Calculate: rating (0-10), totalCalls, totalLikes, totalDislikes
3. If powerups empty, fallback to main `users/{userId}` document fields
4. Return `{ stats: { rating, totalCalls, totalLikes, totalDislikes } }`

---

## 5. Socket.IO Architecture

### Connection Manager (Singleton)

Replaces global `Map` objects in current `server.js`:

```
State Maps:
├── connectedUsers    Map<userId, { socketId, userType, status, connectedAt }>
├── activeCalls       Map<callId, { callerId, recipientId, callType, startTime, lastHeartbeat, serverTimer }>
└── userSockets       Map<socketId, userId>  (reverse lookup)
```

**Methods:**
- `addUser(userId, socketId, userType)` — Register connection
- `removeUser(userId)` — Deregister connection
- `getUserStatus(userId)` — Get current status
- `setUserStatus(userId, status)` — Update status (available/busy/ringing/disconnected)
- `startCall(callId, data)` — Register active call + start timer
- `endCall(callId)` — Remove active call + stop timer
- `getActiveCall(callId)` — Get call data
- `isUserInCall(userId)` — Check if user in any active call
- `getCallByUser(userId)` — Find active call for user
- `updateHeartbeat(callId)` — Update last heartbeat timestamp
- `getStats()` — Return counts for health/diagnostics

### Socket Events

#### Client → Server

| Event | Handler | Payload | Action |
|-------|---------|---------|--------|
| `join` | connection.handler | `{ userId, userType }` | Register user, join room `user_{userId}`, update Redis + Firestore online status |
| `initiate_call` | call.handler | `{ callerId, recipientId, callType, callId, roomName, callerName }` | Validate both users connected, set statuses to `ringing`, emit `call_initiated` to recipient room. If recipient offline → send FCM notification |
| `accept_call` | call.handler | `{ callId, callerId, recipientId }` | Set both statuses to `busy`, emit `call_accepted` to caller room |
| `decline_call` | call.handler | `{ callId, callerId, recipientId }` | Reset statuses to `available`, emit `call_declined` to caller room |
| `end_call` | call.handler | `{ callId, userId }` | Emit `call_ended` to other party, reset statuses |
| `cancel_call` | call.handler | `{ callId, callerId, recipientId, reason }` | Emit `call_cancelled` to recipient, reset statuses |
| `call_ping` | heartbeat.handler | `{ callId, userId, timestamp }` | Update heartbeat, respond with `call_pong` |
| `health_ping` | heartbeat.handler | `{ userId, timestamp }` | Respond with `health_pong` |

#### Server → Client

| Event | Description |
|-------|-------------|
| `connected` | Connection confirmation |
| `joined` | Room join confirmation |
| `call_initiated` | Incoming call notification to recipient |
| `call_accepted` | Call accepted notification to caller |
| `call_declined` | Call declined notification to caller |
| `call_ended` | Call ended notification to other party |
| `call_cancelled` | Call cancelled notification to recipient |
| `call_failed` | Call failure notification |
| `call_timeout` | No response timeout |
| `call_pong` | Heartbeat response |
| `health_pong` | Health check response |
| `participant_disconnected` | Other party lost connection |
| `availability_updated` | User's own availability confirmed |
| `availability_changed` | Broadcast availability change |
| `error` | Error notification |

### Disconnect Handling
1. Socket disconnects → start 15-second grace timer
2. If reconnects within 15s → cancel timer, restore state
3. If timeout expires:
   - Mark user offline in Redis + Firestore
   - If user was in active call → notify other party via `participant_disconnected`
   - Trigger call completion flow if applicable
4. Force-close detection (app crash) → faster handling

### Socket.IO Config
- Ping interval: 25 seconds
- Ping timeout: 60 seconds
- Connection timeout: 45 seconds
- Upgrade timeout: 30 seconds
- Transports: WebSocket + polling fallback
- Redis adapter for clustering support

---

## 6. Shared Infrastructure

### Config (`config/index.js`)
Single source of truth for all environment variables:

```js
export const config = {
  port: process.env.PORT || 3000,
  host: process.env.HOST || '0.0.0.0',
  nodeEnv: process.env.NODE_ENV || 'development',
  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID || 'tingatalk-53057',
    serviceAccountPath: process.env.FIREBASE_SERVICE_ACCOUNT
  },
  redis: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: process.env.REDIS_PORT || 6379,
    password: process.env.REDIS_PASSWORD
  },
  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID,
    keySecret: process.env.RAZORPAY_KEY_SECRET,
    accountNumber: process.env.RAZORPAYX_ACCOUNT_NUMBER
  },
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    apiKeySid: process.env.TWILIO_API_KEY_SID,
    apiKeySecret: process.env.TWILIO_API_KEY_SECRET
  },
  admin: {
    apiKey: process.env.ADMIN_API_KEY
  },
  rateLimit: {
    windowMs: process.env.RATE_LIMIT_WINDOW_MS || 900000,
    maxRequests: process.env.RATE_LIMIT_MAX_REQUESTS || 100
  },
  cors: {
    origins: process.env.CORS_ORIGIN?.split(',') || ['*']
  },
  clustering: {
    enabled: process.env.ENABLE_CLUSTERING === 'true',
    instanceId: process.env.INSTANCE_ID
  },
  helmet: {
    enabled: process.env.HELMET_ENABLED !== 'false'
  },
  trustProxy: process.env.TRUST_PROXY === 'true'
};
```

### Constants (`shared/constants.js`)

```js
export const COIN_RATES = { audio: 0.2, video: 1.0 };
export const MIN_CALL_DURATION_SECONDS = 120;
export const MIN_BALANCE = { audio: 24, video: 120 };
export const DAILY_REWARD_COINS = 10;
export const DISCONNECT_TIMEOUT_MS = 15000;
export const MAX_CONCURRENT_CALLS = 1000;
export const TWILIO_TOKEN_TTL = 1800; // 30 minutes
export const FEMALE_EARNING_RATES = { audio: 0.15, video: 0.80 }; // INR per second

export const COIN_PACKAGES = {
  starter_pack:  { coinAmount: 100,  priceInRupees: 99,   discountPercent: 10 },
  popular_pack:  { coinAmount: 500,  priceInRupees: 399,  discountPercent: 20 },
  value_pack:    { coinAmount: 1000, priceInRupees: 699,  discountPercent: 30 },
  premium_pack:  { coinAmount: 2500, priceInRupees: 1499, discountPercent: 25 }
};

export const USER_STATUS = {
  AVAILABLE: 'available',
  UNAVAILABLE: 'unavailable',
  BUSY: 'busy',
  RINGING: 'ringing',
  DISCONNECTED: 'disconnected'
};

export const CALL_STATUS = {
  INITIATED: 'initiated',
  RINGING: 'ringing',
  ACCEPTED: 'accepted',
  BUSY: 'busy',
  COMPLETED: 'completed',
  DECLINED: 'declined',
  ENDED: 'ended',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  TIMEOUT: 'timeout'
};
```

### Custom Errors (`shared/errors.js`)

| Error Class | Status Code | Usage |
|-------------|-------------|-------|
| `AppError` | varies | Base class |
| `AuthenticationError` | 401 | Invalid/missing Firebase token |
| `AuthorizationError` | 403 | Admin endpoint without API key |
| `NotFoundError` | 404 | User/call not found |
| `ValidationError` | 400 | Invalid request body |
| `InsufficientBalanceError` | 400 | Not enough coins for call |
| `ConcurrentCallError` | 409 | User already in a call |
| `DuplicatePaymentError` | 409 | Payment already verified |

### Error Handler Middleware
- Catches all errors thrown via `next(error)`
- `AppError` subclasses → return structured JSON with correct status code
- Unknown errors → log full stack trace, return 500 with generic message
- Never expose internal details in production responses

---

## 7. Swagger / OpenAPI Documentation

### Implementation
- `swagger-jsdoc` reads JSDoc annotations from route files
- `swagger-ui-express` serves interactive docs at `GET /api/docs`
- npm script `swagger:export` generates static `docs/swagger.yaml`

### Documentation per endpoint
- Summary and description
- Request body schema (with required fields, types, examples)
- Response schemas (success + all error cases)
- Authentication requirements
- Rate limiting info

---

## 8. Testing Strategy

### Framework
**Vitest** — native ES Module support, fast execution, Jest-compatible API.

### Critical Tests (included in restructure)

| Test | What it validates |
|------|-------------------|
| Payment signature verification | Correct HMAC passes, tampered signature fails |
| Payment idempotency | Duplicate orderId returns existing verification, no double-credit |
| Coin deduction (video) | `duration × 1.0` calculated correctly |
| Coin deduction (audio) | `duration × 0.2` calculated correctly |
| Balance validation (video) | Rejects balance < 120, accepts ≥ 120 |
| Balance validation (audio) | Rejects balance < 24, accepts ≥ 24 |
| Fraud detection | Flags when server vs client duration > 5s |
| Daily reward cooldown | Rejects claim within 24h, accepts after |
| Female earnings calculation | audio ₹0.15/sec, video ₹0.80/sec |

### Mocking
- Firebase Admin SDK (Firestore, Auth) → in-memory mock
- Razorpay client → stub responses
- Redis client → in-memory mock
- Twilio → stub token generation

---

## 9. Deployment Plan

### VPS Details
- Server: `root@147.79.66.3`
- Process manager: PM2
- Current config: `ecosystem.config.js`

### Zero-Downtime Migration
1. Build and test new structure locally
2. SSH into VPS, deploy new code alongside existing
3. Run new server on port 3001, smoke test all endpoints
4. Update PM2 ecosystem config to point to `src/server.js`
5. `pm2 reload tingatalk` (zero-downtime reload)
6. Keep old `server.js` as rollback backup for 48 hours
7. Monitor logs via `pm2 logs` for any errors
8. Remove old monolith after confirming stability

### PM2 Config Update
```js
// ecosystem.config.js
module.exports = {
  apps: [{
    name: 'tingatalk',
    script: 'src/server.js',
    // ... rest stays the same
  }]
};
```

---

## 10. API Contract Guarantee

Every endpoint verified against Flutter app's expected contracts:
- **Same URL paths** — no changes to any route
- **Same request body field names** — exact match
- **Same response JSON structure** — exact match
- **Same HTTP status codes** — exact match
- **Same Socket.IO event names** — exact match
- **Same Socket.IO payload shapes** — exact match
- **Same error response formats** — exact match

The Flutter app requires **zero changes** after this migration.

---

## 11. Firestore Collections Reference

| Collection | Purpose | Key Fields |
|------------|---------|------------|
| `users` | User profiles & state | userId, phoneNumber, name, gender, coinBalance, isAvailable, isOnline, rating, fcmToken |
| `users/{id}/transactions` | Per-user transaction history | type, coinAmount, status |
| `users/{id}/spending` | Per-user spending history | callId, coinsDeducted |
| `users/{id}/earnings` | Per-user earning history | callId, amountEarned |
| `users/{id}/powerups` | Call ratings/feedback | like/dislike data |
| `calls` | Call logs | callId, callerId, recipientId, callType, status, duration, coinsDeducted |
| `female_earnings` | Female earnings aggregate | totalEarningsINR, availableBalanceINR, totalCalls |
| `female_earnings/{id}/daily` | Daily earnings breakdown | date, earnings, calls |
| `transactions` | Global transaction log | userId, type, coinAmount, paymentGatewayId |
| `payment_verifications` | Idempotency records | orderId, paymentId, coinsCredited |
| `admin_analytics` | Aggregate metrics | financial_stats, call_stats |
| `male_users_admin` | Admin tracking | Status tracking for male users |
