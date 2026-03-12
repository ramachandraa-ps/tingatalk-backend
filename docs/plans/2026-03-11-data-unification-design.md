# Data Unification Design — TingaTalk

**Date:** 2026-03-11
**Status:** Approved
**Approach:** Unified Data Layer (Approach B)

## Problem

Data inconsistencies across Firestore collections cause:
- Dual field names for the same concept (`coins`/`coinBalance`, `totalCalls`/`totalCallsReceived`)
- Duplicate writes (transactions written to 2 locations)
- Female earnings scattered across 3+ sources
- Mixed snake_case/camelCase field naming
- Redundant admin tracking collections

## Convention

- **Firestore + Backend:** camelCase everywhere
- **Flutter:** camelCase in Firestore, auto-convert to Dart naming at model boundary

## Canonical Field Schema

### `users` collection

| Conflicting Fields | Canonical Field | Action |
|---|---|---|
| `coins` / `coinBalance` | `coins` | Remove `coinBalance` |
| `totalCallsReceived` / `totalCalls` | `totalCalls` | Remove `totalCallsReceived` |
| `name` / `displayName` | `displayName` | Standardize |
| `photoUrl` / `fullPhotoUrl` / `profileImageUrl` | `photoUrl` + `fullPhotoUrl` | Remove `profileImageUrl` |

### `transactions` — Eliminate global collection

| Current | Target |
|---|---|
| `transactions/{id}` + `users/{uid}/transactions/{id}` | `users/{uid}/transactions/{id}` ONLY |

Admin queries use Firestore collection group queries on `transactions` subcollection.

### `female_earnings` — Single source for female data

| Source | Keep? |
|---|---|
| `female_earnings/{id}` (aggregate doc) | Keep — balance display |
| `female_earnings/{id}/daily/{date}` | Keep — daily breakdown |
| `female_earnings/{id}/transactions/{callId}` | Keep — per-call records |
| Legacy fields in `users/{id}` | Remove — no more earnings in user doc |
| `users/{id}/daily_stats/{date}` | Remove — redundant with `female_earnings/{id}/daily` |

### Admin collections — Remove redundant

| Collection | Action |
|---|---|
| `male_users_admin/{id}` | Remove — data exists in `users/{id}` |
| `female_users_admin/{id}` | Remove — data exists in `female_earnings/{id}` |

### Collections to keep unchanged

- `calls` — backend source of truth for call records
- `users/{id}/callLogs` — denormalized for per-user call history UI
- `users/{id}/inbox/calls/items` — fan-out for incoming call notifications
- `favorites` — male browse UI
- `female_payment_accounts` — Razorpay integration
- `payout_requests` — withdrawal tracking
- `female_earnings/{id}/powerups` — rating/like tracking
- `payment_verifications` — payment idempotency
- `admin_analytics` — admin stats
- `RevenueByDate` — admin revenue tracking
- `temp_users` — signup flow

## Backend Changes

### Shared schema constants
Create `src/shared/schema.js` defining canonical field names.

### By feature module:

**calls.routes.js:**
- Write only `coins` (remove `coinBalance`)
- Write only `totalCalls` (remove `totalCallsReceived`)
- Remove global `transactions/{id}` write
- Remove `male_users_admin/{id}` write

**payments.routes.js:**
- Remove global `transactions/{id}` write
- Remove `male_users_admin/{id}` write
- Only update `coins` field

**rewards.routes.js:**
- Remove global `transactions/{id}` write

**availability.routes.js:**
- Use `displayName` only

**stats feature:**
- Read `totalCalls` not `totalCallsReceived`

## Flutter Changes

### Conversion layer
- Every model: single `fromFirestore()` expecting camelCase
- Remove ALL dual-field fallback parsing
- Remove `_parseTransactionFromFirestore()` from male_transactions_screen.dart

### Service changes
- `ProductionCoinService`: read `coins` only
- `NewFemaleEarningsService`: read from `female_earnings/{id}` only, remove `users/{id}` fallback
- Remove `daily_stats` subcollection usage — use `female_earnings/{id}/daily`

### Remove dead references
- Remove reads/writes to `male_users_admin`, `female_users_admin`
- Remove global `transactions` collection reads

## Execution Order

1. Backend: Create shared schema constants
2. Backend: Standardize field names in all writes
3. Backend: Eliminate duplicate transaction writes
4. Backend: Remove admin collection writes
5. Flutter: Update models with clean camelCase `fromFirestore()`
6. Flutter: Update services to remove fallback logic
7. Flutter: Remove dead collection references
8. Verification: Test all flows end-to-end
