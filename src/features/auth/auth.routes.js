import { Router } from 'express';
import admin from 'firebase-admin';
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

/**
 * @openapi
 * /api/auth/reserve-user:
 *   post:
 *     tags:
 *       - Auth
 *     summary: Atomically reserve a userId for a phone number (prevents duplicate accounts)
 *     description: |
 *       Called by client AFTER OTP verification but BEFORE writing the user document.
 *       Uses a Firestore transaction to guarantee phone-number uniqueness:
 *       - If a user with this phone already exists, returns the existing userId (isExisting=true).
 *         The client should treat this as a login (NOT create a new user document).
 *       - If not, mints a userId server-side, writes a phone-index reservation, and returns
 *         the new userId (isExisting=false). The client then proceeds to write the user
 *         document at users/{userId}.
 *
 *       This endpoint is idempotent — calling it N times with the same phone always returns
 *       the same userId. Solves the TOCTOU race in the legacy client-mints-userId flow.
 */
router.post('/reserve-user', async (req, res) => {
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
    const phoneIndexRef = db.collection('phone_index').doc(cleaned);

    const result = await db.runTransaction(async (tx) => {
      // Step 1: check phone_index (fast path for already-reserved phones).
      // The reservation is authoritative — if phone_index exists, return that
      // userId whether or not the users/{userId} doc has been created yet.
      // (Client may have crashed between reserve and createUserDocument; on
      // retry we must return the SAME userId.)
      const indexDoc = await tx.get(phoneIndexRef);
      if (indexDoc.exists) {
        const existingUserId = indexDoc.data().userId;
        const existingUserSnap = await tx.get(db.collection('users').doc(existingUserId));
        const userDocExists = existingUserSnap.exists;
        const u = userDocExists ? existingUserSnap.data() : null;
        return {
          userId: existingUserId,
          // isExisting=true ONLY if the user doc was already created — so client
          // knows whether to skip createUserDocument or proceed with it.
          isExisting: userDocExists,
          source: userDocExists ? 'phone_index' : 'phone_index_pending_doc',
          user: u ? {
            userId: existingUserId,
            name: u.name || u.displayName || null,
            gender: u.gender || null,
            isVerified: u.isVerified || false,
            onboardingCompleted: u.onboardingCompleted || false,
            profileImageUrl: u.profileImageUrl || u.profilePhotoUrl || null,
          } : null,
        };
      }

      // Step 2: fallback scan of users collection (for legacy users without phone_index entry)
      const legacyQuery = await tx.get(
        db.collection('users').where('phoneNumber', '==', cleaned).limit(1)
      );
      if (!legacyQuery.empty) {
        const legacyDoc = legacyQuery.docs[0];
        const u = legacyDoc.data();
        // Backfill phone_index for this legacy user so future lookups are O(1).
        tx.set(phoneIndexRef, {
          userId: legacyDoc.id,
          phoneNumber: cleaned,
          reservedAt: admin.firestore.FieldValue.serverTimestamp(),
          source: 'legacy_backfill',
        });
        return {
          userId: legacyDoc.id,
          isExisting: true,
          source: 'legacy_user_scan',
          user: {
            userId: legacyDoc.id,
            name: u.name || u.displayName || null,
            gender: u.gender || null,
            isVerified: u.isVerified || false,
            onboardingCompleted: u.onboardingCompleted || false,
            profileImageUrl: u.profileImageUrl || u.profilePhotoUrl || null,
          },
        };
      }

      // Step 3: brand-new phone — mint a userId and reserve it
      const newUserId = `user_${Date.now()}_${cleaned}`;
      tx.set(phoneIndexRef, {
        userId: newUserId,
        phoneNumber: cleaned,
        reservedAt: admin.firestore.FieldValue.serverTimestamp(),
        source: 'new_signup',
      });
      return {
        userId: newUserId,
        isExisting: false,
        source: 'new_reservation',
        user: null,
      };
    });

    logger.info(`RESERVE_USER: phone=${cleaned} userId=${result.userId} isExisting=${result.isExisting} source=${result.source}`);
    res.json(result);
  } catch (error) {
    logger.error('Reserve user error:', error);
    res.status(500).json({ error: 'Failed to reserve user' });
  }
});

export default router;
