import { Router } from 'express';
import { getFirestore, admin } from '../../config/firebase.js';
import { logger } from '../../utils/logger.js';

const router = Router();

/**
 * @openapi
 * /api/tickets:
 *   post:
 *     tags:
 *       - Support Tickets
 *     summary: Create a support ticket
 *     description: Creates a new support ticket for the authenticated user.
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
 *               - subject
 *               - description
 *             properties:
 *               userId:
 *                 type: string
 *               subject:
 *                 type: string
 *               description:
 *                 type: string
 *               category:
 *                 type: string
 *                 default: general
 *               userType:
 *                 type: string
 *                 default: unknown
 *               userName:
 *                 type: string
 *                 default: Unknown
 *               phoneNumber:
 *                 type: string
 *     responses:
 *       201:
 *         description: Ticket created successfully
 *       400:
 *         description: Missing required fields
 *       500:
 *         description: Server error
 */
router.post('/', async (req, res) => {
  try {
    const { userId, subject, description, category, userType, userName, phoneNumber } = req.body;

    if (!userId || !subject || !description) {
      return res.status(400).json({ error: 'userId, subject, and description are required' });
    }

    const db = getFirestore();

    const ticketData = {
      userId,
      subject,
      description,
      category: category || 'general',
      userType: userType || 'unknown',
      userName: userName || 'Unknown',
      phoneNumber: phoneNumber || '',
      status: 'open', // open, in_progress, resolved, closed
      priority: 'normal', // low, normal, high, urgent
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      responses: [],
    };

    const docRef = await db.collection('support_tickets').add(ticketData);

    res.status(201).json({
      success: true,
      ticketId: docRef.id,
      message: 'Support ticket created successfully',
    });
  } catch (error) {
    logger.error('Error creating ticket:', error);
    res.status(500).json({ error: 'Failed to create support ticket' });
  }
});

/**
 * @openapi
 * /api/tickets:
 *   get:
 *     tags:
 *       - Support Tickets
 *     summary: List user's tickets
 *     description: Returns all support tickets for the specified user, ordered by creation date descending.
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *         description: The user ID to list tickets for
 *     responses:
 *       200:
 *         description: List of tickets
 *       400:
 *         description: Missing userId parameter
 *       500:
 *         description: Server error
 */
router.get('/', async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) {
      return res.status(400).json({ error: 'userId query parameter is required' });
    }

    const db = getFirestore();

    const snapshot = await db.collection('support_tickets')
      .where('userId', '==', userId)
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get();

    const tickets = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      createdAt: doc.data().createdAt?.toDate?.()?.toISOString() || null,
      updatedAt: doc.data().updatedAt?.toDate?.()?.toISOString() || null,
    }));

    res.json({ success: true, tickets });
  } catch (error) {
    logger.error('Error listing tickets:', error);
    res.status(500).json({ error: 'Failed to list tickets' });
  }
});

/**
 * @openapi
 * /api/tickets/{ticketId}:
 *   get:
 *     tags:
 *       - Support Tickets
 *     summary: Get ticket details
 *     description: Returns the full details of a specific support ticket.
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: ticketId
 *         required: true
 *         schema:
 *           type: string
 *         description: The ticket ID
 *     responses:
 *       200:
 *         description: Ticket details
 *       404:
 *         description: Ticket not found
 *       500:
 *         description: Server error
 */
router.get('/:ticketId', async (req, res) => {
  try {
    const db = getFirestore();

    const doc = await db.collection('support_tickets').doc(req.params.ticketId).get();
    if (!doc.exists) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    const data = doc.data();
    res.json({
      success: true,
      ticket: {
        id: doc.id,
        ...data,
        createdAt: data.createdAt?.toDate?.()?.toISOString() || null,
        updatedAt: data.updatedAt?.toDate?.()?.toISOString() || null,
      },
    });
  } catch (error) {
    logger.error('Error getting ticket:', error);
    res.status(500).json({ error: 'Failed to get ticket' });
  }
});

export default router;
