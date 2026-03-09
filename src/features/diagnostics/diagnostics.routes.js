import { Router } from 'express';
import { adminAuth } from '../../middleware/adminAuth.js';
import { logger } from '../../utils/logger.js';
import {
  getAllConnectedUsers, getAllUserStatuses, getAllActiveCalls, getConnectedUser, getUserStatus
} from '../../socket/state/connectionManager.js';

const router = Router();

router.get('/connections', adminAuth, (req, res) => {
  try {
    const io = req.app.get('io');
    const diagnostics = {
      timestamp: new Date().toISOString(),
      totalSocketsConnected: io.sockets.sockets.size,
      connectedUsers: [],
      userStatus: [],
      activeCalls: [],
      socketRooms: []
    };

    for (const [userId, userData] of getAllConnectedUsers().entries()) {
      const socket = io.sockets.sockets.get(userData.socketId);
      diagnostics.connectedUsers.push({
        userId, socketId: userData.socketId, userType: userData.userType,
        isOnline: userData.isOnline, socketExists: !!socket,
        rooms: socket ? Array.from(socket.rooms) : [],
        connectedAt: userData.connectedAt
      });
    }

    for (const [userId, status] of getAllUserStatuses().entries()) {
      diagnostics.userStatus.push({
        userId, status: status.status,
        currentCallId: status.currentCallId,
        lastStatusChange: status.lastStatusChange
      });
    }

    for (const [callId, call] of getAllActiveCalls().entries()) {
      diagnostics.activeCalls.push({
        callId: call.callId, callerId: call.callerId,
        recipientId: call.recipientId, status: call.status,
        callType: call.callType, createdAt: call.createdAt
      });
    }

    for (const [socketId, socket] of io.sockets.sockets.entries()) {
      diagnostics.socketRooms.push({
        socketId, rooms: Array.from(socket.rooms)
      });
    }

    res.json(diagnostics);
  } catch (error) {
    logger.error('Error in diagnostic endpoint:', error);
    res.status(500).json({
      error: 'Failed to get diagnostics',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

router.get('/user/:userId', adminAuth, (req, res) => {
  try {
    const { userId } = req.params;
    const io = req.app.get('io');
    const userData = getConnectedUser(userId);
    const userStatusData = getUserStatus(userId);

    if (!userData) {
      return res.status(404).json({ error: 'User not found', userId, isConnected: false });
    }

    const socket = io.sockets.sockets.get(userData.socketId);
    const rooms = socket ? Array.from(socket.rooms) : [];

    res.json({
      userId, isConnected: true, socketId: userData.socketId,
      userType: userData.userType, socketExists: !!socket, rooms,
      expectedRoom: `user_${userId}`,
      isInExpectedRoom: rooms.includes(`user_${userId}`),
      status: userStatusData ? userStatusData.status : 'unknown',
      currentCallId: userStatusData ? userStatusData.currentCallId : null,
      connectedAt: userData.connectedAt,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error in user diagnostic:', error);
    res.status(500).json({
      error: 'Failed to get user diagnostics',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

export default router;
