/**
 * Fix stale isOnline data for all female users.
 * Sets isOnline=false for all females (since none are actually connected).
 *
 * Usage: node scripts/fix-stale-online.js
 */

import admin from 'firebase-admin';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const serviceAccount = require(path.resolve(projectRoot, 'firebase_service_account.json'));
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: 'tingatalk-53057'
});

const db = admin.firestore();

async function fixStaleOnline() {
  console.log('Querying all female users...');

  const snapshot = await db.collection('users')
    .where('gender', '==', 'female')
    .get();

  console.log(`Found ${snapshot.size} female users`);

  let fixed = 0;
  let alreadyCorrect = 0;

  for (const doc of snapshot.docs) {
    const data = doc.data();
    const userId = doc.id;
    const wasOnline = data.isOnline;
    const wasAvailable = data.isAvailable;

    if (wasOnline === true) {
      await db.collection('users').doc(userId).update({
        isOnline: false,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      console.log(`  FIXED ${userId} (${data.name || 'Unknown'}) - isOnline: true -> false (isAvailable: ${wasAvailable})`);
      fixed++;
    } else {
      console.log(`  OK    ${userId} (${data.name || 'Unknown'}) - isOnline: ${wasOnline} (isAvailable: ${wasAvailable})`);
      alreadyCorrect++;
    }
  }

  console.log(`\nDone: ${fixed} fixed, ${alreadyCorrect} already correct`);
  process.exit(0);
}

fixStaleOnline().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
