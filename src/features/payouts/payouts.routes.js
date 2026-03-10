import { Router } from 'express';
import { razorpayApi } from '../../config/razorpay.js';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { getFirestore } from '../../config/firebase.js';

const router = Router();

/**
 * @openapi
 * /api/contact-sync:
 *   post:
 *     tags:
 *       - Payouts
 *     summary: Sync payout contact and fund account with Razorpay
 *     description: Creates or reuses a Razorpay Contact and Fund Account for a user. Supports both bank account and UPI payment methods. Persists the Razorpay IDs to the user's Firestore document for future reuse.
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - userId
 *               - accountHolderName
 *             properties:
 *               userId:
 *                 type: string
 *               userName:
 *                 type: string
 *               phoneNumber:
 *                 type: string
 *               accountHolderName:
 *                 type: string
 *               accountNumber:
 *                 type: string
 *                 description: Required if upiId is not provided
 *               ifsc:
 *                 type: string
 *               bankName:
 *                 type: string
 *               upiId:
 *                 type: string
 *                 description: Required if accountNumber is not provided
 *               accountType:
 *                 type: string
 *                 default: savings
 *               existingContactId:
 *                 type: string
 *               existingFundAccountId:
 *                 type: string
 *     responses:
 *       200:
 *         description: Contact and fund account synced
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 contactId:
 *                   type: string
 *                 fundAccountId:
 *                   type: string
 *                 status:
 *                   type: string
 *                   example: verified
 *       400:
 *         description: Missing required payout fields
 *       500:
 *         description: Server error
 */
router.post('/contact-sync', async (req, res) => {
  try {
    const {
      userId, userName, phoneNumber, accountHolderName,
      accountNumber, ifsc, bankName, upiId,
      accountType = 'savings', existingContactId, existingFundAccountId
    } = req.body;

    if (!userId || !accountHolderName || (!accountNumber && !upiId)) {
      return res.status(400).json({ error: 'Missing required payout fields' });
    }

    let contactId = existingContactId;
    if (!contactId) {
      const contact = await razorpayApi.post('/contacts', {
        name: userName || accountHolderName,
        contact: phoneNumber,
        type: 'employee',
        reference_id: userId
      });
      contactId = contact.data.id;
    }

    let fundAccountId = existingFundAccountId;
    if (!fundAccountId) {
      const payload = upiId
        ? { contact_id: contactId, account_type: 'vpa', vpa: { address: upiId } }
        : {
            contact_id: contactId, account_type: 'bank_account',
            bank_account: { name: accountHolderName, account_number: accountNumber, ifsc, account_type: accountType }
          };

      const fundAccount = await razorpayApi.post('/fund_accounts', payload);
      fundAccountId = fundAccount.data.id;
    }

    // Persist IDs to user document for reuse
    try {
      const db = getFirestore();
      if (db && userId) {
        await db.collection('users').doc(userId).set({
          razorpayContactId: contactId,
          razorpayFundAccountId: fundAccountId,
          payoutDetailsUpdatedAt: new Date()
        }, { merge: true });
      }
    } catch (persistErr) {
      logger.warn(`Failed to persist Razorpay IDs: ${persistErr.message}`);
    }

    res.json({ contactId, fundAccountId, status: 'verified' });
  } catch (error) {
    logger.error('Error syncing Razorpay contact:', error.response?.data || error);
    res.status(500).json({
      error: 'Failed to sync payout details',
      details: error.response?.data || error.message
    });
  }
});

/**
 * @openapi
 * /api/payouts:
 *   post:
 *     tags:
 *       - Payouts
 *     summary: Trigger a payout to a female user
 *     description: Creates a Razorpay payout to the specified fund account. Uses IMPS transfer mode and queues if balance is low.
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - fundAccountId
 *               - amount
 *             properties:
 *               fundAccountId:
 *                 type: string
 *               amount:
 *                 type: number
 *                 description: Amount in INR (will be converted to paise)
 *               currency:
 *                 type: string
 *                 default: INR
 *               userId:
 *                 type: string
 *               userName:
 *                 type: string
 *               purpose:
 *                 type: string
 *                 default: payout
 *     responses:
 *       200:
 *         description: Payout triggered
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 payoutId:
 *                   type: string
 *                 status:
 *                   type: string
 *                 referenceId:
 *                   type: string
 *       400:
 *         description: Missing required fields
 *       500:
 *         description: Server error
 */
router.post('/payouts', async (req, res) => {
  try {
    const { fundAccountId, amount, currency = 'INR', userId, userName, purpose = 'payout' } = req.body;
    if (!fundAccountId || !amount) {
      return res.status(400).json({ error: 'fundAccountId and amount are required' });
    }

    const payout = await razorpayApi.post('/payouts', {
      account_number: config.razorpay.accountNumber,
      fund_account_id: fundAccountId,
      amount: Math.round(Number(amount) * 100),
      currency, mode: 'IMPS', purpose,
      queue_if_low_balance: true,
      narration: `TingaTalk payout ${userId || ''}`.trim()
    });

    res.json({
      payoutId: payout.data.id,
      status: payout.data.status,
      referenceId: payout.data.reference_id || ''
    });
  } catch (error) {
    logger.error('Error creating Razorpay payout:', error.response?.data || error);
    res.status(500).json({
      error: 'Failed to trigger payout',
      details: error.response?.data || error.message
    });
  }
});

export default router;
