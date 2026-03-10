import { Router } from 'express';
import { getFirestore } from '../../config/firebase.js';
import { logger } from '../../utils/logger.js';

const router = Router();

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
