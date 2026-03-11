# Fix totalCalls Read Path for Browse Dates

**Date:** 2026-03-11
**Status:** Approved

## Problem

Female user cards on the male browse dates screen show "0 calls" despite having completed calls. The backend writes `totalCalls` to `female_earnings/{userId}` on call completion, but the `/api/get_available_females` endpoint reads from `users/{userId}` (via StatsSyncUtil), where `totalCalls` is never written.

## Solution: Approach A — Read from `female_earnings`

Change the `/api/get_available_females` endpoint to read `totalCalls` from `female_earnings/{userId}` instead of relying on StatsSyncUtil for that field.

### What changes

**File:** `src/features/availability/availability.routes.js`

In the per-female loop inside `GET /api/get_available_females`:
- After getting `rating` and `totalLikes` from StatsSyncUtil (works fine via PowerUps), fetch `female_earnings/{userId}` doc
- Extract `totalCalls` from that document (default 0 if doc doesn't exist)
- Override the StatsSyncUtil `totalCalls` value with the `female_earnings` value
- Use `Promise.all()` to batch-fetch all `female_earnings` docs concurrently

### What stays the same

- StatsSyncUtil unchanged — still handles `rating` and `totalLikes` from `users` collection
- PowerUpService unchanged — still writes likes/rating to both `users` and `female_earnings`
- No frontend changes — API response shape is identical
- No new writes — only the read path changes

### Edge cases

- **No calls yet:** `female_earnings/{userId}` doc doesn't exist → defaults to 0
- **Pre-backend calls:** Won't be counted (backend is source of truth)
- **Stale `totalCalls` on `users/{id}`:** Becomes orphaned, harmless — nothing reads it for display

### Data flow

```
BEFORE (broken):
  /api/get_available_females → StatsSyncUtil → users/{id}.totalCallsReceived → 0

AFTER (fixed):
  /api/get_available_females → female_earnings/{id}.totalCalls → actual count
  (rating + totalLikes still from StatsSyncUtil → users/{id} → correct)
```
