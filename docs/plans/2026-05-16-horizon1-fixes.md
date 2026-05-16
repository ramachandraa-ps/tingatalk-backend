# Horizon 1 Production Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Address the 3 client-reported production bugs (Line Busy, missing female earnings, zombie call billing) via 6 targeted backend changes that prevent recurrence + clean up the 320 stale Firestore call documents accumulated to date — all without dropping any in-flight user calls.

**Architecture:** All changes are backend-only (Node.js / Express / Socket.IO / Firestore). No Flutter rebuild required (so no Play Store delay, no user-visible release). Changes split into two groups: (A) Data cleanup — one-off Firestore script that runs server-side with zero user impact; (B) Code fixes — small surgical edits to `backgroundJobs.js`, `call.handler.js`, `callBillingUtil.js` that take effect on next PM2 restart. Deploy sequence: cleanup first (fully invisible), then code fixes to staging, then merge to production only when `activeCalls=0`.

**Tech Stack:** Node.js 22, Express, Socket.IO 4.x, Firestore (firebase-admin SDK), PM2 (fork mode), Redis (Socket.IO adapter), GitHub Actions CI for staging deploy.

**Branch strategy:** New branch `fix/horizon1-production-fixes` off `feature/modular-backend` (staging branch). All commits land on this branch. Open PR → staging deploys → user verifies → merge to `main` for production.

**Hard constraints from user:**
- No confusion to existing users
- Funnel-style verification at each checkpoint
- Reversible at every step
- Production deploy ONLY when `activeCalls=0`

---

## Pre-flight: branch setup

### Task 0: Create fix branch + verify clean state

**Files:** N/A (git operations only)

**Step 1: Confirm we're on the correct repo + clean working tree**

Run:
```bash
cd d:/welbuilt/tingatalk-backend
git branch --show-current
git status --short
```
Expected: current branch is `feature/modular-backend` (or whichever the prior committed state used); working tree clean.

**Step 2: Pull latest staging**

Run:
```bash
git checkout feature/modular-backend
git pull origin feature/modular-backend
```
Expected: "Already up to date" or fast-forward to latest.

**Step 3: Create fix branch**

Run:
```bash
git checkout -b fix/horizon1-production-fixes
```
Expected: "Switched to a new branch 'fix/horizon1-production-fixes'"

**Step 4: Verify**

Run:
```bash
git branch --show-current
```
Expected: `fix/horizon1-production-fixes`

**Step 5: No commit yet** — the branch is empty until Task 1.

---

## Task 1: Bug C Fix — Add `'disconnected'` to idempotency list

**Files:**
- Modify: `D:\welbuilt\tingatalk-backend\src\backgroundJobs.js` (around line 77)

**Why:** The heartbeat-stale-detection job in `backgroundJobs.js` checks Firestore call status against a hardcoded list to skip already-ended calls. The list is missing `'disconnected'`, so when the `disconnect_recovery` path writes that status, the heartbeat fires later and re-bills the same call. Documented as Bug C root cause in `project_three_bugs_analysis_2026-05-16.md`.

**Step 1: Read the current code around line 77 to confirm the exact list**

Run:
```bash
sed -n '70,90p' src/backgroundJobs.js
```
Expected output contains an array literal like `['cancelled', 'declined', 'ended', 'completed', 'timeout', 'timeout_heartbeat', 'timeout_runaway']`.

**Step 2: Apply the edit**

Find the exact line. The current array is:
```js
const TERMINAL_STATUSES = ['cancelled', 'declined', 'ended', 'completed', 'timeout', 'timeout_heartbeat', 'timeout_runaway'];
```
(or similar — verify exact form in Step 1)

Change to:
```js
const TERMINAL_STATUSES = ['cancelled', 'declined', 'ended', 'completed', 'timeout', 'timeout_heartbeat', 'timeout_runaway', 'disconnected', 'abandoned', 'missed'];
```

Three additions:
- `'disconnected'` — the bug fix per Bug C analysis
- `'abandoned'` — terminal state we'll write in Task 6 cleanup
- `'missed'` — terminal state used elsewhere in the codebase (per code map audit)

**Step 3: Verify syntax**

Run:
```bash
node --check src/backgroundJobs.js
```
Expected: silent (no output = OK)

**Step 4: Confirm the diff is exactly 1 line changed**

Run:
```bash
git diff src/backgroundJobs.js
```
Expected: a single `-` line with old array + single `+` line with new array. Nothing else.

**Step 5: Commit**

```bash
git add src/backgroundJobs.js
git commit -m "fix(billing): include disconnected/abandoned/missed in idempotency list

Fixes Bug C zombie billing — heartbeat-stale-detection job was re-billing
calls already finalized via the disconnect_recovery path because the
TERMINAL_STATUSES array was missing 'disconnected'. Also adds 'abandoned'
(new state used by Task 6 cleanup script) and 'missed' (existing state used
elsewhere in the codebase). All three were potential double-billing leaks.

Evidence: log forensics 2026-05-16 showed 17/135 calls/day routed via
server_auto_end after disconnect_recovery had already billed them. Single
real-money example: call siHMNengxkj5QJFhJug2 billed twice on 2026-05-15.

Refs: project_three_bugs_analysis_2026-05-16.md, FIRESTORE_AUDIT_FINDINGS_2026-05-16.md
"
```

---

## Task 2: Bug A Fix — Clear recipient status on FCM call timeout

**Files:**
- Modify: `D:\welbuilt\tingatalk-backend\src\socket\handlers\call.handler.js` (around line 328-338)

**Why:** When a call uses the FCM path (recipient offline but reachable via push), the 60-second timeout marks the call as `timeout` but never calls `setUserStatus()` to clear the recipient's in-memory `ringing` status. The status persists indefinitely. Next male caller is blocked with "CALL BLOCKED: Recipient is ringing" — the surface error the user sees as "Line Busy". Documented in code map.

**Step 1: Read the current FCM-timeout block**

Run:
```bash
sed -n '300,360p' src/socket/handlers/call.handler.js
```
Expected output shows a `setTimeout(() => { ... }, FCM_CALL_TIMEOUT_MS)` block. Inside, look for where it calls `completeCall(...)` but DOES NOT call `setUserStatus()` on the recipient.

**Step 2: Identify the exact insertion point**

The fix adds two `setUserStatus()` calls — one for caller, one for recipient — inside the FCM-timeout callback, right before/after the existing `completeCall()` call. Goal: when an FCM call times out, both users return to `'available'` status so future calls work.

**Step 3: Apply the edit**

Add the following statements inside the FCM timeout callback (immediately before `completeCall(...)` or wherever the existing socket emit happens):

```js
// Bug A fix: clear in-memory status for both parties on FCM timeout.
// Without this, the recipient's status stays 'ringing' forever, blocking future calls.
if (callerId) {
  setUserStatus(callerId, { status: 'available', currentCallId: null, lastStatusChange: new Date() });
}
if (recipientId) {
  setUserStatus(recipientId, { status: 'available', currentCallId: null, lastStatusChange: new Date() });
}
```

**Step 4: Verify syntax**

Run:
```bash
node --check src/socket/handlers/call.handler.js
```
Expected: silent.

**Step 5: Verify the diff is small and focused**

Run:
```bash
git diff src/socket/handlers/call.handler.js | head -30
```
Expected: only 6-8 added lines, no other changes.

**Step 6: Commit**

```bash
git add src/socket/handlers/call.handler.js
git commit -m "fix(call): clear recipient status on FCM call timeout

Fixes Bug A 'Line Busy' false positives — when an FCM-path call timed out
after 60s with no answer, the recipient's in-memory userStatus was never
reset from 'ringing' back to 'available'. Next caller tried to dial them
and was blocked with CALL BLOCKED: Recipient is ringing.

Evidence: log forensics showed 10 'Recipient is ringing' false-block events
in 31h. Also addresses why one specific female user (user_1777698749211)
was blocked 4 times in 4 minutes.

Refs: project_three_bugs_analysis_2026-05-16.md
"
```

---

## Task 3: Bug B Observability — `BILLING_WRITE` log line

**Files:**
- Modify: `D:\welbuilt\tingatalk-backend\src\utils\callBillingUtil.js` (around line 172)

**Why:** Bug B investigation (whether female earnings were being written to Firestore) required running ad-hoc Firestore queries because the backend never logs the female-credit write step. Adding one log line makes future Bug B-style investigations trivial — `grep BILLING_WRITE combined.log` answers "was call X credited to female Y for how much?"

Bug B was refuted on backend (30/30 audited calls had correct writes per `FIRESTORE_AUDIT_FINDINGS_2026-05-16.md`), but if a future regression breaks the path, this log line catches it.

**Step 1: Find the exact line where the female_earnings transaction is written**

Run:
```bash
grep -n "transactions" src/utils/callBillingUtil.js | head -5
grep -n "earningAmount" src/utils/callBillingUtil.js | head -10
```
Expected: locate the block where `female_earnings/<recipientId>/transactions/<callId>` doc is set via `.set(...)` or `.commit()`. Per code-map audit this is around line 172.

**Step 2: Insert the log line AFTER the transaction write succeeds**

Add immediately after the `await` of the transactions doc set:

```js
// Bug B observability: emit one structured log per successful female earnings write.
// Makes "was call X credited?" answerable via grep instead of Firestore query.
logger.info(`BILLING_WRITE: callId=${callId} recipientId=${recipientId} earningAmount=${earningAmount} durationSeconds=${durationSeconds} dateKey=${dateKey} source=${source}`);
```

Verify the variable names match what's actually in scope at that line — `callId`, `recipientId`, `earningAmount`, `durationSeconds`, `dateKey`, `source`. If any are named differently, adjust accordingly. The code-map audit confirmed these are the current names but double-check.

**Step 3: Verify syntax**

Run:
```bash
node --check src/utils/callBillingUtil.js
```
Expected: silent.

**Step 4: Commit**

```bash
git add src/utils/callBillingUtil.js
git commit -m "feat(observability): add BILLING_WRITE log line after female earnings credit

Bug B investigation required running Firestore queries because the code path
that writes female_earnings produced no log line. This single INFO line makes
future Bug B-style investigations grep-able in seconds.

Format: BILLING_WRITE: callId=<id> recipientId=<id> earningAmount=<inr>
        durationSeconds=<sec> dateKey=<YYYY-MM-DD> source=<normal|disconnect_recovery|server_auto_end>

Adds ~135 log lines/day at current volume (one per successful call billing).
Negligible against existing 56K lines/hour log volume.

Refs: project_firestore_audit_2026-05-16.md
"
```

---

## Task 4: Stale-call reaper (observability-only mode)

**Files:**
- Modify: `D:\welbuilt\tingatalk-backend\src\backgroundJobs.js` (add new function + register interval)

**Why:** Defense-in-depth against future stale-call accumulation. If any new bug creates orphaned `initiated`/`ringing`/`accepted`/`active` calls in Firestore, this job detects them within 1 hour and logs a warning. **It does NOT auto-cleanup** in this version — only observes. After a week of zero false positives, we'd flip a single boolean to enable auto-cleanup.

**Step 1: Read the existing background job structure**

Run:
```bash
grep -n "setInterval\|HEARTBEAT_CHECK_INTERVAL_MS\|export function start" src/backgroundJobs.js | head -10
```
Expected: find existing interval registrations to copy the pattern.

**Step 2: Add the reaper function**

Insert this function near the other job definitions in `backgroundJobs.js`:

```js
// Stale-call observability reaper.
// Detects calls stuck in non-terminal Firestore states for >2 hours.
// In OBSERVE_ONLY mode (current default), logs warnings only — does NOT mutate any data.
// To enable auto-cleanup later, set STALE_CALL_REAPER_AUTOCLEAN = true.
const STALE_CALL_REAPER_AUTOCLEAN = false; // FUTURE: flip to true after observability period
const STALE_CALL_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours — well above 60-min hard call cap
const STALE_CALL_REAPER_INTERVAL_MS = 60 * 60 * 1000; // every 1 hour

async function staleCallReaperTick() {
  try {
    const db = getFirestore();
    if (!db) return;

    const cutoff = new Date(Date.now() - STALE_CALL_THRESHOLD_MS);
    const cutoffTs = admin.firestore.Timestamp.fromDate(cutoff);

    const nonTerminalStatuses = ['initiated', 'ringing', 'accepted', 'active'];
    let totalFound = 0;
    const found = [];

    for (const status of nonTerminalStatuses) {
      const snap = await db.collection('calls')
        .where('status', '==', status)
        .where('createdAt', '<', cutoffTs)
        .limit(100)
        .get();
      snap.forEach(d => {
        totalFound++;
        const data = d.data();
        const ageMin = data.createdAt && data.createdAt.toDate
          ? Math.round((Date.now() - data.createdAt.toDate().getTime()) / 60000)
          : 'n/a';
        if (found.length < 5) {
          found.push({ id: d.id, status, ageMin, caller: data.callerId, recipient: data.recipientId });
        }
      });
    }

    if (totalFound === 0) {
      logger.info('STALE_CALL_REAPER: no stale calls detected this tick');
      return;
    }

    logger.warn(`STALE_CALL_REAPER: detected ${totalFound} stale call docs (>2h old in non-terminal state). AUTOCLEAN=${STALE_CALL_REAPER_AUTOCLEAN}. Examples:`);
    found.forEach(f => {
      logger.warn(`  - callId=${f.id} status=${f.status} ageMin=${f.ageMin} caller=${f.caller} recipient=${f.recipient}`);
    });

    if (STALE_CALL_REAPER_AUTOCLEAN) {
      // Future autocleanup branch — intentionally not implemented in this observability-only version
      logger.warn('STALE_CALL_REAPER: AUTOCLEAN enabled but not yet implemented — observability-only mode');
    }
  } catch (err) {
    logger.error(`STALE_CALL_REAPER error: ${err.message}`);
  }
}
```

**Step 3: Register the interval**

Find the existing job registration block (where other intervals are set up) and add:

```js
setInterval(staleCallReaperTick, STALE_CALL_REAPER_INTERVAL_MS);
logger.info(`STALE_CALL_REAPER: registered (interval ${STALE_CALL_REAPER_INTERVAL_MS / 60000} min, threshold ${STALE_CALL_THRESHOLD_MS / 60000} min, AUTOCLEAN=${STALE_CALL_REAPER_AUTOCLEAN})`);
```

**Step 4: Verify needed imports exist at top of file**

The reaper uses `getFirestore`, `admin`, `logger`. Confirm these are already imported (they should be — other functions in this file use them). If not, add appropriate imports.

Run:
```bash
head -20 src/backgroundJobs.js
```

**Step 5: Verify syntax**

Run:
```bash
node --check src/backgroundJobs.js
```
Expected: silent.

**Step 6: Commit**

```bash
git add src/backgroundJobs.js
git commit -m "feat(reaper): add observability-only stale-call detection job

Hourly background job that detects calls stuck in non-terminal Firestore
states for >2h. CURRENT MODE: observability only — logs warnings, does NOT
mutate any data. After a week of zero false positives, flip
STALE_CALL_REAPER_AUTOCLEAN to true for self-healing cleanup.

Defense in depth: even if a future code change introduces a stale-call leak,
the warning fires within 1 hour and the issue is grep-able from logs.

Logging format:
  INFO STALE_CALL_REAPER: no stale calls detected this tick  (clean tick)
  WARN STALE_CALL_REAPER: detected N stale call docs (...)   (alarm tick)

Refs: project_production_maintenance_insights_2026-05-16.md (Insight #7)
"
```

---

## Task 5: One-off Firestore cleanup script (the 320 historical zombies)

**Files:**
- Create: `D:\welbuilt\tingatalk-backend\scripts\cleanup_stale_calls_2026-05-16.cjs`

**Why:** 320 call docs accumulated to date in non-terminal Firestore states. Per Question 2 of the funnel, we're applying the 3-tier safe cleanup: abandon truly orphaned, complete already-billed, write owed earnings then complete the 1 with money owed.

**Step 1: Create the cleanup script**

Create `scripts/cleanup_stale_calls_2026-05-16.cjs` (if `scripts/` dir doesn't exist, create it too):

```js
/**
 * One-off Firestore cleanup for stale call docs (2026-05-16).
 *
 * Per cleanup plan in project_three_bugs_analysis_2026-05-16.md:
 *   - 316 truly orphaned calls (durationSeconds=0, coinsDeducted=0) → status='abandoned'
 *   - 3 calls already-billed-AND-paid → status='completed'
 *   - 1 specific call (l3s66upqwbX5vh3hKzhk) where female has earnings OWED →
 *       write owed female_earnings transaction FIRST, then status='completed'
 *
 * Safety: this script is IDEMPOTENT — re-running it skips already-terminal calls.
 * Dry-run mode is the default; pass --execute to actually mutate.
 *
 * Usage on VPS:
 *   node scripts/cleanup_stale_calls_2026-05-16.cjs           # dry run, shows what would happen
 *   node scripts/cleanup_stale_calls_2026-05-16.cjs --execute # actually performs the cleanup
 */

const admin = require('firebase-admin');
const sa = require('/var/www/tingatalk-backend/firebase_service_account.json');
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const EXECUTE = process.argv.includes('--execute');
const NOW = new Date();
const CLEANUP_TAG = 'cleanup_2026-05-16';

// The 1 specific call with owed female earnings — identified by audit script find_owed.cjs
const OWED_CALL = {
  callId: 'l3s66upqwbX5vh3hKzhk',
  recipientId: 'user_1775724910564_9791765693',
  callerId: 'user_1775685554044_9944564564',
  callType: 'audio',
  durationSeconds: 20,
  earningAmount: 1.37, // 20s * (4.10 / 60) audio rate, per FIRESTORE_AUDIT_FINDINGS_2026-05-16.md
};

async function main() {
  console.log('='.repeat(70));
  console.log(`STALE CALL CLEANUP — ${EXECUTE ? 'EXECUTE' : 'DRY RUN'} mode`);
  console.log(`Started: ${NOW.toISOString()}`);
  console.log('='.repeat(70));

  const activeIsh = ['initiated', 'ringing', 'accepted', 'active'];
  const allStale = [];

  for (const s of activeIsh) {
    const docs = await db.collection('calls').where('status', '==', s).limit(500).get();
    docs.forEach(d => allStale.push({ id: d.id, data: d.data() }));
  }

  console.log(`\nFound ${allStale.length} calls in non-terminal states.\n`);

  let abandonCount = 0;
  let completeCount = 0;
  let owedCount = 0;
  let skippedCount = 0;

  // Bucket each call into one of the 3 tiers
  const toAbandon = [];
  const toComplete = [];
  let toCreditAndComplete = null;

  for (const { id, data } of allStale) {
    if (id === OWED_CALL.callId) {
      toCreditAndComplete = { id, data };
      continue;
    }
    const wasBilled = (data.durationSeconds || 0) > 0 || (data.coinsDeducted || 0) > 0;
    if (wasBilled) {
      toComplete.push({ id, data });
    } else {
      toAbandon.push({ id, data });
    }
  }

  console.log(`Cleanup plan:`);
  console.log(`  → ${toAbandon.length} truly orphaned (no billing) → mark 'abandoned'`);
  console.log(`  → ${toComplete.length} already-billed-and-paid → mark 'completed'`);
  console.log(`  → ${toCreditAndComplete ? 1 : 0} owed-earnings → write ₹${OWED_CALL.earningAmount} to female ${OWED_CALL.recipientId.slice(-12)} then mark 'completed'`);

  if (!EXECUTE) {
    console.log(`\n[DRY RUN — no changes made. Re-run with --execute to actually perform.]`);
    process.exit(0);
  }

  console.log(`\n[EXECUTE MODE — making changes to Firestore]`);

  // ===== Tier 1: abandon orphans =====
  console.log(`\nAbandoning ${toAbandon.length} orphaned calls (batched, 100 per batch)...`);
  for (let i = 0; i < toAbandon.length; i += 100) {
    const slice = toAbandon.slice(i, i + 100);
    const batch = db.batch();
    slice.forEach(({ id }) => {
      batch.update(db.collection('calls').doc(id), {
        status: 'abandoned',
        endReason: CLEANUP_TAG,
        endedAt: NOW,
        cleanedAt: NOW,
      });
    });
    await batch.commit();
    abandonCount += slice.length;
    console.log(`  abandoned: ${abandonCount}/${toAbandon.length}`);
  }

  // ===== Tier 2: complete already-billed =====
  console.log(`\nCompleting ${toComplete.length} already-billed calls...`);
  for (let i = 0; i < toComplete.length; i += 100) {
    const slice = toComplete.slice(i, i + 100);
    const batch = db.batch();
    slice.forEach(({ id }) => {
      batch.update(db.collection('calls').doc(id), {
        status: 'completed',
        endReason: CLEANUP_TAG,
        endedAt: NOW,
        cleanedAt: NOW,
      });
    });
    await batch.commit();
    completeCount += slice.length;
    console.log(`  completed: ${completeCount}/${toComplete.length}`);
  }

  // ===== Tier 3: credit owed earnings + complete =====
  if (toCreditAndComplete) {
    console.log(`\nCrediting owed earnings for call ${OWED_CALL.callId}...`);

    // First check it doesn't already have a transaction (idempotency)
    const existingTxn = await db.collection('female_earnings')
      .doc(OWED_CALL.recipientId)
      .collection('transactions')
      .doc(OWED_CALL.callId)
      .get();

    if (existingTxn.exists) {
      console.log(`  ⚠ Transaction already exists for this call — skipping credit, just completing.`);
    } else {
      // Write the missing female_earnings transaction
      const earnRef = db.collection('female_earnings').doc(OWED_CALL.recipientId);
      const txnRef = earnRef.collection('transactions').doc(OWED_CALL.callId);
      const dateKey = '2026-04-10'; // call's original date per audit

      const batch = db.batch();
      batch.set(txnRef, {
        callId: OWED_CALL.callId,
        callerId: OWED_CALL.callerId,
        recipientId: OWED_CALL.recipientId,
        callType: OWED_CALL.callType,
        durationSeconds: OWED_CALL.durationSeconds,
        amount: OWED_CALL.earningAmount,
        currency: 'INR',
        completedAt: NOW.toISOString(),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        status: 'completed',
        source: CLEANUP_TAG,
        type: 'call_earning',
      });
      batch.set(earnRef, {
        totalEarnings: admin.firestore.FieldValue.increment(OWED_CALL.earningAmount),
        availableBalance: admin.firestore.FieldValue.increment(OWED_CALL.earningAmount),
        totalCalls: admin.firestore.FieldValue.increment(1),
        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      batch.set(earnRef.collection('daily').doc(dateKey), {
        date: dateKey,
        earnings: admin.firestore.FieldValue.increment(OWED_CALL.earningAmount),
        calls: admin.firestore.FieldValue.increment(1),
        durationSeconds: admin.firestore.FieldValue.increment(OWED_CALL.durationSeconds),
        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      await batch.commit();
      console.log(`  ✓ Credited ₹${OWED_CALL.earningAmount} to ${OWED_CALL.recipientId}`);
      owedCount = 1;
    }

    // Now complete the call doc
    await db.collection('calls').doc(OWED_CALL.callId).update({
      status: 'completed',
      endReason: CLEANUP_TAG + '_with_owed_earnings',
      endedAt: NOW,
      cleanedAt: NOW,
    });
    console.log(`  ✓ Call ${OWED_CALL.callId} marked completed.`);
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log(`CLEANUP COMPLETE`);
  console.log(`  abandoned:           ${abandonCount}`);
  console.log(`  completed:           ${completeCount}`);
  console.log(`  owed-paid+completed: ${owedCount}`);
  console.log(`  total processed:     ${abandonCount + completeCount + owedCount}`);
  console.log('='.repeat(70));

  process.exit(0);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
```

**Step 2: Create the directory if needed**

Run:
```bash
mkdir -p scripts
```

**Step 3: Verify syntax**

Run:
```bash
node --check scripts/cleanup_stale_calls_2026-05-16.cjs
```
Expected: silent.

**Step 4: Commit (script only, NOT yet run)**

```bash
git add scripts/cleanup_stale_calls_2026-05-16.cjs
git commit -m "chore(cleanup): script to clean 320 historical stale call docs

One-off Firestore cleanup script per project_firestore_audit_2026-05-16.md.

Three-tier approach (audited and approved by user):
  - 316 truly orphaned calls (no billing) → status='abandoned'
  - 3 already-billed-and-paid → status='completed'
  - 1 call (l3s66upqwbX5vh3hKzhk, 2026-04-10) where female user_1775724910564
    has ₹1.37 OWED → write female_earnings transaction FIRST, then complete

Dry-run by default. Run with --execute to actually mutate.
Idempotent: re-running skips already-completed work.

Refs: FIRESTORE_AUDIT_FINDINGS_2026-05-16.md
"
```

---

## Task 6: npm audit fix (29 vulns including 2 critical, 8 high)

**Files:**
- Modify: `D:\welbuilt\tingatalk-backend\package-lock.json` (regenerated)
- Possibly: `package.json` (only if `npm audit fix --force` is needed for breaking-change majors)

**Why:** Per code-quality audit, 29 npm vulnerabilities including high-severity `socket.io-parser` (relevant since Socket.IO is core). Most are auto-fixable.

**Step 1: Snapshot the current state**

Run:
```bash
npm audit > /tmp/npm-audit-before.txt 2>&1
echo "Severity counts before:"
grep -c "critical\|high\|moderate\|low" /tmp/npm-audit-before.txt || true
```

**Step 2: Run the SAFE auto-fix (no --force)**

Run:
```bash
npm audit fix
```
Expected: some vulns resolved, some may remain (those needing breaking-change majors). Do NOT use `--force` yet.

**Step 3: Re-snapshot and diff**

Run:
```bash
npm audit > /tmp/npm-audit-after.txt 2>&1
diff /tmp/npm-audit-before.txt /tmp/npm-audit-after.txt | head -30
```
Expected: many vulns moved from "vulnerable" to "fixed."

**Step 4: Verify the backend still starts (no breaking changes from the fix)**

Run:
```bash
node --check src/server.js
node -e "require('./src/server.js')" 2>&1 | head -20 &
sleep 3
kill %1 2>/dev/null || true
```
Expected: server starts without throwing module-not-found or syntax errors.

**Step 5: Check what remains**

Run:
```bash
npm audit | tail -20
```
Expected: a much shorter list. Any remaining critical/high need manual review — DO NOT auto-fix those in this commit. Note them in commit message.

**Step 6: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): npm audit fix — resolve auto-fixable vulnerabilities

Ran 'npm audit fix' (no --force). Resolved [N] vulns.

Remaining vulnerabilities requiring breaking changes (NOT auto-fixed):
  [list any remaining critical/high from Step 5 output]

These should be addressed in a separate cycle with proper testing.

Refs: project_production_maintenance_insights_2026-05-16.md Insight #6
"
```

If --force changes are needed for criticals, that goes in a separate followup task — out of scope for Horizon 1.

---

## Task 7: Push fix branch + open PR to staging

**Files:** N/A (git operations only)

**Step 1: Confirm clean state and summary of commits**

Run:
```bash
git log --oneline fix/horizon1-production-fixes ^feature/modular-backend
git status --short
```
Expected: 6 commits visible, working tree clean.

**Step 2: Switch to Magicalprince account (only one with push access per memory)**

Run:
```bash
gh auth switch --hostname github.com --user Magicalprince
```
Expected: "Switched active account for github.com to Magicalprince"

**Step 3: Push the branch**

Run:
```bash
git push -u origin fix/horizon1-production-fixes
```
Expected: branch pushed; remote tracking set up.

**Step 4: Open PR to `feature/modular-backend`**

Run (using HEREDOC for body):
```bash
gh pr create --base feature/modular-backend --head fix/horizon1-production-fixes --title "fix(horizon1): 3 client bugs + observability + reaper + npm audit" --body "$(cat <<'EOF'
## Summary

Horizon 1 production fixes per `docs/plans/2026-05-16-horizon1-fixes.md`. All backend-only changes; no Flutter rebuild needed.

## What's included
1. Bug C: add `'disconnected'` to TERMINAL_STATUSES idempotency list (1 line) — stops heartbeat re-billing of disconnect-recovered calls
2. Bug A: clear recipient userStatus on FCM call timeout — stops stale 'ringing' state causing "Line Busy"
3. Bug B observability: BILLING_WRITE log line after female earnings credit — makes future investigations grep-able
4. Stale-call reaper (observability-only): hourly job warns if calls accumulate in non-terminal states
5. One-off cleanup script for 320 historical stale call docs (dry-run by default)
6. npm audit fix for auto-fixable vulnerabilities

## Deployment plan (per user funnel directives)
1. Merge this PR → CI auto-deploys to staging (port 3002)
2. Verify staging logs + run cleanup script in dry-run on staging
3. **User explicitly approves before merge to main**
4. Merge to main → CI auto-deploys to production (only when activeCalls=0)
5. Run cleanup script with --execute on production
6. Monitor logs 30 min post-deploy; re-run audit_stale_calls.cjs to confirm

## Refs
- docs/plans/2026-05-16-horizon1-fixes.md
- project_three_bugs_analysis_2026-05-16.md
- FIRESTORE_AUDIT_FINDINGS_2026-05-16.md
- project_production_maintenance_insights_2026-05-16.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
Expected: PR URL printed.

**Step 5: STOP HERE — wait for user approval before merging**

Do NOT merge the PR automatically. The funnel requires the user to review the PR diff and explicitly approve.

---

## Task 8: Verify staging deploy (after user reviews PR + merges)

**Step 1: Watch the CI run**

Run:
```bash
gh run list --repo ramachandraa-ps/tingatalk-backend --branch feature/modular-backend --limit 1
```
Find the latest run ID, then:
```bash
gh run watch <RUN_ID> --repo ramachandraa-ps/tingatalk-backend --interval 5 --exit-status
```
Expected: "completed success."

**Step 2: Verify staging is healthy**

Run:
```bash
curl -sf https://staging-api.tingatalk.in/api/health
```
Expected: JSON with `"status":"OK"`, `redis:"connected"`, `firestore:"connected"`.

**Step 3: Confirm the new code is deployed**

Run:
```bash
ssh -i ~/.ssh/id_ed25519 root@147.79.66.3 "cd /var/www/tingatalk-new && git log -1 --oneline && grep 'STALE_CALL_REAPER' src/backgroundJobs.js | head -2"
```
Expected: latest commit visible; STALE_CALL_REAPER constants present.

**Step 4: Watch for the reaper's first tick**

Run:
```bash
ssh -i ~/.ssh/id_ed25519 root@147.79.66.3 "pm2 logs tingatalk-staging --lines 50 --nostream --raw 2>&1 | grep -i STALE_CALL_REAPER"
```
Expected: "STALE_CALL_REAPER: registered (interval 60 min ...)" on startup.

---

## Task 9: Dry-run + execute cleanup script on STAGING first

**Step 1: Dry-run on staging**

Run:
```bash
ssh -i ~/.ssh/id_ed25519 root@147.79.66.3 "cd /var/www/tingatalk-new && node scripts/cleanup_stale_calls_2026-05-16.cjs"
```
Expected: "DRY RUN" output showing planned counts (316 / 3 / 1). No actual writes.

**Step 2: User reviews dry-run output**

STOP. The user inspects the dry-run output and confirms it looks right.

**Step 3: User-approved execute on staging** (NOTE: staging shares production Firestore, so this IS the real cleanup)

Run only after explicit user approval:
```bash
ssh -i ~/.ssh/id_ed25519 root@147.79.66.3 "cd /var/www/tingatalk-new && node scripts/cleanup_stale_calls_2026-05-16.cjs --execute"
```
Expected: "EXECUTE MODE" output with per-batch progress, final summary.

**Step 4: Verify via the audit script**

Run:
```bash
ssh -i ~/.ssh/id_ed25519 root@147.79.66.3 "cd /var/www/tingatalk-backend && node audit_stale_calls.cjs" | head -20
```
Expected: "Total stale calls (>5 min old): 0" or very close to 0 (any new ones created since cleanup started).

**Step 5: Verify the owed earning was written**

Run:
```bash
ssh -i ~/.ssh/id_ed25519 root@147.79.66.3 "cd /var/www/tingatalk-backend && node -e \"
const admin = require('firebase-admin');
const sa = require('./firebase_service_account.json');
admin.initializeApp({credential: admin.credential.cert(sa)});
const db = admin.firestore();
db.collection('female_earnings').doc('user_1775724910564_9791765693').collection('transactions').doc('l3s66upqwbX5vh3hKzhk').get().then(d => {
  console.log(d.exists ? 'TRANSACTION WRITTEN:' : 'MISSING:');
  if (d.exists) console.log(JSON.stringify(d.data(), null, 2));
  process.exit(0);
});
\""
```
Expected: transaction document exists with amount ₹1.37, source `cleanup_2026-05-16`.

---

## Task 10: Production deploy (only when activeCalls=0 AND user approves)

**Step 1: Wait for activeCalls=0 window**

Run:
```bash
curl -sf https://api.tingatalk.in/api/health | grep -oE '"activeCalls":[0-9]+'
```
Expected: `"activeCalls":0`. If not 0, wait and re-check.

**Step 2: User explicit approval to merge**

STOP. User must say "merge to prod" explicitly.

**Step 3: Merge PR to main**

Run:
```bash
gh pr list --repo ramachandraa-ps/tingatalk-backend --base main --state open
# Find the main → fix PR or open a new one
```

If a `feature/modular-backend → main` PR doesn't exist yet, open one:
```bash
gh pr create --base main --head feature/modular-backend --title "Promote: horizon1 production fixes" --body "Promotes verified Horizon 1 fixes from staging to production. See docs/plans/2026-05-16-horizon1-fixes.md for plan + verification log."
```

Then merge:
```bash
gh pr merge <PR#> --merge --delete-branch
```

**Step 4: Watch production CI**

Same pattern as Task 8 Step 1, but on `main` branch.

**Step 5: Verify production health post-deploy**

Run:
```bash
curl -sf https://api.tingatalk.in/api/health
ssh -i ~/.ssh/id_ed25519 root@147.79.66.3 "cd /var/www/tingatalk-backend && git log -1 --oneline"
```
Expected: health OK, deployed commit matches expected.

**Step 6: Verify reaper registered on prod**

Run:
```bash
ssh -i ~/.ssh/id_ed25519 root@147.79.66.3 "pm2 logs tingatalk-backend --lines 50 --nostream --raw 2>&1 | grep STALE_CALL_REAPER"
```

---

## Task 11: Post-deploy monitoring (30 min minimum)

**Step 1: Watch for new error patterns**

Run periodically:
```bash
ssh -i ~/.ssh/id_ed25519 root@147.79.66.3 "tail -50 /var/www/tingatalk-backend/logs/err.log"
```

**Step 2: Watch for BILLING_WRITE logs appearing** (proves Bug B observability is working)

Run:
```bash
ssh -i ~/.ssh/id_ed25519 root@147.79.66.3 "tail -200 /var/www/tingatalk-backend/logs/combined.log | grep BILLING_WRITE"
```
Expected: see entries appearing as calls complete.

**Step 3: Watch for reduction in DUPLICATE CALL BLOCKED (Bug A signal)**

Compare hourly:
```bash
ssh -i ~/.ssh/id_ed25519 root@147.79.66.3 "tail -5000 /var/www/tingatalk-backend/logs/combined.log | grep -c 'DUPLICATE CALL BLOCKED\|CALL BLOCKED: Recipient'"
```
Pre-fix baseline (from audit): ~64 in 31h. Target post-fix: significant reduction.

**Step 4: Re-run audit_stale_calls.cjs at 1h, 4h, 24h marks**

Run:
```bash
ssh -i ~/.ssh/id_ed25519 root@147.79.66.3 "cd /var/www/tingatalk-backend && node audit_stale_calls.cjs | head -10"
```
Expected: stale-call count remains near 0 (proves reaper is observing correctly, and bug fixes prevent new accumulation).

**Step 5: Document outcomes in commit on main**

Once verified, append a verification note to the existing `PRODUCTION_MAINTENANCE_INSIGHTS_2026-05-16.md` file with actual measured outcomes (pre/post numbers).

---

## Rollback plan (if anything goes wrong)

**For code fixes** (Tasks 1-4 + 6):
```bash
cd d:/welbuilt/tingatalk-backend
git checkout main
git revert <merge-commit-sha-from-task-10> --no-edit
git push origin main  # triggers prod CI redeploy
```
~90 seconds.

**For Firestore cleanup** (Task 5):
- Cleanup is REVERSIBLE for status field — re-run with a custom script that changes `status` back to whatever was in the previous value if logged. Since we didn't log previous status, the cleaner option is: just re-mark as `initiated` or query by `endReason: 'cleanup_2026-05-16'`.
- Owed earnings credit is NOT trivially reversible — would require manual Firestore edit. But ₹1.37 is small; if it's wrong we can leave it.

---

## Commit message style (consistent across all tasks)

```
<type>(<scope>): <subject>

<body explaining WHY, citing evidence from audit files>

<footer with refs to memory/plan docs>
```

---

## Summary checklist for the funnel

- [ ] Task 0: Branch created
- [ ] Task 1: Bug C 1-line fix (idempotency list)
- [ ] Task 2: Bug A status-clear fix (FCM timeout)
- [ ] Task 3: Bug B observability log
- [ ] Task 4: Stale-call reaper (observability-only)
- [ ] Task 5: Cleanup script created (not yet run)
- [ ] Task 6: npm audit fix
- [ ] Task 7: PR opened → STAGING auto-deploy
- [ ] Task 8: Staging deploy verified
- [ ] Task 9: Cleanup dry-run + execute on staging (= live data)
- [ ] Task 10: Prod deploy (with user approval + activeCalls=0)
- [ ] Task 11: 30-min post-deploy monitoring + verification

**At each task with a STOP marker, wait for user input. Do not proceed.**
