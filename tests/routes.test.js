import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'http';

// Mock swagger dependencies before any imports
vi.mock('swagger-jsdoc', () => ({
  default: vi.fn(() => ({
    openapi: '3.0.0',
    info: { title: 'TingaTalk API', version: '2.0.0' },
    paths: {}
  }))
}));
vi.mock('swagger-ui-express', () => ({
  default: {
    serve: [(req, res, next) => next()],
    setup: () => (req, res, next) => res.json({ swagger: true })
  }
}));

// Mock Firebase admin
vi.mock('../src/config/firebase.js', () => {
  const mockDb = {
    collection: vi.fn((name) => ({
      doc: vi.fn((id) => ({
        get: vi.fn().mockResolvedValue({
          exists: true,
          id: id || 'test-doc',
          data: () => ({
            coins: 500, coinBalance: 500, name: 'Test User',
            gender: 'male', isVerified: true, phoneNumber: '9876543210',
            isAvailable: true
          })
        }),
        set: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({})
      })),
      where: vi.fn(function() {
        return {
          where: vi.fn(function() {
            return {
              where: vi.fn(function() {
                return { get: vi.fn().mockResolvedValue({ empty: true, docs: [] }) };
              }),
              limit: vi.fn(function() {
                return { get: vi.fn().mockResolvedValue({ empty: true, docs: [] }) };
              }),
              get: vi.fn().mockResolvedValue({ empty: true, docs: [] })
            };
          }),
          limit: vi.fn(function() {
            return {
              get: vi.fn().mockResolvedValue({
                empty: false,
                docs: [{
                  id: 'user123',
                  data: () => ({
                    name: 'Test', gender: 'male', isVerified: true,
                    profileImageUrl: null, phoneNumber: '9876543210'
                  })
                }]
              })
            };
          }),
          get: vi.fn().mockResolvedValue({ empty: true, docs: [] })
        };
      })
    })),
    runTransaction: vi.fn(async (fn) => fn({
      get: vi.fn().mockResolvedValue({
        exists: true,
        data: () => ({ coins: 500, coinBalance: 500 })
      }),
      set: vi.fn(),
      update: vi.fn()
    }))
  };

  return {
    initFirebase: vi.fn(),
    getFirestore: vi.fn(() => mockDb),
    getMessaging: vi.fn(() => null),
    admin: {
      auth: vi.fn(() => ({
        verifyIdToken: vi.fn().mockResolvedValue({ uid: 'test-user-123' })
      })),
      firestore: {
        FieldValue: {
          serverTimestamp: vi.fn(() => new Date()),
          increment: vi.fn((n) => n)
        },
        Timestamp: {
          fromDate: vi.fn((d) => d)
        }
      }
    }
  };
});

// Mock Redis
vi.mock('../src/config/redis.js', () => ({
  initRedis: vi.fn(),
  getRedis: vi.fn(() => ({
    ping: vi.fn().mockResolvedValue('PONG'),
    hset: vi.fn().mockResolvedValue(1),
    hdel: vi.fn().mockResolvedValue(1)
  })),
  setupSocketIOAdapter: vi.fn(),
  cleanupRedis: vi.fn()
}));

// Mock Razorpay
vi.mock('../src/config/razorpay.js', () => ({
  razorpayClient: {
    orders: {
      create: vi.fn().mockResolvedValue({
        id: 'order_test123', amount: 39900, currency: 'INR'
      })
    },
    payments: { fetch: vi.fn() }
  },
  razorpayApi: { post: vi.fn() },
  verifyPaymentSignature: vi.fn(() => true)
}));

// Mock Twilio
vi.mock('../src/config/twilio.js', () => ({
  generateAccessToken: vi.fn(() => 'mock-twilio-token')
}));

// Disable helmet for tests
process.env.HELMET_ENABLED = 'false';
process.env.NODE_ENV = 'test';
process.env.PORT = '3099';
process.env.ADMIN_API_KEY = 'test-admin-key';
process.env.RAZORPAY_KEY_ID = 'rzp_test_xxx';
process.env.RAZORPAY_KEY_SECRET = 'test_secret';

let server;
let baseUrl;

// Helper to make HTTP requests
function req(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    };

    const request = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let body;
        try { body = JSON.parse(data); } catch { body = data; }
        resolve({ status: res.statusCode, body });
      });
    });

    request.on('error', reject);

    if (body) {
      request.write(JSON.stringify(body));
    }
    request.end();
  });
}

beforeAll(async () => {
  const { createApp } = await import('../src/app.js');
  const { app } = createApp();

  // Set a mock io object
  const mockIo = {
    sockets: {
      sockets: new Map(),
      emit: vi.fn()
    },
    to: vi.fn(() => ({ emit: vi.fn() })),
    emit: vi.fn()
  };
  app.set('io', mockIo);

  // Start a real HTTP server
  server = http.createServer(app);
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
});

describe('Route Wiring Tests', () => {
  // ===== PUBLIC ROUTES (no auth) =====

  describe('GET /api/health', () => {
    it('should return 200 with health data', async () => {
      const res = await req('GET', '/api/health');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('status', 'OK');
      expect(res.body).toHaveProperty('timestamp');
      expect(res.body).toHaveProperty('activeCalls');
      expect(res.body).toHaveProperty('connectedUsers');
      expect(res.body).toHaveProperty('infrastructure');
      expect(res.body).toHaveProperty('serverInfo');
      expect(res.body.serverInfo).toHaveProperty('uptime');
      expect(res.body.serverInfo).toHaveProperty('memoryUsage');
    });
  });

  describe('POST /api/auth/check-user', () => {
    it('should return 400 when phoneNumber is missing', async () => {
      const res = await req('POST', '/api/auth/check-user', {});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('phoneNumber');
    });

    it('should return 400 for short phone number', async () => {
      const res = await req('POST', '/api/auth/check-user', { phoneNumber: '123' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid');
    });

    it('should return user data for valid phone number', async () => {
      const res = await req('POST', '/api/auth/check-user', { phoneNumber: '9876543210' });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('exists');
      expect(res.body).toHaveProperty('user');
    });
  });

  describe('GET /api/packages', () => {
    it('should return all 4 active coin packages', async () => {
      const res = await req('GET', '/api/packages');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('packages');
      expect(Array.isArray(res.body.packages)).toBe(true);
      expect(res.body.packages.length).toBe(4);
    });

    it('should have correct package structure', async () => {
      const res = await req('GET', '/api/packages');
      const pkg = res.body.packages.find(p => p.id === 'popular_pack');
      expect(pkg).toBeDefined();
      expect(pkg.coinAmount).toBe(500);
      expect(pkg.priceInRupees).toBe(399);
      expect(pkg.isPopular).toBe(true);
      expect(pkg.discountPercent).toBe(20);
      expect(pkg.isActive).toBe(true);
    });
  });

  // ===== AUTHENTICATED ROUTES (should reject without auth) =====

  describe('Protected routes without auth token', () => {
    it('GET /api/user/test123/balance → 401', async () => {
      const res = await req('GET', '/api/user/test123/balance');
      expect(res.status).toBe(401);
    });

    it('POST /api/check_availability → 401', async () => {
      const res = await req('POST', '/api/check_availability', { recipient_id: 'u1' });
      expect(res.status).toBe(401);
    });

    it('POST /api/payments/orders → 401', async () => {
      const res = await req('POST', '/api/payments/orders', { packageId: 'starter_pack' });
      expect(res.status).toBe(401);
    });

    it('POST /api/rewards/daily-claim → 401', async () => {
      const res = await req('POST', '/api/rewards/daily-claim', {});
      expect(res.status).toBe(401);
    });

    it('POST /api/calls/start → 401', async () => {
      const res = await req('POST', '/api/calls/start', { callId: 'c1' });
      expect(res.status).toBe(401);
    });

    it('POST /api/validate_balance → 401', async () => {
      const res = await req('POST', '/api/validate_balance', { user_id: 'u1' });
      expect(res.status).toBe(401);
    });

    it('POST /api/generate_token → 401', async () => {
      const res = await req('POST', '/api/generate_token', { user_identity: 'u1' });
      expect(res.status).toBe(401);
    });

    it('POST /api/razorpay/contact-sync → 401', async () => {
      const res = await req('POST', '/api/razorpay/contact-sync', {});
      expect(res.status).toBe(401);
    });

    it('POST /api/refresh_user_stats → 401', async () => {
      const res = await req('POST', '/api/refresh_user_stats', { user_id: 'u1' });
      expect(res.status).toBe(401);
    });
  });

  // ===== AUTHENTICATED ROUTES WITH TOKEN =====

  describe('Authenticated routes with valid token', () => {
    const auth = { Authorization: 'Bearer valid-test-token' };

    it('GET /api/user/test123/balance → balance data', async () => {
      const res = await req('GET', '/api/user/test123/balance', null, auth);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.balance).toBe(500);
      expect(res.body.currency).toBe('coins');
      expect(res.body).toHaveProperty('timestamp');
    });

    it('POST /api/check_availability → availability status', async () => {
      const res = await req('POST', '/api/check_availability', { recipient_id: 'user1' }, auth);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body).toHaveProperty('is_available');
      expect(res.body).toHaveProperty('user_status');
      expect(res.body).toHaveProperty('message');
    });

    it('POST /api/update_availability → validates required fields', async () => {
      const res = await req('POST', '/api/update_availability', { user_id: 'u1' }, auth);
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Missing required fields');
    });

    it('POST /api/update_availability → updates when valid', async () => {
      const res = await req('POST', '/api/update_availability', {
        user_id: 'u1', is_available: true
      }, auth);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.is_available).toBe(true);
      expect(res.body.status).toBe('available');
    });

    it('POST /api/validate_balance → balance check', async () => {
      const res = await req('POST', '/api/validate_balance', {
        user_id: 'u1', call_type: 'video', current_balance: 200
      }, auth);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('has_sufficient_balance');
      expect(res.body).toHaveProperty('required_balance', 120);
      expect(res.body).toHaveProperty('coin_rate_per_second', 1.0);
      expect(res.body).toHaveProperty('minimum_duration_seconds', 120);
    });

    it('POST /api/validate_balance → insufficient balance', async () => {
      const res = await req('POST', '/api/validate_balance', {
        user_id: 'u1', call_type: 'video', current_balance: 50
      }, auth);
      expect(res.status).toBe(200);
      expect(res.body.has_sufficient_balance).toBe(false);
    });

    it('POST /api/payments/orders → creates order for valid package', async () => {
      const res = await req('POST', '/api/payments/orders', {
        packageId: 'popular_pack'
      }, auth);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('order_id');
      expect(res.body).toHaveProperty('amount');
      expect(res.body).toHaveProperty('currency');
      expect(res.body).toHaveProperty('key_id');
    });

    it('POST /api/payments/orders → rejects invalid package', async () => {
      const res = await req('POST', '/api/payments/orders', {
        packageId: 'nonexistent_pack'
      }, auth);
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Unknown packageId');
    });

    it('POST /api/generate_token → validates required fields', async () => {
      const res = await req('POST', '/api/generate_token', {}, auth);
      expect(res.status).toBe(400);
    });

    it('POST /api/generate_token → generates token', async () => {
      const res = await req('POST', '/api/generate_token', {
        user_identity: 'user1', room_name: 'video_user1_user2'
      }, auth);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('accessToken');
      expect(res.body).toHaveProperty('room_name');
      expect(res.body).toHaveProperty('coin_rate_per_second');
    });
  });

  // ===== ADMIN ROUTES =====

  describe('Admin diagnostic routes', () => {
    it('GET /api/diagnostic/connections → 403 without admin key', async () => {
      const res = await req('GET', '/api/diagnostic/connections');
      expect(res.status).toBe(403);
    });

    it('GET /api/diagnostic/connections → returns data with admin key', async () => {
      const res = await req('GET', '/api/diagnostic/connections', null, {
        'x-admin-api-key': 'test-admin-key'
      });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('connectedUsers');
      expect(res.body).toHaveProperty('activeCalls');
      expect(res.body).toHaveProperty('timestamp');
    });
  });

  // ===== 404 =====

  describe('404 handling', () => {
    it('unknown /api/* routes return 401 (auth required before 404)', async () => {
      const res = await req('GET', '/api/nonexistent');
      expect(res.status).toBe(401);
    });

    it('unknown non-api routes return 404', async () => {
      const res = await req('GET', '/totally-unknown');
      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('error', 'Endpoint not found');
    });
  });

  // ===== SWAGGER DOCS =====

  describe('Swagger documentation', () => {
    it('GET /api-docs.json → returns swagger spec', async () => {
      const res = await req('GET', '/api-docs.json');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('openapi', '3.0.0');
      expect(res.body).toHaveProperty('info');
      expect(res.body.info).toHaveProperty('title');
    });
  });
});

describe('API Contract Verification', () => {
  const auth = { Authorization: 'Bearer valid-test-token' };

  it('packages match Flutter app expected structure', async () => {
    const res = await req('GET', '/api/packages');
    for (const pkg of res.body.packages) {
      expect(pkg).toHaveProperty('id');
      expect(pkg).toHaveProperty('name');
      expect(pkg).toHaveProperty('coinAmount');
      expect(pkg).toHaveProperty('priceInRupees');
      expect(pkg).toHaveProperty('discountPercent');
      expect(pkg).toHaveProperty('isPopular');
      expect(pkg).toHaveProperty('isActive');
    }
  });

  it('balance endpoint returns dual-field compatible balance', async () => {
    const res = await req('GET', '/api/user/test123/balance', null, auth);
    // Should work with either coinBalance or coins field
    expect(typeof res.body.balance).toBe('number');
    expect(res.body.balance).toBe(500);
  });

  it('validate_balance uses correct coin rates', async () => {
    const videoRes = await req('POST', '/api/validate_balance', {
      user_id: 'u1', call_type: 'video', current_balance: 200
    }, auth);
    expect(videoRes.body.coin_rate_per_second).toBe(1.0);
    expect(videoRes.body.required_balance).toBe(120); // 1.0 * 120s

    const audioRes = await req('POST', '/api/validate_balance', {
      user_id: 'u1', call_type: 'audio', current_balance: 200
    }, auth);
    expect(audioRes.body.coin_rate_per_second).toBe(0.2);
    expect(audioRes.body.required_balance).toBe(24); // 0.2 * 120s
  });

  it('availability check returns expected fields for Flutter', async () => {
    const res = await req('POST', '/api/check_availability', { recipient_id: 'u1' }, auth);
    expect(res.body).toHaveProperty('success');
    expect(res.body).toHaveProperty('is_available');
    expect(res.body).toHaveProperty('user_status');
    expect(res.body).toHaveProperty('current_call_id');
    expect(res.body).toHaveProperty('message');
  });
});
