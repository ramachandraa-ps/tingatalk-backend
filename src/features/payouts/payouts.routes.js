import { Router } from 'express';
import { logger } from '../../utils/logger.js';
import { getFirestore, admin } from '../../config/firebase.js';

const router = Router();

/**
 * @openapi
 * /api/payouts:
 *   post:
 *     tags:
 *       - Payouts
 *     summary: Submit a payout request for admin review
 *     description: Creates a payout request in Firestore and decrements the user's available balance. The admin will process the payout manually via the Razorpay dashboard.
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
 *               - amount
 *             properties:
 *               userId:
 *                 type: string
 *               userName:
 *                 type: string
 *               amount:
 *                 type: number
 *                 description: Amount in INR
 *               currency:
 *                 type: string
 *                 default: INR
 *               bankDetails:
 *                 type: object
 *                 properties:
 *                   accountHolderName:
 *                     type: string
 *                   accountNumber:
 *                     type: string
 *                   ifsc:
 *                     type: string
 *                   bankName:
 *                     type: string
 *                   upiId:
 *                     type: string
 *                   accountType:
 *                     type: string
 *                     default: savings
 *     responses:
 *       200:
 *         description: Payout request submitted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 requestId:
 *                   type: string
 *                 status:
 *                   type: string
 *                   example: pending
 *                 message:
 *                   type: string
 *       400:
 *         description: Missing required fields or invalid amount
 *       500:
 *         description: Server error
 */
router.post('/payouts', async (req, res) => {
  try {
    const { userId, userName, amount, currency = 'INR', bankDetails } = req.body;

    if (!userId || !amount) {
      return res.status(400).json({ error: 'userId and amount are required' });
    }

    if (typeof amount !== 'number' || amount <= 0) {
      return res.status(400).json({ error: 'amount must be a positive number' });
    }

    const db = getFirestore();

    // Create payout request document
    const payoutRequest = {
      userId,
      userName: userName || null,
      amount,
      currency,
      bankDetails: bankDetails || null,
      status: 'pending',
      requestedAt: new Date(),
      processedAt: null,
      adminNotes: null
    };

    const docRef = await db.collection('payout_requests').add(payoutRequest);

    // Update female_earnings: decrement availableBalance, increment claimedAmount
    const earningsRef = db.collection('female_earnings').doc(userId);
    await earningsRef.set({
      availableBalance: admin.firestore.FieldValue.increment(-amount),
      claimedAmount: admin.firestore.FieldValue.increment(amount)
    }, { merge: true });

    logger.info(`Payout request ${docRef.id} created for user ${userId}, amount: ${amount} ${currency}`);

    res.json({
      requestId: docRef.id,
      status: 'pending',
      message: 'Payout request submitted for admin review'
    });
  } catch (error) {
    logger.error('Error creating payout request:', error);
    res.status(500).json({
      error: 'Failed to submit payout request',
      details: error.message
    });
  }
});

/**
 * @openapi
 * /api/payouts:
 *   get:
 *     tags:
 *       - Payouts
 *     summary: List payout requests
 *     description: Returns all payout requests, optionally filtered by status. Intended for admin use.
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [pending, processing, completed, rejected]
 *         description: Filter by payout request status
 *     responses:
 *       200:
 *         description: List of payout requests
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 requests:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       userId:
 *                         type: string
 *                       userName:
 *                         type: string
 *                       amount:
 *                         type: number
 *                       currency:
 *                         type: string
 *                       bankDetails:
 *                         type: object
 *                       status:
 *                         type: string
 *                       requestedAt:
 *                         type: string
 *                         format: date-time
 *                       processedAt:
 *                         type: string
 *                         format: date-time
 *                       adminNotes:
 *                         type: string
 *       500:
 *         description: Server error
 */
router.get('/payouts', async (req, res) => {
  try {
    const db = getFirestore();
    const { status } = req.query;

    let query = db.collection('payout_requests').orderBy('requestedAt', 'desc');

    if (status) {
      query = query.where('status', '==', status);
    }

    const snapshot = await query.get();

    const requests = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      requests.push({
        id: doc.id,
        ...data,
        requestedAt: data.requestedAt?.toDate?.() || data.requestedAt,
        processedAt: data.processedAt?.toDate?.() || data.processedAt
      });
    });

    res.json({ requests });
  } catch (error) {
    logger.error('Error listing payout requests:', error);
    res.status(500).json({
      error: 'Failed to list payout requests',
      details: error.message
    });
  }
});

/**
 * @openapi
 * /api/payouts/{requestId}:
 *   put:
 *     tags:
 *       - Payouts
 *     summary: Update a payout request status
 *     description: Allows admin to update payout request status. If rejected, the balance is restored to the user's female_earnings.
 *     parameters:
 *       - in: path
 *         name: requestId
 *         required: true
 *         schema:
 *           type: string
 *         description: The payout request document ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - status
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [processing, completed, rejected]
 *               adminNotes:
 *                 type: string
 *               transactionId:
 *                 type: string
 *                 description: External transaction reference (e.g. Razorpay payout ID)
 *     responses:
 *       200:
 *         description: Payout request updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id:
 *                   type: string
 *                 status:
 *                   type: string
 *                 message:
 *                   type: string
 *       400:
 *         description: Missing or invalid status
 *       404:
 *         description: Payout request not found
 *       500:
 *         description: Server error
 */
router.put('/payouts/:requestId', async (req, res) => {
  try {
    const { requestId } = req.params;
    const { status, adminNotes, transactionId } = req.body;

    const validStatuses = ['processing', 'completed', 'rejected'];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({
        error: `status is required and must be one of: ${validStatuses.join(', ')}`
      });
    }

    const db = getFirestore();
    const docRef = db.collection('payout_requests').doc(requestId);
    const docSnap = await docRef.get();

    if (!docSnap.exists) {
      return res.status(404).json({ error: 'Payout request not found' });
    }

    const existingData = docSnap.data();

    // Build update payload
    const updateData = {
      status,
      processedAt: new Date()
    };

    if (adminNotes !== undefined) {
      updateData.adminNotes = adminNotes;
    }

    if (transactionId !== undefined) {
      updateData.transactionId = transactionId;
    }

    await docRef.update(updateData);

    // If rejected, restore the balance back to female_earnings
    if (status === 'rejected') {
      const earningsRef = db.collection('female_earnings').doc(existingData.userId);
      await earningsRef.set({
        availableBalance: admin.firestore.FieldValue.increment(existingData.amount),
        claimedAmount: admin.firestore.FieldValue.increment(-existingData.amount)
      }, { merge: true });

      logger.info(`Payout request ${requestId} rejected — restored ${existingData.amount} ${existingData.currency} to user ${existingData.userId}`);
    } else {
      logger.info(`Payout request ${requestId} updated to status: ${status}`);
    }

    res.json({
      id: requestId,
      status,
      message: `Payout request ${status === 'rejected' ? 'rejected and balance restored' : 'updated to ' + status}`
    });
  } catch (error) {
    logger.error('Error updating payout request:', error);
    res.status(500).json({
      error: 'Failed to update payout request',
      details: error.message
    });
  }
});

export default router;
