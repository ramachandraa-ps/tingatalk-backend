import { Router } from 'express';
import { razorpayApi } from '../../config/razorpay.js';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { getFirestore } from '../../config/firebase.js';

const router = Router();

// POST /api/razorpay/contact-sync
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

// POST /api/female/payouts
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
