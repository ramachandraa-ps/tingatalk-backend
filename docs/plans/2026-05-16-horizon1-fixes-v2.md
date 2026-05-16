# Horizon 1 Production Fixes — Implementation Plan v2 (POST-REVIEW)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Address 3 client-reported production bugs (Line Busy, missing female earnings, zombie call billing) via 6 surgical backend changes that prevent recurrence + clean up the 320+ stale Firestore call docs + restore ₹4.44 owed to 2 female users — all without dropping any in-flight calls.

**Architecture:** Backend-only changes (no Flutter rebuild). Two execution groups: (A) Data cleanup — Firestore script with auto-detect + dry-run-first; (B) Code fixes — surgical edits to `backgroundJobs.js`, `call.handler.js`, `callBillingUtil.js` + 1 new Firestore composite index. Cleanup runs first (zero user impact). Code fixes deploy to staging → manual production promotion when `activeCalls=0`.

**Tech Stack:** Node.js 22, Socket.IO 4.x, Firestore (firebase-admin), PM2 fork mode, GitHub Actions CI.

**Branch:** `fix/horizon1-production-fixes-v2` off `feature/modular-backend`.

---

## CHANGES vs PLAN v1 (per code-reviewer critique)

| Original | v2 | Why |
|---|---|---|
| Bug A fix at FCM-timeout block | **Bug A fix is server-side INITIATE_CALL dedup** (mirrors join-dedup pattern) | Reviewer B1: my original fix targeted wrong code path. Verified via logs: real cause is duplicate INITIATE_CALL from Flutter, NOT stale FCM-timeout state. |
| Task 1 expanded idempotency list to 3 statuses | **Task 1 switches to billingSource-based idempotency** | Reviewer R1: status is the wrong dimension to check; billingSource is what actually indicates "already billed." Harmonizes with existing `ALREADY_BILLED` pattern at `call.handler.js:589-622`. |
| Reaper directly queries `where(status==X).where(createdAt<cutoff)` | **Adds composite index deploy as Task 4a (prerequisite)** | Reviewer B3: index missing → reaper would fail on first tick with FAILED_PRECONDITION. |
| Cleanup script hardcodes 1 owed callId | **Cleanup script auto-detects owed earnings at runtime, with max-10 safety abort** | Reviewer R5: there are actually 2 owed calls, and the snapshot from earlier today is already stale. Auto-detect protects against future drift. |
| Cleanup script could touch in-flight calls | **Cleanup script adds 1-hour age cutoff** | Reviewer R6: prevent any chance of touching an active legitimate call. |
| `npm audit fix` was Task 6 | **REMOVED from this cycle** | Reviewer R7: Socket.IO version bumps can break Flutter client handshake. Mixing dep upgrades with feature fixes is bad blast-radius design. Defer to standalone cycle. |
| (none) | **Adds `previousStatus` field to all cleanup writes** | Reviewer I3: enables proper rollback script if needed. |

---

## Pre-flight

### Task 0: Branch setup

**Files:** N/A (git operations)

**Step 1: Confirm clean state on `feature/modular-backend`**

```bash
cd d:/welbuilt/tingatalk-backend
git checkout feature/modular-backend
git pull origin feature/modular-backend
git status --short
```
Expected: clean working tree.

**Step 2: Create v2 fix branch**

```bash
git checkout -b fix/horizon1-production-fixes-v2
```

**Step 3: Verify**
```bash
git branch --show-current
```
Expected: `fix/horizon1-production-fixes-v2`

---

## Task 1: Bug C fix — billingSource-based idempotency

**Files:**
- Modify: `D:\welbuilt\tingatalk-backend\src\backgroundJobs.js` (around line 77 — the TERMINAL_STATUSES check)

**Why (per reviewer R1):** The reviewer pointed out that checking `status in TERMINAL_STATUSES` is the wrong dimension. The correct check is "has billing already been performed?" — which is what `billingSource` field indicates. The `end_call` handler at `call.handler.js:589-622` already uses this exact pattern with a `ALREADY_BILLED` set.

**Step 1: Read the existing check**

```bash
sed -n '70,95p' src/backgroundJobs.js
```

**Step 2: Read the existing ALREADY_BILLED pattern in call.handler.js for reference**

```bash
sed -n '585,625p' src/socket/handlers/call.handler.js | grep -A 5 "ALREADY_BILLED\|billingSource"
```
Expected: find the `Set` definition of already-billed sources.

**Step 3: Apply the edit**

Where the heartbeat-stale-detection currently does (paraphrased):
```js
const TERMINAL_STATUSES = ['cancelled', 'declined', 'ended', 'completed', 'timeout', 'timeout_heartbeat', 'timeout_runaway'];
if (TERMINAL_STATUSES.includes(callData.status)) {
  // skip billing
  return;
}
```

Change to (preserve the existing TERMINAL_STATUSES variable for backward compat — other code may reference it):
```js
// Sources that indicate billing has already been performed by another path.
// MUST stay in sync with ALREADY_BILLED in call.handler.js end_call handler.
// Verified against every performCallBilling() caller in the codebase:
//   - 'normal_completion' (call.handler.js, calls.routes.js)
//   - 'server_auto_end' (call.handler.js, calls.routes.js auto-end timer)
//   - 'disconnect_recovery' (connection.handler.js disconnect handler)
//   - 'client_fallback' (calls.routes.js fallback billing path)
//   - 'stale_call_recovery' (backgroundJobs.js heartbeat-timeout self-bill — this file)
//   - 'admin_cleanup_2026-05-16' (one-off cleanup script, marks already-handled)
const BILLED_SOURCES = new Set([
  'server',                       // legacy value (still used by some older call docs)
  'normal_completion',
  'server_auto_end',
  'disconnect_recovery',
  'client_fallback',
  'stale_call_recovery',
  'admin_cleanup_2026-05-16',
]);

// Status field gates: terminal states that should not be re-billed regardless of billingSource
// (kept as defense-in-depth — original list extended with missed/abandoned/disconnected).
const TERMINAL_STATUSES = ['cancelled', 'declined', 'ended', 'completed', 'timeout', 'timeout_heartbeat', 'timeout_runaway', 'disconnected', 'abandoned', 'missed'];

// Skip billing if EITHER signal indicates the call was already handled
if (
  (callData.billingSource && BILLED_SOURCES.has(callData.billingSource)) ||
  TERMINAL_STATUSES.includes(callData.status)
) {
  logger.debug(`Skipping billing for ${callId} — already handled (status=${callData.status}, billingSource=${callData.billingSource || 'none'})`);
  return;
}
```

**Step 4: Verify syntax**
```bash
node --check src/backgroundJobs.js
```
Expected: silent.

**Step 5: Commit**

```bash
git add src/backgroundJobs.js
git commit -m "fix(billing): use billingSource as primary idempotency signal

Reviewer flagged that status-based idempotency was the wrong dimension.
The correct signal is 'has billing already been performed' = billingSource.
This change uses billingSource as primary check, with status as defense-in-depth.

Also extends TERMINAL_STATUSES with disconnected/abandoned/missed for the
defense-in-depth secondary check. Harmonized with ALREADY_BILLED set in
call.handler.js end_call handler.

Fixes Bug C: heartbeat-stale-detection was re-billing disconnect-recovered
calls because 'disconnected' was missing from the list. Now both signals
must indicate 'unbilled' before billing executes — true idempotency.

Refs: docs/plans/2026-05-16-horizon1-fixes-v2.md, project_three_bugs_analysis_2026-05-16.md
"
```

---

## Task 2: Bug A fix — server-side INITIATE_CALL deduplication

**Files:**
- Modify: `D:\welbuilt\tingatalk-backend\src\socket\handlers\call.handler.js` (top of `initiate_call` handler, around line 95)

**Why:** Log forensics confirmed Bug A's actual root cause: the Flutter client fires duplicate INITIATE_CALL events ~150ms apart for the same `(callerId, recipientId)` pair. First succeeds and sets recipient to `ringing`. Second arrives, sees `ringing`, and emits `is_busy: true` (the "Line Busy" UX). Flutter client also needs a fix (tap-debounce in male_home_screen) but that's a separate cycle requiring AAB release. **This server-side dedup is the immediate stop-the-bleeding fix.**

Pattern mirrors the existing `recentJoinsByUser` dedup at `connection.handler.js:18, 65-82`.

**Step 1: Read the existing join-dedup pattern for the exact idiom**

```bash
sed -n '15,82p' src/socket/handlers/connection.handler.js
```

**Step 2: Add module-scope dedup map to call.handler.js (near top, after imports)**

Insert after the import block (around line 12 — after `import { COIN_RATES, CALL_RING_TIMEOUT_MS, FCM_CALL_TIMEOUT_MS } from '../../shared/constants.js';` and before `// FCM notification helper`):

```js
// Dedup rapid duplicate INITIATE_CALL events from same caller→recipient pair.
// Flutter client fires multiple events ~100-200ms apart (tap-debounce bug);
// the first sets recipient to 'ringing', the duplicates see it and would emit
// 'is_busy' = the user-visible "Line Busy" error. This map silently absorbs
// the duplicate. Window of 3s is safely longer than the observed dup-gap.
const recentInitiateByPair = new Map(); // key: `${callerId}_${recipientId}`, value: timestamp
const INITIATE_DEDUP_WINDOW_MS = 3000;

// Periodic cleanup of map to prevent unbounded growth.
setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of recentInitiateByPair.entries()) {
    if (now - ts > INITIATE_DEDUP_WINDOW_MS * 2) recentInitiateByPair.delete(key);
  }
}, 60000); // every 60 seconds
```

**Step 3: Add the dedup check at the very top of `initiate_call` handler**

Currently the handler starts at ~line 95:
```js
socket.on('initiate_call', async (data) => {
  const { callerId, recipientId, callType = 'video', callId, roomName, callerName: providedCallerName } = data;
  logger.info(`INITIATE_CALL: Caller=${callerId}, Recipient=${recipientId}, Type=${callType}`);
  if (!callerId || !recipientId) { ... }
```

Add the dedup check IMMEDIATELY AFTER the existence check on callerId/recipientId, BEFORE STEP 0:

```js
  // Bug A fix: dedup duplicate INITIATE_CALL events from same caller→recipient.
  // Observed: Flutter client fires duplicates 100-200ms apart; first succeeds and
  // sets recipient to ringing; duplicates would emit is_busy='Line Busy' to caller.
  // Silently ack duplicates as success — caller already has the right state from
  // the first event.
  const pairKey = `${callerId}_${recipientId}`;
  const lastInitiateTs = recentInitiateByPair.get(pairKey);
  const nowMs = Date.now();
  if (lastInitiateTs && (nowMs - lastInitiateTs) < INITIATE_DEDUP_WINDOW_MS) {
    logger.info(`INITIATE_CALL deduped: ${callerId}→${recipientId} within ${nowMs - lastInitiateTs}ms of prior`);
    // Silently acknowledge — caller already has call_initiated event from the first.
    return;
  }
  recentInitiateByPair.set(pairKey, nowMs);
```

**Step 4: Verify syntax**
```bash
node --check src/socket/handlers/call.handler.js
```

**Step 5: Commit**

```bash
git add src/socket/handlers/call.handler.js
git commit -m "fix(call): server-side INITIATE_CALL deduplication

Fixes Bug A 'Line Busy' false positives at the ROOT CAUSE.

Log forensics revealed: every 'CALL BLOCKED: Recipient is ringing' was
caused by Flutter client firing INITIATE_CALL twice within 100-200ms for
the same caller→recipient pair. First call sets recipient to 'ringing';
the duplicate arrives, sees ringing, and emits is_busy=true to the caller
— which the Flutter app surfaces as 'Line Busy'.

This server-side dedup (3-second window, in-memory Map with periodic
cleanup) silently absorbs duplicates so the user never sees the false error.
Mirrors the existing recentJoinsByUser pattern in connection.handler.js.

Flutter-side tap-debounce fix is needed long-term but requires AAB release;
this server fix protects users immediately.

Refs: docs/plans/2026-05-16-horizon1-fixes-v2.md
"
```

---

## Task 3: Bug B observability — `BILLING_WRITE` log line

**Files:**
- Modify: `D:\welbuilt\tingatalk-backend\src\utils\callBillingUtil.js` (immediately after the female_earnings transaction write)

**Why:** Per reviewer I2, adds critical observability for future Bug B investigations. Plan v1 had this right; only enhancement is adding `actualDeduction` and `callType` to the log per reviewer's suggestion.

**Step 1: Read the female_earnings write block**

```bash
grep -n "transactions" src/utils/callBillingUtil.js | head -5
sed -n '155,180p' src/utils/callBillingUtil.js
```

**Step 2: Insert the log line AFTER the await of the transaction set succeeds**

```js
// Bug B observability: emit one structured log per successful female-earnings credit.
// Makes 'was call X credited?' answerable via grep instead of Firestore query.
// MUST stay AFTER the await so it only logs on success.
logger.info(`BILLING_WRITE: callId=${callId} recipientId=${recipientId} earningAmount=${earningAmount} callType=${callType} durationSeconds=${durationSeconds} actualDeduction=${actualDeduction} source=${source}`);
```

(Verify variable names match what's actually in scope at that line.)

**Step 3: Verify syntax**
```bash
node --check src/utils/callBillingUtil.js
```

**Step 4: Commit**

```bash
git add src/utils/callBillingUtil.js
git commit -m "feat(observability): add BILLING_WRITE log line after female-earnings credit

Bug B investigation required Firestore queries because this code path
produced no log line. This single INFO line makes future investigations
grep-able in seconds.

Format includes: callId, recipientId, earningAmount, callType,
durationSeconds, actualDeduction, source — covering both sides of the
billing transaction in one line.

Adds ~135 lines/day at current volume (one per successful call billing).
Negligible against existing 56K lines/hour total log volume.

Refs: docs/plans/2026-05-16-horizon1-fixes-v2.md
"
```

---

## Task 4a: Deploy Firestore composite index (PREREQUISITE for Task 4)

**Files:**
- Create: `D:\welbuilt\tingatalk-backend\firestore.indexes.json`
- Create: `D:\welbuilt\tingatalk-backend\firebase.json` (update existing — add firestore config)

**Why (per reviewer B3):** The reaper's Firestore query `where(status==X).where(createdAt<cutoff)` requires a composite index. Without it, the reaper fails on first tick with `FAILED_PRECONDITION` and never produces observability output. Must deploy the index BEFORE the reaper code is deployed.

**Step 1: Check current firebase.json**

```bash
cat firebase.json
```
Currently only has `storage` config. Need to add `firestore` config.

**Step 2: Update `firebase.json`**

```json
{
  "storage": {
    "rules": "storage.rules"
  },
  "firestore": {
    "indexes": "firestore.indexes.json",
    "rules": "firestore.rules"
  }
}
```

Note: only deploy indexes for now. Rules deploy is out of scope (we don't want to overwrite current Firestore rules).

**Step 3: Create `firestore.indexes.json`**

```json
{
  "indexes": [
    {
      "collectionGroup": "calls",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "status", "order": "ASCENDING" },
        { "fieldPath": "createdAt", "order": "ASCENDING" }
      ]
    }
  ],
  "fieldOverrides": []
}
```

**Step 4: Deploy the index via Firebase CLI (you must run this from local machine, not VPS)**

```bash
cd d:/welbuilt/tingatalk-backend
firebase login:use tingatalkofficial@gmail.com
firebase deploy --only firestore:indexes --project tingatalk-53057
```

Expected output: "Deploying indexes..." → "Deploy complete!" (may take 1-5 minutes for index to build in background).

**Step 5: Verify index is building/built via Firebase console URL printed by CLI**

The CLI will print a URL like `https://console.firebase.google.com/.../firestore/indexes`. Visit and confirm the new index is "Building" or "Enabled."

**Step 5b: 🛑 BLOCKING CHECKPOINT — WAIT for index status to read "Enabled"**

Do NOT proceed past this step until the Firebase console shows the new composite index status as **"Enabled"** (not "Building"). For the `calls` collection at current scale (~2,300 docs), expect 1-3 minutes. For larger collections, can take 10-30 minutes.

While waiting, you can poll status via CLI:
```bash
firebase firestore:indexes --project tingatalk-53057
```

**Why this matters:** if the reaper code (Task 4) is deployed before the index is enabled, its first tick will fail with `FAILED_PRECONDITION` and log an error. The error handler is graceful, but better to avoid the noise. Also, deploying the reaper IS the way to discover whether the index is actually correct for the query.

**Step 6: Commit (only after deploy succeeds)**

```bash
git add firebase.json firestore.indexes.json
git commit -m "chore(firestore): add composite index for calls(status, createdAt)

Required by the stale-call reaper job (Task 4 in this PR). Reviewer B3
flagged that the reaper's compound query would fail with FAILED_PRECONDITION
without this index.

Index deployed via firebase deploy --only firestore:indexes from local
tingatalkofficial@gmail.com account (the only one with project access).

Refs: docs/plans/2026-05-16-horizon1-fixes-v2.md
"
```

---

## Task 4: Stale-call reaper (observability-only mode)

**Files:**
- Modify: `D:\welbuilt\tingatalk-backend\src\backgroundJobs.js` (add reaper function + interval registration)

**Why:** Defense-in-depth. If any future code path creates stale calls, the reaper detects them within 1 hour and logs warnings. Observability-only — does NOT mutate data in this version. After 1 week of zero false positives, single boolean flip enables auto-cleanup.

**Step 1: Read existing background job structure**

```bash
grep -n "setInterval\|HEARTBEAT_CHECK_INTERVAL\|export function" src/backgroundJobs.js | head -10
```

**Step 2: Verify required imports are at top of file**

```bash
head -20 src/backgroundJobs.js
```
Need: `getFirestore`, `admin`, `logger`. Add if missing.

**Step 3: Add the reaper function**

Insert near other job definitions:

```js
// =========================================================================
// STALE CALL REAPER — observability only (v1)
// =========================================================================
// Detects calls stuck in non-terminal Firestore states for >2 hours.
// 2h threshold is well above the 60-min hard call cap, so legitimate calls
// can never trigger. In observe-only mode, only logs warnings — does NOT
// mutate any data. After 1 week of zero false positives, flip
// STALE_CALL_REAPER_AUTOCLEAN to true for self-healing cleanup.
//
// Requires composite index: calls (status ASC, createdAt ASC).
// Deployed via firestore.indexes.json in same commit set as this job.
const STALE_CALL_REAPER_AUTOCLEAN = false; // v1: observe-only
const STALE_CALL_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours
const STALE_CALL_REAPER_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const STALE_CALL_REAPER_NON_TERMINAL = ['initiated', 'ringing', 'accepted', 'active'];

async function staleCallReaperTick() {
  try {
    const db = getFirestore();
    if (!db) return;

    const cutoff = new Date(Date.now() - STALE_CALL_THRESHOLD_MS);
    const cutoffTs = admin.firestore.Timestamp.fromDate(cutoff);

    let totalFound = 0;
    const samples = [];

    for (const status of STALE_CALL_REAPER_NON_TERMINAL) {
      const snap = await db.collection('calls')
        .where('status', '==', status)
        .where('createdAt', '<', cutoffTs)
        .limit(100)
        .get();
      snap.forEach(d => {
        totalFound++;
        if (samples.length < 5) {
          const data = d.data();
          const ageMin = data.createdAt && data.createdAt.toDate
            ? Math.round((Date.now() - data.createdAt.toDate().getTime()) / 60000)
            : 'n/a';
          samples.push({ id: d.id, status, ageMin, caller: data.callerId, recipient: data.recipientId });
        }
      });
    }

    if (totalFound === 0) {
      logger.info('STALE_CALL_REAPER: clean tick (0 stale calls detected)');
      return;
    }

    logger.warn(`STALE_CALL_REAPER: detected ${totalFound} stale call docs (>2h old in non-terminal state). AUTOCLEAN=${STALE_CALL_REAPER_AUTOCLEAN}.`);
    samples.forEach(f => {
      logger.warn(`  STALE_CALL: callId=${f.id} status=${f.status} ageMin=${f.ageMin} caller=${f.caller} recipient=${f.recipient}`);
    });

    if (STALE_CALL_REAPER_AUTOCLEAN) {
      logger.warn('STALE_CALL_REAPER: AUTOCLEAN enabled but not yet implemented — observability-only mode');
    }
  } catch (err) {
    logger.error(`STALE_CALL_REAPER tick error: ${err.message}`);
    if (err.code === 'FAILED_PRECONDITION') {
      logger.error('STALE_CALL_REAPER: Firestore composite index missing. Deploy firestore.indexes.json then restart.');
    }
  }
}
```

**Step 4: Register the interval**

Find the existing interval registration block (where HEARTBEAT_CHECK_INTERVAL_MS interval is registered) and add nearby:

```js
setInterval(staleCallReaperTick, STALE_CALL_REAPER_INTERVAL_MS);
logger.info(`STALE_CALL_REAPER: registered (interval ${STALE_CALL_REAPER_INTERVAL_MS / 60000}min, threshold ${STALE_CALL_THRESHOLD_MS / 60000}min, AUTOCLEAN=${STALE_CALL_REAPER_AUTOCLEAN})`);
```

**Step 5: Verify syntax**
```bash
node --check src/backgroundJobs.js
```

**Step 6: Commit**

```bash
git add src/backgroundJobs.js
git commit -m "feat(reaper): observability-only stale-call detection job

Hourly background job detects calls stuck in non-terminal Firestore states
for >2 hours. v1 mode: OBSERVABILITY ONLY — logs warnings, does NOT mutate
data. After a week of zero false positives, flip STALE_CALL_REAPER_AUTOCLEAN
constant for self-healing auto-cleanup.

Defense in depth: even if a future code change introduces a stale-call leak,
the warning fires within 1 hour and is grep-able from logs.

Requires composite index calls(status, createdAt) — deployed in same PR.
Includes graceful FAILED_PRECONDITION error handler that suggests fix.

Refs: docs/plans/2026-05-16-horizon1-fixes-v2.md
"
```

---

## Task 5: Cleanup script v2 — auto-detect, safety guards, rollback-friendly

**Files:**
- Create: `D:\welbuilt\tingatalk-backend\scripts\cleanup_stale_calls_2026-05-16.cjs`

**Why:** Per reviewers R5 (more owed calls than thought), R6 (touch only old calls), I3 (record previousStatus for rollback). Auto-detect at runtime so the script is correct regardless of timing.

**Step 1: Create scripts directory if needed**

```bash
mkdir -p scripts
```

**Step 2: Create the script**

```js
/**
 * One-off Firestore cleanup for stale call docs (2026-05-16, v2).
 *
 * v2 changes from plan v1:
 *   - Auto-detect owed earnings (don't hardcode callIds)
 *   - Add 1-hour age cutoff so in-flight calls cannot be touched
 *   - Record previousStatus on every mutated doc (rollback-friendly)
 *   - Abort if owed-count > 10 (safety guard against unknown bug)
 *
 * Three-tier safe cleanup:
 *   - Truly orphaned (no billing markers) → status='abandoned'
 *   - Already-billed-AND-paid → status='completed'
 *   - Billed-but-female-NOT-credited → write missing female_earnings transaction,
 *     then status='completed'
 *
 * Usage:
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
  console.log(`Age cutoff: only touching calls older than ${AGE_CUTOFF_MS / 60000} minutes`);
  console.log('='.repeat(72));

  // ===== STEP 1: Scan non-terminal stale calls =====
  const cutoffDate = new Date(NOW.getTime() - AGE_CUTOFF_MS);
  console.log(`\nScanning ${NON_TERMINAL.join(', ')} calls created before ${cutoffDate.toISOString()}...`);

  const allStale = [];
  for (const s of NON_TERMINAL) {
    const docs = await db.collection('calls').where('status', '==', s).limit(1000).get();
    docs.forEach(d => {
      const c = d.data();
      const created = c.createdAt && c.createdAt.toDate ? c.createdAt.toDate() : null;
      if (!created) {
        // Calls without createdAt are legacy or corrupt — treat as stale
        allStale.push({ id: d.id, data: c, hasCreatedAt: false });
      } else if (created < cutoffDate) {
        allStale.push({ id: d.id, data: c, hasCreatedAt: true });
      }
      // else: too new, skip
    });
  }
  console.log(`Found ${allStale.length} stale calls to process.`);

  // ===== STEP 2: Bucket each into one of 3 tiers =====
  const toAbandon = [];        // no billing markers
  const toComplete = [];       // billed + earnings already present
  const toCreditAndComplete = []; // billed + earnings missing → owe female

  for (const { id, data } of allStale) {
    const wasBilled = (data.durationSeconds || 0) > 0 || (data.coinsDeducted || 0) > 0;
    if (!wasBilled) {
      toAbandon.push({ id, data });
      continue;
    }
    // Billed — check if female_earnings transaction exists
    if (!data.recipientId) {
      // Edge case: billed but no recipientId? Treat as already-paid (don't credit).
      toComplete.push({ id, data });
      continue;
    }
    const txnDoc = await db.collection('female_earnings').doc(data.recipientId)
      .collection('transactions').doc(id).get();
    if (txnDoc.exists) {
      toComplete.push({ id, data });
    } else {
      // Compute owed amount
      const rate = FEMALE_EARNING_RATES[data.callType] || FEMALE_EARNING_RATES.audio;
      const owedAmt = parseFloat((data.durationSeconds * rate).toFixed(2));
      toCreditAndComplete.push({ id, data, owedAmt });
    }
  }

  console.log(`\nCleanup plan:`);
  console.log(`  → ${toAbandon.length}      truly orphaned (no billing) → mark 'abandoned'`);
  console.log(`  → ${toComplete.length}      already-billed-and-paid → mark 'completed'`);
  console.log(`  → ${toCreditAndComplete.length}      owed-earnings → credit + mark 'completed'`);

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
  if (toCreditAndComplete.length > 10) {
    console.error(`\n🚨 SAFETY ABORT: ${toCreditAndComplete.length} owed calls detected (>10 threshold).`);
    console.error(`This suggests an active bug systematically skipping female_earnings writes.`);
    console.error(`Investigate before running cleanup. Aborting.`);
    process.exit(1);
  }

  if (!EXECUTE) {
    console.log(`\n[DRY RUN — no changes made. Re-run with --execute to actually perform.]`);
    process.exit(0);
  }

  console.log(`\n[EXECUTE MODE — making changes to Firestore]`);

  let abandonCount = 0;
  let completeCount = 0;
  let creditCount = 0;

  // ===== STEP 4: Tier 1 — abandon orphans (batched) =====
  console.log(`\nAbandoning ${toAbandon.length} orphans (batched, 100 per batch)...`);
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
        billingSource: CLEANUP_TAG, // mark as "handled" for idempotency
      });
    });
    await batch.commit();
    abandonCount += slice.length;
    console.log(`  abandoned: ${abandonCount}/${toAbandon.length}`);
  }

  // ===== STEP 5: Tier 2 — complete already-billed (batched) =====
  console.log(`\nCompleting ${toComplete.length} already-billed calls...`);
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
        billingSource: data.billingSource || CLEANUP_TAG,
      });
    });
    await batch.commit();
    completeCount += slice.length;
    console.log(`  completed: ${completeCount}/${toComplete.length}`);
  }

  // ===== STEP 6: Tier 3 — credit owed earnings then complete =====
  console.log(`\nCrediting ${toCreditAndComplete.length} owed earnings...`);
  for (const { id, data, owedAmt } of toCreditAndComplete) {
    const earnRef = db.collection('female_earnings').doc(data.recipientId);
    const txnRef = earnRef.collection('transactions').doc(id);

    // Idempotency check inside the loop (in case prior run partially completed)
    const existingTxn = await txnRef.get();
    if (existingTxn.exists) {
      console.log(`  ⚠ ${id}: transaction already exists, skipping credit, just completing call.`);
    } else {
      // Use IST date for daily bucket consistency with the rest of the codebase
      // (see src/utils/dateUtil.js istDateKey added in commit 97c138f).
      // Inline implementation here so this script remains standalone.
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
  console.log(`  owed-paid:        ${creditCount}`);
  console.log(`  total processed:  ${abandonCount + completeCount + toCreditAndComplete.length}`);
  console.log('='.repeat(72));

  process.exit(0);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
```

**Step 3: Verify syntax**
```bash
node --check scripts/cleanup_stale_calls_2026-05-16.cjs
```

**Step 4: Commit (script only, not yet run)**

```bash
git add scripts/cleanup_stale_calls_2026-05-16.cjs
git commit -m "chore(cleanup): script v2 for historical stale call docs

v2 improvements per reviewer feedback (R5, R6, I3):
  - Auto-detects owed earnings at runtime (don't hardcode callIds)
  - 1-hour age cutoff (never touch in-flight calls)
  - Records previousStatus on every mutated doc (rollback-friendly)
  - Safety abort if owed-count exceeds 10 (indicates active bug)
  - billingSource set to admin_cleanup_2026-05-16 (idempotent vs heartbeat)

Three-tier approach (audited and approved):
  - truly orphaned (no billing markers) → 'abandoned'
  - already-billed-and-paid → 'completed'
  - billed-but-not-credited → credit female + 'completed'

Dry-run by default; pass --execute to mutate.
Idempotent: re-running skips already-credited transactions.

Refs: docs/plans/2026-05-16-horizon1-fixes-v2.md
"
```

---

## Task 6: Push branch + open PR to staging (`feature/modular-backend`)

**Files:** N/A (git operations)

**Step 1: Confirm we are using Magicalprince GitHub account**

```bash
gh auth switch --hostname github.com --user Magicalprince
```
Expected: "Switched active account ... to Magicalprince"

**Step 2: Push branch**

```bash
git push -u origin fix/horizon1-production-fixes-v2
```

**Step 3: Open PR**

```bash
gh pr create --base feature/modular-backend --head fix/horizon1-production-fixes-v2 --title "fix(horizon1-v2): Bug A dedup + Bug C idempotency + Bug B observability + reaper + cleanup" --body "$(cat <<'EOF'
## Summary

Horizon 1 production fixes v2 — post-review revisions to v1 plan.

Per `docs/plans/2026-05-16-horizon1-fixes-v2.md`. Backend-only, no Flutter rebuild.

## What's included

| # | Task | Files | Risk |
|---|---|---|---|
| 1 | Bug C: billingSource idempotency | backgroundJobs.js | Lowest |
| 2 | Bug A: server-side INITIATE_CALL dedup (the REAL root cause) | call.handler.js | Low |
| 3 | Bug B observability: BILLING_WRITE log line | callBillingUtil.js | Lowest |
| 4a | Composite index for calls(status, createdAt) | firestore.indexes.json (deployed via firebase CLI) | Low |
| 4 | Stale-call reaper (OBSERVABILITY-ONLY mode) | backgroundJobs.js | Low |
| 5 | Cleanup script v2 (auto-detect owed, safety guards) | scripts/cleanup_stale_calls_2026-05-16.cjs | Medium (data) |

`npm audit fix` is INTENTIONALLY EXCLUDED — moved to its own cycle per reviewer R7 (Socket.IO version bumps risk breaking Flutter client handshake).

## v2 changes vs v1 (driven by code-reviewer critique)

- Bug A fix retargeted: was FCM-timeout block, now server-side dedup (log forensics proved different root cause)
- Bug C idempotency now uses billingSource (correct dimension), not just status
- Cleanup script auto-detects owed earnings instead of hardcoding (found 2 owed, not 1)
- Cleanup script has 1-hour age cutoff (won't touch in-flight)
- Cleanup script aborts if >10 owed detected (safety against active bug)
- Reaper deployment now requires composite index — Task 4a added as prerequisite

## Deployment plan (user funnel)

1. Merge this PR → CI deploys to staging (port 3002)
2. Verify staging logs + run cleanup script in DRY RUN on staging
3. **USER REVIEW dry-run output → explicit approval to --execute**
4. Run cleanup with --execute (writes to prod Firestore — staging and prod share)
5. **USER REVIEW + activeCalls=0 check → explicit approval to merge to main**
6. Merge to main → production CI deploy
7. 30-min post-deploy monitoring

## Refs
- docs/plans/2026-05-16-horizon1-fixes-v2.md
- PRODUCTION_MAINTENANCE_INSIGHTS_2026-05-16.md
- FIRESTORE_AUDIT_FINDINGS_2026-05-16.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR URL printed.

**Step 4: STOP — wait for user approval before merging to staging branch.**

---

## Task 7: Verify staging deploy

(Same pattern as plan v1 Task 8 — gh run watch, health check, confirm deployed commit, confirm reaper registered.)

---

## Task 8: Cleanup script — DRY RUN on staging

```bash
ssh -i ~/.ssh/id_ed25519 root@147.79.66.3 "cd /var/www/tingatalk-new && node scripts/cleanup_stale_calls_2026-05-16.cjs"
```
Expected: DRY RUN output with auto-detected counts. **STOP — user reviews dry-run output.**

---

## Task 9: Cleanup script — EXECUTE (only after user explicit go)

> ⚠️ **PERMANENT WRITE WARNING — read before executing**
>
> Tier 3 of this cleanup uses `FieldValue.increment` to credit female_earnings (~₹4.44 across ~2 women at the time of writing, but auto-detect may find more or fewer at execute time).
>
> **Once executed, these credits are NOT cleanly reversible.** The script does not log the increment amounts in a structure that supports a clean reverse-script. A bad execution would require Firestore admin tooling to manually subtract the wrong amounts.
>
> **DO NOT EXECUTE without:**
> 1. Explicit user confirmation of the dry-run output from Task 8
> 2. Confirmation that the auto-detected owed-count is reasonable (Task 8 will print it; if it's >10 the script will safety-abort anyway)
> 3. Confirmation of which specific female users will be credited and for what amounts
>
> Total credit amount is small (~₹4.44), so even a worst-case mistake is bounded. But the principle of "never write money without explicit confirmation" applies.

```bash
ssh -i ~/.ssh/id_ed25519 root@147.79.66.3 "cd /var/www/tingatalk-new && node scripts/cleanup_stale_calls_2026-05-16.cjs --execute"
```

---

## Task 10: Verify cleanup completed via audit script

```bash
ssh -i ~/.ssh/id_ed25519 root@147.79.66.3 "cd /var/www/tingatalk-backend && node audit_stale_calls.cjs" | head -15
```
Expected: stale-call count near 0.

Verify the credited females received their money:
```bash
ssh -i ~/.ssh/id_ed25519 root@147.79.66.3 "cd /var/www/tingatalk-backend && node recheck_owed.cjs" | head -20
```
Expected: "Calls MISSING female earnings transaction: 0".

---

## Task 11: Production deploy (requires explicit user approval + activeCalls=0)

(Same pattern as plan v1 Task 10 — wait for activeCalls=0, get user approval, merge to main, watch CI, verify.)

---

## Task 12: Post-deploy monitoring

(Same pattern as plan v1 Task 11 — watch for BILLING_WRITE appearing, DUPLICATE BLOCKED reducing, reaper firing cleanly.)

---

## Rollback plan

**Code (Tasks 1-4):** `git revert <merge-commit-sha>` on main + push.

**Firestore index (Task 4a):** Indexes are additive — leaving them in place is fine. Delete only via Firebase console if needed.

**Firestore cleanup (Tasks 5+8+9):**
- Status mutations are reversible: script wrote `previousStatus` field on every mutated doc. Reverse with:
  ```js
  // Pseudo-script
  for (const callId of mutatedIds) {
    const doc = await db.collection('calls').doc(callId).get();
    if (doc.exists && doc.data().endReason === 'admin_cleanup_2026-05-16') {
      await doc.ref.update({ status: doc.data().previousStatus, /* unset endReason etc. */ });
    }
  }
  ```
- Owed-earnings credits are NOT easily reversible (FieldValue.increment writes). Total owed is small (₹4.44 across 2 women), so if a mistake is made the cost of leaving it is trivial.

---

## Summary checklist for the funnel

- [ ] Task 0: Branch v2 created
- [ ] Task 1: Bug C billingSource idempotency
- [ ] Task 2: Bug A INITIATE_CALL dedup
- [ ] Task 3: Bug B BILLING_WRITE observability
- [ ] Task 4a: Composite index deployed
- [ ] Task 4: Reaper (observability-only)
- [ ] Task 5: Cleanup script v2 created
- [ ] Task 6: PR opened — **USER APPROVE merge to staging**
- [ ] Task 7: Staging deploy verified
- [ ] Task 8: Cleanup DRY RUN — **USER REVIEW**
- [ ] Task 9: Cleanup EXECUTE — **USER APPROVE**
- [ ] Task 10: Cleanup verified via audit
- [ ] Task 11: Prod deploy — **USER APPROVE + activeCalls=0**
- [ ] Task 12: 30-min monitoring + outcome doc update
