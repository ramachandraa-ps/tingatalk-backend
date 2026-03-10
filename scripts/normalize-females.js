/**
 * Normalize female user availability in Firestore.
 * Sets recently active verified females to isAvailable: true.
 *
 * Usage: node scripts/normalize-females.js
 */

import admin from 'firebase-admin';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

// Initialize Firebase
const serviceAccount = require(path.resolve(projectRoot, 'firebase_service_account.json'));
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: 'tingatalk-53057'
});

const db = admin.firestore();

async function normalize() {
  console.log('Querying female users...');

  const snapshot = await db.collection('users')
    .where('gender', '==', 'female')
    .where('isVerified', '==', true)
    .get();

  console.log(`Found ${snapshot.size} verified female users`);

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  let updated = 0;
  let skipped = 0;

  for (const doc of snapshot.docs) {
    const data = doc.data();
    const userId = doc.id;

    // Check if user was active in last 30 days
    const lastSeen = data.lastSeenAt?.toDate?.() || data.lastConnectedAt?.toDate?.() || null;
    const isRecentlyActive = lastSeen && lastSeen > thirtyDaysAgo;

    // Remove stale fields, set availability
    const updateData = {
      isAvailable: isRecentlyActive ? true : false,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    // Clean stale fields if they exist
    const staleFields = ['unavailableReason', 'availabilityPreference', 'availabilityFixReason', 'availabilityFixedAt', 'lastAvailabilityChange'];
    for (const field of staleFields) {
      if (data[field] !== undefined) {
        updateData[field] = admin.firestore.FieldValue.delete();
      }
    }

    await db.collection('users').doc(userId).update(updateData);

    if (isRecentlyActive) {
      console.log(`  + ${userId} (${data.name || 'Unknown'}) -> isAvailable: true (last seen: ${lastSeen?.toISOString()})`);
      updated++;
    } else {
      console.log(`  - ${userId} (${data.name || 'Unknown'}) -> isAvailable: false (inactive >30 days)`);
      skipped++;
    }
  }

  console.log(`\nDone: ${updated} set to available, ${skipped} remain unavailable`);
  process.exit(0);
}

normalize().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
