/**
 * One-off Firestore cleanup for stale call docs (2026-05-16, v2).
 *
 * Per cleanup plan in docs/plans/2026-05-16-horizon1-fixes-v2.md (Task 5):
 *
 * Three-tier safe cleanup:
 *   1. Truly orphaned (no billing markers)              → status='abandoned'
 *   2. Already-billed AND female-credited               → status='completed'
 *   3. Billed-but-female-NOT-credited (the owed bucket) → write missing
 *      female_earnings transaction, then status='completed'
 *
 * Safety features:
 *   - Dry-run is default; pass --execute to mutate
 *   - 1-hour age cutoff so no in-flight call is touched
 *   - Auto-detects owed earnings at runtime (no hardcoded callIds — handles
 *     future drift between audit-time and execute-time)
 *   - Safety ABORT if owed-count > 10 (indicates an active bug)
 *   - Records previousStatus on every mutated doc (rollback-friendly)
 *   - billingSource set to admin_cleanup_2026-05-16 (idempotent vs heartbeat)
 *   - Uses IST date for daily bucket (matches dateUtil.js istDateKey added
 *     in commit 97c138f)
 *
 * Usage on VPS:
 *   node scripts/cleanup_stale_calls_2026-05-16.cjs            # dry run
 *   node scripts/cleanup_stale_calls_2026-05-16.cjs --execute  # actually mutate
 */

const admin = require('firebase-admin');
const sa = require('/var/www/tingatalk-backend/firebase_service_account.json');
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const EXECUTE = process.argv.includes('--execute');
const NOW = new Date();
const CLEANUP_TAG = 'admin_cleanup_2026-05-16';
const AGE_CUTOFF_MS = 60 * 60 * 1000; // 1 hour — never touch newer calls
const SAFETY_ABORT_OWED_THRESHOLD = 10;
const NON_TERMINAL = ['initiated', 'ringing', 'accepted', 'active'];

// Rates per backend constants (audio: 4.10/60 = 0.0683, video: 12.30/60 = 0.205)
const FEMALE_EARNING_RATES = {
  audio: 4.10 / 60,
  video: 12.30 / 60,
};

async function main() {
  console.log('='.repeat(72));
  console.log(`STALE CALL CLEANUP v2 — ${EXECUTE ? 'EXECUTE' : 'DRY RUN'}`);
  console.log(`Started: ${NOW.toISOString()}`);
  console.log(`Age cutoff: only touching calls older than ${AGE_CUTOFF_MS / 60000} minute(s)`);
  console.log(`Safety abort threshold: > ${SAFETY_ABORT_OWED_THRESHOLD} owed calls`);
  console.log('='.repeat(72));

  // ===== STEP 1: Scan non-terminal stale calls =====
  const cutoffDate = new Date(NOW.getTime() - AGE_CUTOFF_MS);
  console.log(`\nScanning calls in [${NON_TERMINAL.join(', ')}] created before ${cutoffDate.toISOString()}...`);

  const allStale = [];
  for (const s of NON_TERMINAL) {
    const docs = await db.collection('calls').where('status', '==', s).limit(1000).get();
    docs.forEach(d => {
      const c = d.data();
      const created = c.createdAt && c.createdAt.toDate ? c.createdAt.toDate() : null;
      if (!created) {
        // Legacy/corrupt: no createdAt. Treat as stale (safe — too-old).
        allStale.push({ id: d.id, data: c, hasCreatedAt: false });
      } else if (created < cutoffDate) {
        allStale.push({ id: d.id, data: c, hasCreatedAt: true });
      }
      // else: too new (in-flight) — skip
    });
  }
  console.log(`Found ${allStale.length} stale call doc(s) to process.`);

  // ===== STEP 2: Bucket into 3 tiers =====
  const toAbandon = [];           // no billing markers
  const toComplete = [];          // billed + earnings already present
  const toCreditAndComplete = []; // billed + earnings missing → owe female

  for (const { id, data } of allStale) {
    const wasBilled = (data.durationSeconds || 0) > 0 || (data.coinsDeducted || 0) > 0;
    if (!wasBilled) {
      toAbandon.push({ id, data });
      continue;
    }
    if (!data.recipientId) {
      // Edge case: billed but no recipientId. Treat as already-paid (can't credit nothing).
      toComplete.push({ id, data });
      continue;
    }
    const txnDoc = await db.collection('female_earnings').doc(data.recipientId)
      .collection('transactions').doc(id).get();
    if (txnDoc.exists) {
      toComplete.push({ id, data });
    } else {
      const rate = FEMALE_EARNING_RATES[data.callType] || FEMALE_EARNING_RATES.audio;
      const owedAmt = parseFloat((data.durationSeconds * rate).toFixed(2));
      toCreditAndComplete.push({ id, data, owedAmt });
    }
  }

  console.log(`\nCleanup plan:`);
  console.log(`  → ${toAbandon.length.toString().padStart(4)}  truly orphaned (no billing markers) → 'abandoned'`);
  console.log(`  → ${toComplete.length.toString().padStart(4)}  already-billed-and-credited → 'completed'`);
  console.log(`  → ${toCreditAndComplete.length.toString().padStart(4)}  owed-earnings → CREDIT + 'completed'`);

  if (toCreditAndComplete.length > 0) {
    console.log(`\nOwed-earnings details:`);
    let totalOwed = 0;
    toCreditAndComplete.forEach(o => {
      console.log(`  - callId=${o.id} type=${o.data.callType} dur=${o.data.durationSeconds}s recipient=${o.data.recipientId} owe=₹${o.owedAmt}`);
      totalOwed += o.owedAmt;
    });
    console.log(`Total owed across all: ₹${totalOwed.toFixed(2)}`);
  }

  // ===== STEP 3: Safety abort if owed count is suspiciously high =====
  if (toCreditAndComplete.length > SAFETY_ABORT_OWED_THRESHOLD) {
    console.error(`\n🚨 SAFETY ABORT: ${toCreditAndComplete.length} owed calls detected (threshold ${SAFETY_ABORT_OWED_THRESHOLD}).`);
    console.error(`This indicates an ACTIVE bug systematically skipping female_earnings writes.`);
    console.error(`Investigate the root cause before running cleanup. Aborting.`);
    process.exit(2);
  }

  if (!EXECUTE) {
    console.log(`\n[DRY RUN — no changes made. Re-run with --execute to actually perform.]`);
    process.exit(0);
  }

  console.log(`\n[EXECUTE MODE — making changes to Firestore]`);

  let abandonCount = 0;
  let completeCount = 0;
  let creditCount = 0;

  // ===== STEP 4: Tier 1 — abandon orphans (batched, 100 per batch) =====
  console.log(`\nAbandoning ${toAbandon.length} orphan(s)...`);
  for (let i = 0; i < toAbandon.length; i += 100) {
    const slice = toAbandon.slice(i, i + 100);
    const batch = db.batch();
    slice.forEach(({ id, data }) => {
      batch.update(db.collection('calls').doc(id), {
        status: 'abandoned',
        previousStatus: data.status,
        endReason: CLEANUP_TAG,
        endedAt: NOW,
        cleanedAt: NOW,
        billingSource: CLEANUP_TAG, // marks as 'handled' for heartbeat idempotency
      });
    });
    await batch.commit();
    abandonCount += slice.length;
    console.log(`  abandoned: ${abandonCount}/${toAbandon.length}`);
  }

  // ===== STEP 5: Tier 2 — complete already-billed (batched) =====
  console.log(`\nCompleting ${toComplete.length} already-billed call(s)...`);
  for (let i = 0; i < toComplete.length; i += 100) {
    const slice = toComplete.slice(i, i + 100);
    const batch = db.batch();
    slice.forEach(({ id, data }) => {
      batch.update(db.collection('calls').doc(id), {
        status: 'completed',
        previousStatus: data.status,
        endReason: CLEANUP_TAG,
        endedAt: NOW,
        cleanedAt: NOW,
        billingSource: data.billingSource || CLEANUP_TAG, // preserve existing if present
      });
    });
    await batch.commit();
    completeCount += slice.length;
    console.log(`  completed: ${completeCount}/${toComplete.length}`);
  }

  // ===== STEP 6: Tier 3 — credit owed earnings then complete =====
  console.log(`\nCrediting ${toCreditAndComplete.length} owed earning(s)...`);
  for (const { id, data, owedAmt } of toCreditAndComplete) {
    const earnRef = db.collection('female_earnings').doc(data.recipientId);
    const txnRef = earnRef.collection('transactions').doc(id);

    // Idempotency check in loop (in case prior run partially completed)
    const existingTxn = await txnRef.get();
    if (existingTxn.exists) {
      console.log(`  ⚠ ${id}: transaction already exists, skipping credit, just completing call.`);
    } else {
      // IST date for daily bucket (matches dateUtil.istDateKey in 97c138f)
      const refDate = data.createdAt && data.createdAt.toDate ? data.createdAt.toDate() : NOW;
      const istOffsetMs = 5.5 * 60 * 60 * 1000;
      const istDate = new Date(refDate.getTime() + istOffsetMs);
      const dateKey = istDate.toISOString().split('T')[0];

      const batch = db.batch();
      batch.set(txnRef, {
        callId: id,
        callerId: data.callerId,
        recipientId: data.recipientId,
        callType: data.callType,
        durationSeconds: data.durationSeconds,
        amount: owedAmt,
        currency: 'INR',
        completedAt: NOW.toISOString(),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        status: 'completed',
        source: CLEANUP_TAG,
        type: 'call_earning',
      });
      batch.set(earnRef, {
        totalEarnings: admin.firestore.FieldValue.increment(owedAmt),
        availableBalance: admin.firestore.FieldValue.increment(owedAmt),
        totalCalls: admin.firestore.FieldValue.increment(1),
        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      batch.set(earnRef.collection('daily').doc(dateKey), {
        date: dateKey,
        earnings: admin.firestore.FieldValue.increment(owedAmt),
        calls: admin.firestore.FieldValue.increment(1),
        durationSeconds: admin.firestore.FieldValue.increment(data.durationSeconds),
        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      await batch.commit();
      console.log(`  ✓ ${id}: credited ₹${owedAmt} to ${data.recipientId}`);
      creditCount++;
    }

    // Complete the call doc
    await db.collection('calls').doc(id).update({
      status: 'completed',
      previousStatus: data.status,
      endReason: CLEANUP_TAG + '_with_owed_earnings',
      endedAt: NOW,
      cleanedAt: NOW,
      billingSource: CLEANUP_TAG,
    });
  }

  console.log(`\n${'='.repeat(72)}`);
  console.log(`CLEANUP COMPLETE`);
  console.log(`  abandoned:        ${abandonCount}`);
  console.log(`  completed:        ${completeCount}`);
  console.log(`  owed-credited:    ${creditCount}`);
  console.log(`  total processed:  ${abandonCount + completeCount + toCreditAndComplete.length}`);
  console.log('='.repeat(72));

  process.exit(0);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
