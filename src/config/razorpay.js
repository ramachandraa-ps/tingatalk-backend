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
