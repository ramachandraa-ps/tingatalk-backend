// ============================================================================
// Shared payment-crediting routine
// ----------------------------------------------------------------------------
// Used by:
//   - POST /api/payments/verify  (client-driven, signature-verified)
//   - POST /api/payments/webhook (Razorpay server-to-server safety net)
//
// Idempotency: payment_verifications/{orderId} acts as the dedupe key.
//   Outer check → fast exit if already credited.
//   Inner re-check inside the transaction → race-free guarantee even if two
//   callers (client + webhook) hit the endpoint at the same millisecond.
// ============================================================================

import { getFirestore, admin } from '../../config/firebase.js';
import { COIN_PACKAGES } from '../../shared/constants.js';

export async function creditPaymentToUser({ orderId, paymentId, userId, packageId, source, signature = null }) {
  const db = getFirestore();

  const existing = await db.collection('payment_verifications').doc(orderId).get();
  if (existing.exists) {
    const e = existing.data();
    return {
      duplicate: true,
      verificationId: e.verificationId,
      transactionId: e.transactionId || null,
      coinsCredited: e.coinsCredited,
      newBalance: e.newBalance,
      verifiedAt: e.verifiedAt,
    };
  }

  const coinPackage = COIN_PACKAGES[packageId];
  if (!coinPackage) throw new Error(`Unknown packageId: ${packageId}`);

  const verificationId = `ver_${Date.now()}`;
  const verifiedAt = new Date().toISOString();
  const transactionId = `txn_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;
  const userRef = db.collection('users').doc(userId);

  const transactionData = {
    id: transactionId, userId, type: 'purchase', status: 'success',
    coinAmount: coinPackage.coinAmount, priceInRupees: coinPackage.priceInRupees,
    packageId: coinPackage.id, paymentGatewayId: paymentId, paymentMethod: 'razorpay',
    description: `Purchased ${coinPackage.name} - ${coinPackage.coinAmount} coins`,
    createdAt: verifiedAt, updatedAt: verifiedAt,
    metadata: { verificationId, orderId, paymentSignature: signature, purchaseSource: source, verifiedAt }
  };

  let newBalance = 0;
  let isDuplicate = false;

  try {
    await db.runTransaction(async (t) => {
      const innerExisting = await t.get(db.collection('payment_verifications').doc(orderId));
      if (innerExisting.exists) {
        isDuplicate = true;
        newBalance = innerExisting.data().newBalance;
        return;
      }
      const userDoc = await t.get(userRef);
      const currentBalance = userDoc.exists ? (userDoc.data().coins ?? 0) : 0;
      newBalance = currentBalance + coinPackage.coinAmount;

      t.update(userRef, {
        coins: admin.firestore.FieldValue.increment(coinPackage.coinAmount),
        totalCoinsPurchased: admin.firestore.FieldValue.increment(coinPackage.coinAmount),
        totalPurchaseCount: admin.firestore.FieldValue.increment(1),
        lastActiveAt: admin.firestore.FieldValue.serverTimestamp()
      });

      t.set(userRef.collection('transactions').doc(transactionId), transactionData);

      t.set(db.collection('payment_verifications').doc(orderId), {
        orderId, paymentId, userId, verificationId, transactionId,
        packageId: coinPackage.id, coinsCredited: coinPackage.coinAmount,
        priceInRupees: coinPackage.priceInRupees, newBalance, verifiedAt,
        source, createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });
  } catch (err) {
    throw err;
  }

  return {
    duplicate: isDuplicate,
    verificationId, transactionId,
    coinsCredited: coinPackage.coinAmount,
    newBalance, verifiedAt,
  };
}
