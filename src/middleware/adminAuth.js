import { config } from '../config/index.js';

export const adminAuth = (req, res, next) => {
  const apiKey = req.headers['x-admin-api-key'];
  if (!config.admin.apiKey) {
    return res.status(503).json({ error: 'Admin API key not configured' });
  }
  if (apiKey !== config.admin.apiKey) {
    return res.status(403).json({ error: 'Invalid admin API key' });
  }
  next();
};
