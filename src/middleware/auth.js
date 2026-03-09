import { admin } from '../config/firebase.js';
import { logger } from '../utils/logger.js';

export const authenticate = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization header' });
  }

  try {
    const idToken = authHeader.split('Bearer ')[1];
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.authenticatedUserId = decodedToken.uid;
    next();
  } catch (error) {
    logger.warn(`Auth failed: ${error.message}`);
    return res.status(401).json({ error: 'Invalid or expired auth token' });
  }
};
