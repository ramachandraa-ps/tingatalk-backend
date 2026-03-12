// ============================================================================
// Express Application Assembly
// ============================================================================

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config/index.js';
import { apiLimiter } from './middleware/rateLimiter.js';
import { authenticate } from './middleware/auth.js';
import { adminAuth } from './middleware/adminAuth.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { setupSwagger } from './swagger.js';

// Feature routes
import healthRoutes from './features/health/health.routes.js';
import authRoutes from './features/auth/auth.routes.js';
import packagesRoutes from './features/packages/packages.routes.js';
import usersRoutes from './features/users/users.routes.js';
import availabilityRoutes from './features/availability/availability.routes.js';
import callsRoutes from './features/calls/calls.routes.js';
import callsStandaloneRoutes from './features/calls/calls.standalone.routes.js';
import paymentsRoutes from './features/payments/payments.routes.js';
import rewardsRoutes from './features/rewards/rewards.routes.js';
import payoutsRoutes from './features/payouts/payouts.routes.js';
import statsRoutes from './features/stats/stats.routes.js';
import diagnosticsRoutes from './features/diagnostics/diagnostics.routes.js';
import ticketRoutes from './features/tickets/tickets.routes.js';
import adminTicketRoutes from './features/tickets/admin.tickets.routes.js';

export function createApp() {
  const app = express();

  // Trust proxy (for reverse proxy / Nginx)
  if (config.trustProxy) {
    app.set('trust proxy', 1);
  }

  // Security headers
  if (config.helmet.enabled) {
    app.use(helmet());
  }

  // CORS
  const corsOptions = {
    origin: config.cors.origins,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-api-key'],
    credentials: true
  };
  app.use(cors(corsOptions));

  // Body parsing
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Rate limiting (applied to all API routes)
  app.use('/api/', apiLimiter);

  // Swagger docs (before auth middleware)
  setupSwagger(app);

  // --- Public routes (no auth required) ---
  app.use('/api/health', healthRoutes);
  app.use('/api/auth', authRoutes);
  app.use('/api/packages', packagesRoutes);
  // Pre-call validation routes (Flutter doesn't send auth headers)
  app.use('/api', callsStandaloneRoutes);
  // Availability routes (Flutter doesn't send auth headers)
  app.use('/api', availabilityRoutes);

  // --- Admin routes (before catch-all /api auth routes) ---
  app.use('/api/diagnostic', diagnosticsRoutes);
  app.use('/api/admin/tickets', adminAuth, adminTicketRoutes);

  // --- Authenticated routes ---
  app.use('/api/user', authenticate, usersRoutes);
  app.use('/api/calls', authenticate, callsRoutes);
  app.use('/api/payments', authenticate, paymentsRoutes);
  app.use('/api/rewards', authenticate, rewardsRoutes);
  app.use('/api/tickets', authenticate, ticketRoutes);
  app.use('/api', authenticate, payoutsRoutes);
  app.use('/api', authenticate, statsRoutes);

  // Error handling (must be last)
  app.use(notFoundHandler);
  app.use(errorHandler);

  return { app, corsOptions };
}
