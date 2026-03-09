import { logger } from '../../utils/logger.js';
import { getAllCallTimers } from '../state/connectionManager.js';

export function registerHeartbeatHandlers(io, socket) {

  socket.on('call_ping', (data) => {
    const { callId, userId, timestamp } = data;
    logger.debug(`Call ping received: callId=${callId}, userId=${userId}`);

    if (callId) {
      const timer = getAllCallTimers().get(callId);
      if (timer) {
        timer.lastHeartbeat = Date.now();
        logger.debug(`Updated lastHeartbeat for call ${callId} via call_ping`);
      }
    }

    socket.emit('call_pong', {
      callId,
      userId,
      serverTime: Date.now(),
      clientTime: timestamp
    });
  });

  socket.on('health_ping', (data) => {
    const { userId, timestamp } = data;
    logger.debug(`Health ping from: ${userId}`);

    // Update lastHeartbeat for any active call by this user
    getAllCallTimers().forEach((timer, callId) => {
      if (timer.callerId === userId || timer.recipientId === userId) {
        timer.lastHeartbeat = Date.now();
        logger.debug(`Updated lastHeartbeat for call ${callId} via health_ping from ${userId}`);
      }
    });

    socket.emit('health_pong', {
      userId,
      serverTime: Date.now(),
      clientTime: timestamp,
      status: 'alive'
    });
  });
}
