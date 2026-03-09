import admin from 'firebase-admin';
import { config } from './index.js';
import { createRequire } from 'module';
import { logger } from '../utils/logger.js';

const require = createRequire(import.meta.url);

let firestore = null;
let messaging = null;

export async function initFirebase() {
  try {
    if (admin.apps.length > 0) {
      logger.info('Firebase Admin already initialized');
      firestore = admin.firestore();
      messaging = admin.messaging();
      return;
    }

    if (config.firebase.serviceAccountPath) {
      const serviceAccount = require(config.firebase.serviceAccountPath);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: config.firebase.projectId
      });
      logger.info('Firebase Admin initialized with service account');
    } else if (config.firebase.projectId) {
      admin.initializeApp({ projectId: config.firebase.projectId });
      logger.info('Firebase Admin initialized with project ID');
    } else {
      admin.initializeApp({ projectId: 'tingatalk-53057' });
      logger.info('Firebase Admin initialized with default config');
    }

    firestore = admin.firestore();
    messaging = admin.messaging();

    // Test connection
    await firestore.collection('_health_check').doc('test').set({
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      status: 'ok'
    });

    logger.info('Firestore connection test successful');
  } catch (error) {
    logger.error('Firebase initialization error:', error.message);
    logger.warn('Continuing without Firebase - some features may not work');
  }
}

export function getFirestore() {
  return firestore;
}

export function getMessaging() {
  return messaging;
}

export { admin };
