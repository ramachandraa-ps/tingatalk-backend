import Razorpay from 'razorpay';
import axios from 'axios';
import crypto from 'crypto';
import { config } from './index.js';
import { logger } from '../utils/logger.js';

if (!config.razorpay.keyId || !config.razorpay.keySecret) {
  logger.error('FATAL: Missing Razorpay credentials. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env');
  process.exit(1);
}

export const razorpayClient = new Razorpay({
  key_id: config.razorpay.keyId,
  key_secret: config.razorpay.keySecret
});

export const razorpayApi = axios.create({
  baseURL: 'https://api.razorpay.com/v1',
  auth: {
    username: config.razorpay.keyId,
    password: config.razorpay.keySecret
  },
  timeout: 10000
});

export function verifyPaymentSignature(orderId, paymentId, signature) {
  const hmac = crypto.createHmac('sha256', config.razorpay.keySecret);
  hmac.update(`${orderId}|${paymentId}`);
  return hmac.digest('hex') === signature;
}

/**
 * Verify the HMAC signature on a Razorpay webhook delivery.
 * Per Razorpay docs: HMAC-SHA256(rawBody, webhookSecret) === header X-Razorpay-Signature
 *
 * The rawBody MUST be the literal request body bytes — NOT a re-serialized JSON object,
 * because key-ordering or whitespace changes break the HMAC. The webhook route uses
 * express.json({ verify: (req, _res, buf) => { req.rawBody = buf } }) to capture it.
 */
export function verifyWebhookSignature(rawBody, signature) {
  if (!config.razorpay.webhookSecret) {
    logger.error('RAZORPAY_WEBHOOK_SECRET not configured — refusing to verify webhook');
    return false;
  }
  if (!rawBody || !signature) return false;
  const hmac = crypto.createHmac('sha256', config.razorpay.webhookSecret);
  hmac.update(rawBody);
  const expected = hmac.digest('hex');
  // timingSafeEqual to avoid timing attacks
  if (expected.length !== signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
}
