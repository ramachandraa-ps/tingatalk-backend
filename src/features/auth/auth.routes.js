import { Router } from 'express';
import { getFirestore } from '../../config/firebase.js';
import { logger } from '../../utils/logger.js';

const router = Router();

router.post('/check-user', async (req, res) => {
  try {
    const { phoneNumber } = req.body;
    if (!phoneNumber || typeof phoneNumber !== 'string') {
      return res.status(400).json({ error: 'phoneNumber is required' });
    }

    const cleaned = phoneNumber.replace(/\D/g, '');
    if (cleaned.length < 10) {
      return res.status(400).json({ error: 'Invalid phone number' });
    }

    const db = getFirestore();
    const userQuery = await db.collection('users')
      .where('phoneNumber', '==', cleaned)
      .limit(1)
      .get();

    const exists = !userQuery.empty;
    const userData = exists ? (() => {
      const doc = userQuery.docs[0];
      const data = doc.data();
      return {
        userId: doc.id,
        name: data.name || data.displayName || null,
        gender: data.gender || null,
        isVerified: data.isVerified || false,
        profileImageUrl: data.profileImageUrl || null
      };
    })() : null;

    res.json({ exists, user: userData });
  } catch (error) {
    logger.error('Check user error:', error);
    res.status(500).json({ error: 'Failed to check user' });
  }
});

export default router;
