import { Router } from 'express';
import { getFirestore, admin } from '../../config/firebase.js';
import { razorpayClient, verifyPaymentSignature } from '../../config/razorpay.js';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { COIN_PACKAGES } from '../../shared/constants.js';

const router = Router();

/**
 * @openapi
 * /api/payments/orders:
 *   post:
 *     tags:
 *       - Payments
 *     summary: Create a Razorpay order
 *     description: Creates a Razorpay payment order for a coin package purchase. The authenticated user ID is extracted from the Bearer token.
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - packageId
 *             properties:
 *               packageId:
 *                 type: string
 *                 description: ID of the coin package to purchase
 *               currency:
 *                 type: string
 *                 default: INR
 *               userName:
 *                 type: string
 *               coins:
 *                 type: integer
 *               receipt:
 *                 type: string
 *               notes:
 *                 type: object
 *     responses:
 *       200:
 *         description: Razorpay order created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 order_id:
 *                   type: string
 *                 amount:
 *                   type: integer
 *                   description: Amount in paise
 *                 currency:
 *                   type: string
 *                 key_id:
 *                   type: string
 *       400:
 *         description: Missing fields or unknown packageId
 *       500:
 *         description: Server error
 */
router.post('/orders', async (req, res) => {
  try {
    const { currency = 'INR', userName, packageId, coins, receipt, notes, userId: bodyUserId } = req.body;
    // Use session ID from body (user_xxx_xxx) — NOT req.authenticatedUserId (Firebase Auth UID)
    const userId = bodyUserId || req.authenticatedUserId;
    if (!userId || !packageId) return res.status(400).json({ error: 'userId and packageId are required' });

    const coinPackage = COIN_PACKAGES[packageId];
    if (!coinPackage) {
      return res.status(400).json({
        error: `Unknown packageId: ${packageId}`,
        availablePackages: Object.keys(COIN_PACKAGES)
      });
    }

    const amountInPaise = Math.round(coinPackage.priceInRupees * 100);
    const order = await razorpayClient.orders.create({
      amount: amountInPaise, currency,
      receipt: receipt || `order_${Date.now()}`,
      payment_capture: 1,
      notes: { userId, userName: userName || 'TingaTalk User', packageId, coins: coins || '', ...notes }
    });

    res.json({ order_id: order.id, amount: order.amount, currency: order.currency, key_id: config.razorpay.keyId });
  } catch (error) {
    logger.error('Error creating Razorpay order:', error);
    res.status(500).json({ error: 'Failed to create Razorpay order' });
  }
});

/**
 * @openapi
 * /api/payments/verify:
 *   post:
 *     tags:
 *       - Payments
 *     summary: Verify a Razorpay payment and credit coins
 *     description: Verifies the Razorpay payment signature, credits coins to the user in a Firestore transaction, records the transaction, and updates analytics. Supports idempotency via payment_verifications collection.
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - orderId
 *               - paymentId
 *               - signature
 *             properties:
 *               orderId:
 *                 type: string
 *               paymentId:
 *                 type: string
 *               signature:
 *                 type: string
 *     responses:
 *       200:
 *         description: Payment verified and coins credited
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 isValid:
 *                   type: boolean
 *                 verificationId:
 *                   type: string
 *                 paymentId:
 *                   type: string
 *                 transactionId:
 *                   type: string
 *                 coinsCredited:
 *                   type: integer
 *                 newBalance:
 *                   type: number
 *                 verifiedAt:
 *                   type: string
 *                   format: date-time
 *                 duplicate:
 *                   type: boolean
 *                   description: True if this payment was already verified
 *       400:
 *         description: Missing fields, invalid signature, or unknown packageId
 *       500:
 *         description: Server error
 */
router.post('/verify', async (req, res) => {
  try {
    const { orderId, paymentId, signature, userId: bodyUserId } = req.body;
    // Use session ID from body (user_xxx_xxx) — NOT req.authenticatedUserId (Firebase Auth UID)
    const userId = bodyUserId || req.authenticatedUserId;

    if (!orderId || !paymentId || !signature) {
      return res.status(400).json({ error: 'orderId, paymentId and signature are required' });
    }

    const isValid = verifyPaymentSignature(orderId, paymentId, signature);
    if (!isValid) return res.status(400).json({ error: 'Invalid payment signature' });

    const db = getFirestore();

    // Idempotency check
    const existingVerification = await db.collection('payment_verifications').doc(orderId).get();
    if (existingVerification.exists) {
      const existing = existingVerification.data();
      return res.json({
        isValid: true, verificationId: existing.verificationId,
        paymentId: existing.paymentId, coinsCredited: existing.coinsCredited,
        newBalance: existing.newBalance, verifiedAt: existing.verifiedAt, duplicate: true
      });
    }

    // Look up packageId from Razorpay order notes
    let packageId;
    try {
      const razorpayOrder = await razorpayClient.orders.fetch(orderId);
      packageId = razorpayOrder.notes?.packageId;
    } catch (err) {
      return res.status(500).json({ error: 'Failed to fetch order details from Razorpay' });
    }

    if (!packageId || !COIN_PACKAGES[packageId]) {
      return res.status(400).json({ error: `Invalid or unknown packageId: ${packageId}` });
    }

    const coinPackage = COIN_PACKAGES[packageId];
    const verificationId = `ver_${Date.now()}`;
    const verifiedAt = new Date().toISOString();
    const userRef = db.collection('users').doc(userId);
    const transactionId = `txn_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;

    const transactionData = {
      id: transactionId, userId, type: 'purchase', status: 'success',
      coinAmount: coinPackage.coinAmount, priceInRupees: coinPackage.priceInRupees,
      packageId: coinPackage.id, paymentGatewayId: paymentId, paymentMethod: 'razorpay',
      description: `Purchased ${coinPackage.name} - ${coinPackage.coinAmount} coins`,
      createdAt: verifiedAt, updatedAt: verifiedAt,
      metadata: { verificationId, orderId, paymentSignature: signature, purchaseSource: 'server_authoritative', verifiedAt }
    };

    let newBalance = 0;
    await db.runTransaction(async (t) => {
      const userDoc = await t.get(userRef);
      const currentBalance = userDoc.exists ? (userDoc.data().coins ?? 0) : 0;
      newBalance = currentBalance + coinPackage.coinAmount;

      t.update(userRef, {
        coins: admin.firestore.FieldValue.increment(coinPackage.coinAmount),
        totalCoinsPurchased: admin.firestore.FieldValue.increment(coinPackage.coinAmount),
        totalPurchaseCount: admin.firestore.FieldValue.increment(1),
        lastActiveAt: admin.firestore.FieldValue.serverTimestamp()
      });

      t.set(db.collection('users').doc(userId).collection('transactions').doc(transactionId), transactionData);

      t.set(db.collection('payment_verifications').doc(orderId), {
        orderId, paymentId, userId, verificationId,
        packageId: coinPackage.id, coinsCredited: coinPackage.coinAmount,
        priceInRupees: coinPackage.priceInRupees, newBalance, verifiedAt,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    // Admin analytics (non-critical)
    try {
      await db.collection('admin_analytics').doc('financial_stats').set({
        totalRevenue: admin.firestore.FieldValue.increment(coinPackage.priceInRupees),
        todayRevenue: admin.firestore.FieldValue.increment(coinPackage.priceInRupees),
        lastUpdated: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    } catch (err) { logger.warn('Admin analytics update failed:', err.message); }

    logger.info(`Payment verified: ${coinPackage.coinAmount} coins to user ${userId}`);

    res.json({
      isValid: true, verificationId, paymentId, transactionId,
      coinsCredited: coinPackage.coinAmount, newBalance, verifiedAt
    });
  } catch (error) {
    logger.error('Error verifying Razorpay payment:', error);
    res.status(500).json({ error: 'Payment verification failed' });
  }
});

export default router;
