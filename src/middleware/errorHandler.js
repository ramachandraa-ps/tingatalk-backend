import { AppError } from '../shared/errors.js';
import { logger } from '../utils/logger.js';

export const errorHandler = (err, req, res, next) => {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      error: err.message,
      ...(err.existingData && { data: err.existingData })
    });
  }

  logger.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    details: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
};

export const notFoundHandler = (req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
};
