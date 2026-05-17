// ============================================================================
// Razorpay webhook routes
// ----------------------------------------------------------------------------
// Mounted PUBLICLY at /api/payments — no Bearer auth (Razorpay's servers
// can't send auth headers). Authentication is via HMAC-SHA256 over the raw
// request body using RAZORPAY_WEBHOOK_SECRET.
//
// This file exists as a SEPARATE router from payments.routes.js so that
// /orders and /verify can remain behind the authenticate middleware while
// /webhook is publicly reachable.
//
// app.js wires it up:
//   app.use('/api/payments', paymentsWebhookRoutes);     ← public
//   app.use('/api/payments', authenticate, paymentsRoutes); ← protected
// Express routes to the first matching path, so /webhook lands here.
// ============================================================================

import { Router } from 'express';
import { verifyWebhookSignature } from '../../config/razorpay.js';
import { logger } from '../../utils/logger.js';
import { creditPaymentToUser } from './creditPayment.js';

const router = Router();

/**
 * @openapi
 * /api/payments/webhook:
 *   post:
 *     tags:
 *       - Payments
 *     summary: Razorpay server-to-server webhook (payment.captured safety net)
 *     description: |
 *       Razorpay calls this endpoint within seconds of a successful payment,
 *       independent of the Flutter client. If the client also calls /verify,
 *       idempotency dedupes (payment_verifications/{orderId}); if the client
 *       never calls /verify (app crash, network drop, force-kill), this webhook
 *       still credits the coins.
 *
 *       Authentication: HMAC-SHA256 over the raw request body using the
 *       RAZORPAY_WEBHOOK_SECRET. Verified against header X-Razorpay-Signature.
 *
 *       Subscribed events: payment.captured (only event that triggers crediting).
 *       Other events are 200-ACKed to stop Razorpay retries.
 *
 *       This route requires raw-body capture (req.rawBody) — see app.js
 *       express.json({ verify }) hook.
 *     responses:
 *       200:
 *         description: Webhook accepted (credited, deduplicated, or ignored)
 *       400:
 *         description: Malformed payload
 *       401:
 *         description: Invalid HMAC signature
 *       500:
 *         description: Internal error (Razorpay will retry)
 */
router.post('/webhook', async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];

  if (!verifyWebhookSignature(req.rawBody, signature)) {
    logger.warn('WEBHOOK_REJECTED: invalid signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const event = req.body;
  const eventType = event?.event;

  // Only payment.captured triggers a credit. Razorpay sends many other event
  // types (order.paid, payment.authorized, refund.created, etc.) — ACK them
  // with 200 so Razorpay's retry mechanism doesn't keep hammering us.
  if (eventType !== 'payment.captured') {
    logger.info(`WEBHOOK_IGNORED: event=${eventType}`);
    return res.json({ ok: true, ignored: true, event: eventType });
  }

  try {
    const payment = event?.payload?.payment?.entity;
    if (!payment) {
      logger.error('WEBHOOK_BAD_PAYLOAD: missing payload.payment.entity');
      return res.status(400).json({ error: 'Malformed webhook payload' });
    }

    const orderId = payment.order_id;
    const paymentId = payment.id;
    const userId = payment.notes?.userId;
    const packageId = payment.notes?.packageId;

    if (!orderId || !paymentId || !userId || !packageId) {
      logger.error(`WEBHOOK_INCOMPLETE_NOTES: orderId=${orderId} paymentId=${paymentId} userId=${userId} packageId=${packageId}`);
      // 200 — these notes won't populate retroactively, no point retrying
      return res.json({ ok: true, ignored: true, reason: 'incomplete_notes' });
    }

    const result = await creditPaymentToUser({
      orderId, paymentId, userId, packageId,
      source: 'razorpay_webhook',
      signature: null,
    });

    logger.info(`WEBHOOK_CREDITED: orderId=${orderId} paymentId=${paymentId} userId=${userId} coins=${result.coinsCredited} duplicate=${result.duplicate}`);
    return res.json({ ok: true, duplicate: result.duplicate, coinsCredited: result.coinsCredited });
  } catch (error) {
    logger.error('WEBHOOK_ERROR:', error);
    // 500 so Razorpay retries (it retries failed webhooks per its docs)
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
});

export default router;
