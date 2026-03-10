import { Router } from 'express';
import { getFirestore } from '../../config/firebase.js';
import { logger } from '../../utils/logger.js';
import {
  getUserStatus, setUserStatus, getConnectedUser
} from '../../socket/state/connectionManager.js';
import { StatsSyncUtil } from '../../utils/statsSyncUtil.js';

const router = Router();

// POST /api/check_availability
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

    if (!hasConnection) actualStatus = 'unavailable';

    const isAvailable = actualStatus === 'available';

    res.json({
      success: true,
      is_available: isAvailable,
      user_status: actualStatus,
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

// POST /api/update_availability
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

    // Persist to Firestore
    try {
      const db = getFirestore();
      await db.collection('users').doc(user_id).set({
        isAvailable: is_available,
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
        io.sockets.emit('availability_changed', {
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

// GET /api/get_available_females
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

    const availableFemales = [];

    for (const doc of femalesSnapshot.docs) {
      const userData = doc.data();
      const userId = doc.id;

      // Check WebSocket connection - REQUIRED for browse
      const userConnection = getConnectedUser(userId);
      const hasActiveConnection = userConnection && userConnection.isOnline;

      if (!hasActiveConnection) continue; // Skip offline females entirely

      let isSocketConnected = false;
      if (hasActiveConnection) {
        const userSocket = io.sockets.sockets.get(userConnection.socketId);
        isSocketConnected = userSocket && userSocket.connected;
      }

      if (!isSocketConnected) continue; // Skip if socket not actually connected

      if (userData.isAvailable !== true) continue;

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
            totalCalls: userData.totalCallsReceived || 0,
            totalLikes: userData.totalLikes || 0
          };
        }
      } catch (e) {
        powerUpStats = {
          rating: userData.rating || 0,
          totalCalls: userData.totalCallsReceived || 0,
          totalLikes: userData.totalLikes || 0
        };
      }

      availableFemales.push({
        userId,
        name: userData.name || 'Unknown',
        age: userData.age || 0,
        photoUrl: userData.photoUrl || '',
        fullPhotoUrl: userData.fullPhotoUrl || userData.photoUrl || '',
        isOnline: true, // Always true since we filtered above
        isAvailable: true,
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

export default router;
