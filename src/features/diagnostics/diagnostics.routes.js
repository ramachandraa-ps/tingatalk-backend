import { Router } from 'express';
import { adminAuth } from '../../middleware/adminAuth.js';
import { logger } from '../../utils/logger.js';
import {
  getAllConnectedUsers, getAllUserStatuses, getAllActiveCalls, getConnectedUser, getUserStatus
} from '../../socket/state/connectionManager.js';

const router = Router();

/**
 * @openapi
 * /api/diagnostic/connections:
 *   get:
 *     tags:
 *       - Diagnostics
 *     summary: Get full connection diagnostics
 *     description: Returns detailed diagnostics including all connected users, user statuses, active calls, and socket room assignments. Requires admin API key.
 *     security:
 *       - AdminApiKey: []
 *     responses:
 *       200:
 *         description: Connection diagnostics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                 totalSocketsConnected:
 *                   type: integer
 *                 connectedUsers:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       userId:
 *                         type: string
 *                       socketId:
 *                         type: string
 *                       userType:
 *                         type: string
 *                       isOnline:
 *                         type: boolean
 *                       socketExists:
 *                         type: boolean
 *                       rooms:
 *                         type: array
 *                         items:
 *                           type: string
 *                       connectedAt:
 *                         type: string
 *                 userStatus:
 *                   type: array
 *                   items:
 *                     type: object
 *                 activeCalls:
 *                   type: array
 *                   items:
 *                     type: object
 *                 socketRooms:
 *                   type: array
 *                   items:
 *                     type: object
 *       403:
 *         description: Invalid admin API key
 *       503:
 *         description: Admin API key not configured
 *       500:
 *         description: Server error
 */
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

/**
 * @openapi
 * /api/diagnostic/user/{userId}:
 *   get:
 *     tags:
 *       - Diagnostics
 *     summary: Get diagnostics for a specific user
 *     description: Returns connection and status diagnostics for a single user, including socket state, room membership, and call status. Requires admin API key.
 *     security:
 *       - AdminApiKey: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *         description: The user ID to diagnose
 *     responses:
 *       200:
 *         description: User diagnostics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 userId:
 *                   type: string
 *                 isConnected:
 *                   type: boolean
 *                 socketId:
 *                   type: string
 *                 userType:
 *                   type: string
 *                 socketExists:
 *                   type: boolean
 *                 rooms:
 *                   type: array
 *                   items:
 *                     type: string
 *                 expectedRoom:
 *                   type: string
 *                 isInExpectedRoom:
 *                   type: boolean
 *                 status:
 *                   type: string
 *                 currentCallId:
 *                   type: string
 *                   nullable: true
 *                 connectedAt:
 *                   type: string
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *       403:
 *         description: Invalid admin API key
 *       404:
 *         description: User not found
 *       503:
 *         description: Admin API key not configured
 *       500:
 *         description: Server error
 */
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
