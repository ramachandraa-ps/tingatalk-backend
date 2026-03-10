import { Router } from 'express';
import { getFirestore } from '../../config/firebase.js';
import { logger } from '../../utils/logger.js';

const router = Router();

/**
 * @openapi
 * /api/user/{userId}/balance:
 *   get:
 *     tags:
 *       - Users
 *     summary: Get user coin balance
 *     description: Returns the current coin balance for the specified user.
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *         description: The user ID
 *     responses:
 *       200:
 *         description: User balance retrieved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 userId:
 *                   type: string
 *                 balance:
 *                   type: number
 *                 currency:
 *                   type: string
 *                   example: coins
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *       400:
 *         description: Missing userId
 *       404:
 *         description: User not found
 *       500:
 *         description: Server error
 */
router.get('/:userId/balance', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    logger.info(`Getting balance for user: ${userId}`);

    const db = getFirestore();
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'User not found' });

    const data = userDoc.data();
    const balance = data.coins ?? data.coinBalance ?? 0;

    res.json({
      success: true,
      userId,
      balance,
      currency: 'coins',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error getting user balance:', error);
    res.status(500).json({
      error: 'Failed to get user balance',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

export default router;
