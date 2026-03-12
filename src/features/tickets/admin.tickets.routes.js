import { Router } from 'express';
import { getFirestore, admin } from '../../config/firebase.js';
import { logger } from '../../utils/logger.js';

const router = Router();

/**
 * @openapi
 * /api/admin/tickets:
 *   get:
 *     tags:
 *       - Admin Support Tickets
 *     summary: List all tickets (admin only)
 *     description: Returns all support tickets, optionally filtered by status. Requires admin API key.
 *     security:
 *       - AdminApiKey: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [open, in_progress, resolved, closed]
 *         description: Optional status filter
 *     responses:
 *       200:
 *         description: List of all tickets
 *       403:
 *         description: Invalid admin API key
 *       500:
 *         description: Server error
 */
router.get('/', async (req, res) => {
  try {
    const db = getFirestore();

    const status = req.query.status; // optional filter
    let query = db.collection('support_tickets').orderBy('createdAt', 'desc').limit(100);

    if (status) {
      query = db.collection('support_tickets')
        .where('status', '==', status)
        .orderBy('createdAt', 'desc')
        .limit(100);
    }

    const snapshot = await query.get();
    const tickets = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      createdAt: doc.data().createdAt?.toDate?.()?.toISOString() || null,
      updatedAt: doc.data().updatedAt?.toDate?.()?.toISOString() || null,
    }));

    res.json({ success: true, tickets, count: tickets.length });
  } catch (error) {
    logger.error('Error listing all tickets:', error);
    res.status(500).json({ error: 'Failed to list tickets' });
  }
});

/**
 * @openapi
 * /api/admin/tickets/{ticketId}:
 *   put:
 *     tags:
 *       - Admin Support Tickets
 *     summary: Update ticket status (admin only)
 *     description: Updates a ticket's status and/or priority. Requires admin API key.
 *     security:
 *       - AdminApiKey: []
 *     parameters:
 *       - in: path
 *         name: ticketId
 *         required: true
 *         schema:
 *           type: string
 *         description: The ticket ID
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [open, in_progress, resolved, closed]
 *               priority:
 *                 type: string
 *                 enum: [low, normal, high, urgent]
 *     responses:
 *       200:
 *         description: Ticket updated
 *       403:
 *         description: Invalid admin API key
 *       500:
 *         description: Server error
 */
router.put('/:ticketId', async (req, res) => {
  try {
    const { status, priority } = req.body;
    const db = getFirestore();

    const updateData = {
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (status) updateData.status = status;
    if (priority) updateData.priority = priority;

    await db.collection('support_tickets').doc(req.params.ticketId).update(updateData);

    res.json({ success: true, message: 'Ticket updated' });
  } catch (error) {
    logger.error('Error updating ticket:', error);
    res.status(500).json({ error: 'Failed to update ticket' });
  }
});

/**
 * @openapi
 * /api/admin/tickets/{ticketId}/respond:
 *   post:
 *     tags:
 *       - Admin Support Tickets
 *     summary: Add admin response to ticket
 *     description: Adds an admin response to a support ticket and sets status to in_progress. Requires admin API key.
 *     security:
 *       - AdminApiKey: []
 *     parameters:
 *       - in: path
 *         name: ticketId
 *         required: true
 *         schema:
 *           type: string
 *         description: The ticket ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - message
 *             properties:
 *               message:
 *                 type: string
 *     responses:
 *       200:
 *         description: Response added
 *       400:
 *         description: Missing message
 *       403:
 *         description: Invalid admin API key
 *       500:
 *         description: Server error
 */
router.post('/:ticketId/respond', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'message is required' });
    }

    const db = getFirestore();

    await db.collection('support_tickets').doc(req.params.ticketId).update({
      responses: admin.firestore.FieldValue.arrayUnion({
        message,
        from: 'admin',
        timestamp: new Date().toISOString(),
      }),
      status: 'in_progress',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ success: true, message: 'Response added' });
  } catch (error) {
    logger.error('Error responding to ticket:', error);
    res.status(500).json({ error: 'Failed to respond to ticket' });
  }
});

export default router;
