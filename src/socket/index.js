import { Server } from 'socket.io';
import { setupSocketIOAdapter } from '../config/redis.js';
import { logger } from '../utils/logger.js';
import { registerConnectionHandlers } from './handlers/connection.handler.js';
import { registerCallHandlers } from './handlers/call.handler.js';
import { registerHeartbeatHandlers } from './handlers/heartbeat.handler.js';

export function createSocketServer(httpServer, corsOptions) {
  const io = new Server(httpServer, {
    cors: corsOptions,
    transports: ['websocket', 'polling'],
    pingInterval: 25000,
    pingTimeout: 60000,
    connectTimeout: 45000,
    upgradeTimeout: 30000
  });

  setupSocketIOAdapter(io);

  io.on('connection', (socket) => {
    const clientIp = socket.handshake.address;
    logger.info(`User connected: ${socket.id} from ${clientIp}`);

    socket.emit('connected', {
      socketId: socket.id,
      timestamp: new Date().toISOString(),
      message: 'Connected to TingaTalk server'
    });

    registerConnectionHandlers(io, socket);
    registerCallHandlers(io, socket);
    registerHeartbeatHandlers(io, socket);
  });

  return io;
}
