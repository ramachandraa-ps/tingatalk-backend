import { Router } from 'express';
import { getFirestore } from '../../config/firebase.js';
import { logger } from '../../utils/logger.js';

const router = Router();

/**
 * @openapi
 * /api/auth/check-user:
 *   post:
 *     tags:
 *       - Auth
 *     summary: Check if a user exists by phone number
 *     description: Looks up a user in Firestore by phone number and returns basic profile info if found.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - phoneNumber
 *             properties:
 *               phoneNumber:
 *                 type: string
 *                 description: Phone number to look up (digits only, min 10)
 *                 example: "9876543210"
 *     responses:
 *       200:
 *         description: User existence check result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 exists:
 *                   type: boolean
 *                 user:
 *                   type: object
 *                   nullable: true
 *                   properties:
 *                     userId:
 *                       type: string
 *                     name:
 *                       type: string
 *                       nullable: true
 *                     gender:
 *                       type: string
 *                       nullable: true
 *                     isVerified:
 *                       type: boolean
 *                     profileImageUrl:
 *                       type: string
 *                       nullable: true
 *       400:
 *         description: Invalid or missing phone number
 *       500:
 *         description: Server error
 */
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
        profileImageUrl: data.profileImageUrl || null,
        verificationPhoto: data.verificationPhoto || null,
        verificationStatus: data.verificationStatus || null,
        onboardingCompleted: data.onboardingCompleted || false
      };
    })() : null;

    res.json({ exists, user: userData });
  } catch (error) {
    logger.error('Check user error:', error);
    res.status(500).json({ error: 'Failed to check user' });
  }
});

export default router;
