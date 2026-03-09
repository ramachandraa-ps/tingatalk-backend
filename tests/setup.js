// ============================================================================
// Test Setup — Mock external dependencies
// ============================================================================

import { vi } from 'vitest';

// Mock Firebase Admin
vi.mock('../src/config/firebase.js', () => ({
  initFirebase: vi.fn(),
  getFirestore: vi.fn(() => null),
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
}));

// Mock Redis
vi.mock('../src/config/redis.js', () => ({
  initRedis: vi.fn(),
  getRedis: vi.fn(() => null),
  setupSocketIOAdapter: vi.fn(),
  cleanupRedis: vi.fn()
}));

// Mock Razorpay
vi.mock('../src/config/razorpay.js', () => ({
  razorpayClient: {
    orders: { create: vi.fn() },
    payments: { fetch: vi.fn() }
  },
  razorpayApi: { post: vi.fn() },
  verifyPaymentSignature: vi.fn()
}));

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.PORT = '3001';
process.env.ADMIN_API_KEY = 'test-admin-key';
process.env.FIREBASE_PROJECT_ID = 'test-project';
process.env.RAZORPAY_KEY_ID = 'rzp_test_xxx';
process.env.RAZORPAY_KEY_SECRET = 'test_secret';
