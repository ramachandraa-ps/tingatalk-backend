import { Router } from 'express';
import { getFirestore } from '../../config/firebase.js';
import { logger } from '../../utils/logger.js';
import {
  getUserStatus, setUserStatus, getConnectedUser, confirmBackgrounded
} from '../../socket/state/connectionManager.js';
import { StatsSyncUtil } from '../../utils/statsSyncUtil.js';

const router = Router();

/**
 * @openapi
 * /api/check_availability:
 *   post:
 *     tags:
 *       - Availability
 *     summary: Check if a recipient is available for a call
 *     description: Checks the real-time availability of a user by verifying their WebSocket connection and status. Returns availability state including busy/available/unavailable.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - recipient_id
 *             properties:
 *               recipient_id:
 *                 type: string
 *                 description: ID of the user to check availability for
 *     responses:
 *       200:
 *         description: Availability check result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 is_available:
 *                   type: boolean
 *                 user_status:
 *                   type: string
 *                   enum: [available, unavailable, busy, ringing]
 *                 current_call_id:
 *                   type: string
 *                   nullable: true
 *                 message:
 *                   type: string
 *       400:
 *         description: Missing recipient_id
 *       500:
 *         description: Server error
 */
router.post('/check_availability', async (req, res) => {
  try {
    const { recipient_id } = req.body;
    if (!recipient_id) return res.status(400).json({ error: 'Missing recipient_id' });

    const recipientStatus = getUserStatus(recipient_id);
    const recipientConnection = getConnectedUser(recipient_id);

    let actualStatus = 'unavailable';
    let currentCallId = null;
    let hasConnection = false;

    if (recipientConnection && recipientConnection.isOnline) {
      const io = req.app.get('io');
      const socket = io.sockets.sockets.get(recipientConnection.socketId);

      if (socket && socket.connected) {
        hasConnection = true;

        if (recipientStatus) {
          actualStatus = recipientStatus.status;
          currentCallId = recipientStatus.currentCallId;
        } else {
          try {
            const db = getFirestore();
            const userDoc = await db.collection('users').doc(recipient_id).get();
            if (userDoc.exists) {
              const savedPreference = userDoc.data().isAvailable !== false;
              actualStatus = savedPreference ? 'available' : 'unavailable';
              setUserStatus(recipient_id, {
                status: actualStatus, currentCallId: null,
                lastStatusChange: new Date(), userPreference: savedPreference
              });
            } else {
              actualStatus = 'available';
              setUserStatus(recipient_id, {
                status: 'available', currentCallId: null,
                lastStatusChange: new Date(), userPreference: true
              });
            }
          } catch (err) {
            actualStatus = 'available';
          }
        }
      }
    }

    // No socket connection = not available (no FCM fallback)
    const isAvailable = actualStatus === 'available';

    // Also return the user's toggle preference (survives force-close)
    let togglePreference = null;
    try {
      const db = getFirestore();
      if (db) {
        const userDoc = await db.collection('users').doc(recipient_id).get();
        if (userDoc.exists) {
          const data = userDoc.data();
          togglePreference = data.availabilityPreference !== undefined
            ? data.availabilityPreference
            : data.isAvailable;
        }
      }
    } catch (_) {}

    res.json({
      success: true,
      is_available: isAvailable,
      user_status: actualStatus,
      availability_preference: togglePreference,
      current_call_id: currentCallId,
      message: isAvailable ? 'User is available' : `User is currently ${actualStatus}`
    });
  } catch (error) {
    logger.error('Error in check_availability:', error);
    res.status(500).json({
      error: 'Failed to check availability',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

/**
 * @openapi
 * /api/update_availability:
 *   post:
 *     tags:
 *       - Availability
 *     summary: Update a user's availability status
 *     description: Sets a user's availability for receiving calls. Persists the preference to Firestore, notifies the user via WebSocket, and broadcasts changes for female users.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - user_id
 *               - is_available
 *             properties:
 *               user_id:
 *                 type: string
 *                 description: ID of the user to update
 *               is_available:
 *                 type: boolean
 *                 description: Whether the user should be available for calls
 *     responses:
 *       200:
 *         description: Availability updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 user_id:
 *                   type: string
 *                 is_available:
 *                   type: boolean
 *                 status:
 *                   type: string
 *                   enum: [available, unavailable]
 *                 message:
 *                   type: string
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *       400:
 *         description: Missing required fields or cannot set unavailable while busy
 *       500:
 *         description: Server error
 */
router.post('/update_availability', async (req, res) => {
  try {
    const { user_id, is_available } = req.body;

    if (!user_id || typeof is_available !== 'boolean') {
      return res.status(400).json({
        error: 'Missing required fields',
        required: { user_id: 'string', is_available: 'boolean' }
      });
    }

    const currentStatus = getUserStatus(user_id);

    if (currentStatus && currentStatus.status === 'busy' && !is_available) {
      return res.status(400).json({
        success: false,
        error: 'Cannot set unavailable while on a call',
        current_status: currentStatus.status
      });
    }

    const newStatus = is_available ? 'available' : 'unavailable';

    setUserStatus(user_id, {
      status: newStatus,
      currentCallId: currentStatus?.currentCallId || null,
      lastStatusChange: new Date(),
      userPreference: is_available
    });

    // Persist to Firestore — save both current state AND user preference
    try {
      const db = getFirestore();
      await db.collection('users').doc(user_id).set({
        isAvailable: is_available,
        availabilityPreference: is_available, // User's explicit toggle choice — never overwritten by system
        lastAvailabilityUpdate: new Date(),
        updatedAt: new Date()
      }, { merge: true });
    } catch (err) {
      logger.error(`Failed to save availability to Firestore: ${err.message}`);
    }

    // Notify user via WebSocket
    const io = req.app.get('io');
    const userConnection = getConnectedUser(user_id);
    if (userConnection && userConnection.isOnline) {
      const userSocket = io.sockets.sockets.get(userConnection.socketId);
      if (userSocket && userSocket.connected) {
        userSocket.emit('availability_updated', {
          is_available, status: newStatus, timestamp: new Date().toISOString()
        });
      }
    }

    // Broadcast for female users
    try {
      const db = getFirestore();
      const userDoc = await db.collection('users').doc(user_id).get();
      if (userDoc.exists && userDoc.data().gender === 'female') {
        io.to('room_male_browse').emit('availability_changed', {
          femaleUserId: user_id,
          isAvailable: is_available,
          status: newStatus,
          timestamp: new Date().toISOString()
        });
      }
    } catch (err) {
      logger.error(`Failed to broadcast availability: ${err.message}`);
    }

    res.json({
      success: true,
      user_id,
      is_available,
      status: newStatus,
      message: is_available ? 'You are now available for calls' : 'You are now unavailable for calls',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error in update_availability:', error);
    res.status(500).json({
      error: 'Failed to update availability',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

/**
 * @openapi
 * /api/get_available_females:
 *   get:
 *     tags:
 *       - Availability
 *     summary: List available female users
 *     description: Returns all verified female users who are online, have an active WebSocket connection, and are available for calls. Includes stats like rating, total calls, and total likes.
 *     responses:
 *       200:
 *         description: List of available female users
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 available_females:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       userId:
 *                         type: string
 *                       name:
 *                         type: string
 *                       age:
 *                         type: integer
 *                       photoUrl:
 *                         type: string
 *                       fullPhotoUrl:
 *                         type: string
 *                       isOnline:
 *                         type: boolean
 *                       isAvailable:
 *                         type: boolean
 *                       status:
 *                         type: string
 *                         enum: [available, busy]
 *                       currentCallId:
 *                         type: string
 *                         nullable: true
 *                       rating:
 *                         type: number
 *                       totalCalls:
 *                         type: integer
 *                       totalLikes:
 *                         type: integer
 *                       relationshipStatus:
 *                         type: string
 *                 count:
 *                   type: integer
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *       500:
 *         description: Server error
 */
router.get('/get_available_females', async (req, res) => {
  try {
    const db = getFirestore();
    const io = req.app.get('io');

    const femalesSnapshot = await db.collection('users')
      .where('gender', '==', 'female')
      .where('isVerified', '==', true)
      .where('isAvailable', '==', true)
      .get();

    if (femalesSnapshot.empty) {
      return res.json({
        success: true, available_females: [], count: 0,
        timestamp: new Date().toISOString()
      });
    }

    // Initialize stats sync
    let statsSync = null;
    try { statsSync = new StatsSyncUtil(db); } catch (e) { /* fallback */ }

    // Batch-fetch female_earnings docs for totalCalls (source of truth)
    const femaleEarningsMap = {};
    try {
      const earningsPromises = femalesSnapshot.docs.map(doc =>
        db.collection('female_earnings').doc(doc.id).get()
      );
      const earningsDocs = await Promise.all(earningsPromises);
      earningsDocs.forEach(edoc => {
        if (edoc.exists) {
          femaleEarningsMap[edoc.id] = edoc.data();
        }
      });
    } catch (e) {
      logger.warn('Failed to batch-fetch female_earnings:', e.message);
    }

    const availableFemales = [];

    for (const doc of femalesSnapshot.docs) {
      const userData = doc.data();
      const userId = doc.id;

      if (userData.isAvailable !== true) continue;

      // Check reachability: socket OR FCM token
      // Why: female may briefly drop socket (backgrounded app, transient network)
      // but stay reachable via FCM. Tier 1/1.5 system preserves isAvailable=true
      // during these gaps — the browse list must honor that to avoid stale UI.
      const userConnection = getConnectedUser(userId);
      const hasActiveConnection = userConnection && userConnection.isOnline;

      let isSocketConnected = false;
      if (hasActiveConnection) {
        const userSocket = io.sockets.sockets.get(userConnection.socketId);
        isSocketConnected = userSocket && userSocket.connected;
      }

      const hasFcmToken = !!(userData.fcmToken && typeof userData.fcmToken === 'string' && userData.fcmToken.length > 0);
      const isReachable = isSocketConnected || hasFcmToken;

      // Skip only if she's neither socket-connected nor FCM-reachable
      if (!isReachable) continue;

      // Determine status (available or busy)
      const userStatusData = getUserStatus(userId);
      const isBusy = userStatusData && userStatusData.status === 'busy';
      const status = isBusy ? 'busy' : 'available';
      const currentCallId = isBusy ? userStatusData.currentCallId : null;

      // Get stats
      let powerUpStats = { rating: 0, totalCalls: 0, totalLikes: 0 };
      try {
        if (statsSync) {
          const stats = await statsSync.getUserStatsWithFallback(userId);
          powerUpStats = { rating: stats.rating, totalCalls: stats.totalCalls, totalLikes: stats.totalLikes };
        } else {
          powerUpStats = {
            rating: userData.rating || 0,
            totalCalls: userData.totalCalls || 0,
            totalLikes: userData.totalLikes || 0
          };
        }
      } catch (e) {
        powerUpStats = {
          rating: userData.rating || 0,
          totalCalls: userData.totalCalls || 0,
          totalLikes: userData.totalLikes || 0
        };
      }

      // Override totalCalls from female_earnings (source of truth)
      const femaleEarnings = femaleEarningsMap[userId];
      if (femaleEarnings && typeof femaleEarnings.totalCalls === 'number') {
        powerUpStats.totalCalls = femaleEarnings.totalCalls;
      }

      availableFemales.push({
        userId,
        name: userData.displayName || userData.name || 'Unknown',
        age: userData.age || 0,
        photoUrl: userData.photoUrl || '',
        fullPhotoUrl: userData.fullPhotoUrl || userData.photoUrl || '',
        isOnline: isSocketConnected,
        isAvailable: true,
        connectionType: isSocketConnected ? 'socket' : 'fcm',
        reachability: isSocketConnected ? 'websocket' : 'fcm_only',
        status, // 'available' or 'busy'
        currentCallId,
        rating: powerUpStats.rating,
        totalCalls: powerUpStats.totalCalls,
        totalLikes: powerUpStats.totalLikes,
        relationshipStatus: userData.relationshipStatus || 'single'
      });
    }

    res.json({
      success: true,
      available_females: availableFemales,
      count: availableFemales.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error in get_available_females:', error.message);
    if (error.message && error.message.includes('index')) {
      logger.error('MISSING FIRESTORE INDEX: Deploy indexes with: firebase deploy --only firestore:indexes');
    }
    res.status(500).json({
      error: 'Failed to fetch available females',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

/**
 * @openapi
 * /api/availability_heartbeat:
 *   post:
 *     tags: [Availability]
 *     summary: Respond to availability ping (confirms app is backgrounded, not force-closed)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [user_id]
 *             properties:
 *               user_id:
 *                 type: string
 *     responses:
 *       200:
 *         description: Heartbeat acknowledged
 */
router.post('/availability_heartbeat', (req, res) => {
  const userId = req.body.user_id || req.body.userId;
  if (!userId) {
    return res.status(400).json({ error: 'user_id is required' });
  }

  confirmBackgrounded(userId);
  res.json({ success: true, message: 'Heartbeat acknowledged' });
});

export default router;
