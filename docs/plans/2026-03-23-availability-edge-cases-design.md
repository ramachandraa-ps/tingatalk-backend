# Availability System Edge-Case Fixes — Design Document

**Date:** 2026-03-23
**Scope:** Fix 22 identified edge-case bugs in the female availability fetching, display, and real-time update system across Flutter frontend and Node.js backend.

---

## Problem Statement

The availability system has unpredictable behavior: female user cards disappear and don't reappear, show wrong status, or take too long to update on the male home screen. Root causes span WebSocket listener lifecycle, contradictory event handling, missing app-resume refresh, and data consistency gaps.

## Architecture Overview

```
Female App                    Backend (Node.js)                Male App
┌──────────┐                  ┌───────────────────┐            ┌──────────┐
│ Toggle ON │──HTTP POST──────▶│ update_availability│──broadcast─▶│ WS event │
│ Toggle OFF│                  │                   │            │ listener │
│ Background│──socket dies────▶│ Tier 1 (15s)      │──broadcast─▶│          │
│ Force-kill│──3 signals──────▶│ Tier 2 (30min)    │──broadcast─▶│          │
│           │                  │ forceSetUnavail.  │            │          │
└──────────┘                  │                   │            │ Polling  │
                               │ get_avail_females │◀──HTTP GET──│ (30s)    │
                               └───────────────────┘            └──────────┘
```

## Proposed Fixes — Grouped by Root Cause

### Fix Group A: Male App Resume (Edge Cases #1, #2, #3, #4, #24)

**Root Cause:** When male returns from background, no re-fetch of females and no re-registration of WebSocket listeners.

**Fix:**
1. Add `AppLifecycleState.resumed` handler in `male_home_screen.dart` `didChangeAppLifecycleState()`:
   - Call `_loadBrowseDates()` immediately to refresh the list
   - Check `WebSocketService.isConnected` — if disconnected, wait for reconnect then call `_setupDirectSocketListener()` again
   - Add a `WebSocketService.onReconnect` callback so listeners are re-registered automatically after any reconnect

2. In `WebSocketService`:
   - Add a `_reconnectCallbacks` list
   - After successful reconnect, invoke all registered callbacks
   - Expose `WebSocketService.onReconnect(callback)` and `WebSocketService.offReconnect(callback)`

3. In `_setupDirectSocketListener()`:
   - Guard against duplicate listeners by tracking registration state with a flag `_directListenersRegistered`
   - On reconnect, reset the flag and re-register

**Files:** `male_home_screen.dart`, `websocket_service.dart`

### Fix Group B: Contradictory Events (Edge Cases #12, #15)

**Root Cause:** When female disconnects, backend sends `user_disconnected` (immediate) which male handles as `isAvailable=false`. Then 15s later, Tier 1 sends `availability_changed(isAvailable=true, isOnline=false)`. These contradict.

**Fix:**
1. **Remove `user_disconnected` broadcast from `connection.handler.js` disconnect handler** (line 260). This event is redundant — the Tier 1 timeout already handles the state transition correctly.

2. **OR** change the `user_disconnected` handler in `male_home_screen.dart` (line 541-548) to NOT set `isAvailable: false`. Instead, treat it as an `isOnline` change only:
   ```dart
   _handleAvailabilityChange({
     'femaleUserId': disconnectedUserId,
     'isAvailable': true,  // preserve — Tier 1 will confirm
     'isOnline': false,
     'status': 'disconnected',
   });
   ```

**Recommended approach:** Option 2 (frontend-only change). Less risky, doesn't change backend event contract, and the Tier 1 event will confirm the correct state 15s later.

**Files:** `male_home_screen.dart` (option 2) or `connection.handler.js` (option 1)

### Fix Group C: Event Ordering & Deduplication (Edge Cases #13, #20, #21, #22)

**Root Cause:** No timestamps checked, no debouncing on `_loadBrowseDates()`, race between fade-out animation and incoming events.

**Fix:**
1. Add debouncing to `_loadBrowseDates()`:
   - Use a `Timer` with 500ms delay. If called again within 500ms, cancel previous timer and restart.
   - Prevents concurrent HTTP requests from polling + WebSocket + resume all firing at once.

2. Add timestamp-based deduplication to `_handleAvailabilityChange()`:
   - Track `_lastAvailabilityTimestamp` per femaleUserId (Map<String, String>)
   - If incoming event has older or equal timestamp, ignore it
   - Backend already includes `timestamp` in all events

3. Cancel fade-out if new `isAvailable=true` arrives:
   - In `_fadeOutAndRemoveUser()`, store the pending `Future.delayed` in a map `_fadeOutTimers`
   - In `_handleAvailabilityChange()`, if `isAvailable=true` for a user that's fading out, cancel the timer and remove from `_fadingOutUsers`

**Files:** `male_home_screen.dart`

### Fix Group D: Socket Listener Cleanup (Edge Case #23)

**Root Cause:** `WebSocketService.on()` registers listeners on Socket.IO instance but they're never removed on screen dispose.

**Fix:**
1. Track registered event names in a list `_registeredSocketEvents`
2. In `dispose()`, call `WebSocketService.off(eventName)` for each registered event
3. Add `WebSocketService.off(eventName, callback)` method that removes the listener from the socket instance

**Files:** `male_home_screen.dart`, `websocket_service.dart`

### Fix Group E: Force-Close Detection (Edge Cases #7, #8, #26)

**Root Cause:** Android doesn't reliably call `AppLifecycleState.detached` on swipe-kill. The 30-minute Tier 2 timeout is too long — female appears available but is unreachable.

**Fix:**
1. **Reduce Tier 2 timeout from 30 minutes to 5 minutes.** This is the simplest high-impact fix. 5 minutes is long enough for legitimate background use (switching apps, taking a phone call) but short enough to not leave ghost cards for 30 minutes.

2. **Add heartbeat-based availability check:** Backend already has heartbeat for calls. Extend it:
   - Female client sends periodic `availability_heartbeat` every 60s while toggle is ON
   - Backend tracks `lastAvailabilityHeartbeat` per user
   - `get_available_females` endpoint checks: if `isAvailable=true` but no socket AND `lastHeartbeat > 3 minutes ago`, exclude from results (even if FCM token exists)

3. **Improve `get_available_females` FCM token validation:**
   - Check `fcmTokenUpdatedAt` field — if token is older than 30 days, treat as stale
   - This prevents ghost entries from users who uninstalled

**Files:** `constants.js` (Tier 2 timeout), `connection.handler.js` (heartbeat), `availability.routes.js` (token validation), `female_home_screen.dart` or `app_lifecycle_service.dart` (heartbeat sender)

### Fix Group F: Server Restart Resilience (Edge Cases #16, #17)

**Root Cause:** In-memory state lost on server restart. Stale entries persist if socket dies without `disconnect` event.

**Fix:**
1. **On server startup**, run a Firestore query to find all users with `isOnline=true` and set them to `isOnline=false` (already have a cleanup script, needs to run automatically).

2. **Add periodic stale connection cleanup** (every 5 minutes):
   - Iterate `connectedUsers` map
   - For each entry, check if `io.sockets.sockets.get(socketId)` is still connected
   - If not, remove from map and trigger disconnect flow

**Files:** `server.js` (startup cleanup), `backgroundJobs.js` (periodic cleanup)

### Fix Group G: Performance — Broadcast Scope (Edge Case #14)

**Root Cause:** `io.emit()` sends to ALL connected sockets including females.

**Fix:**
1. Use Socket.IO rooms: on `join`, males join `room_male_browse`
2. Replace `io.emit('availability_changed', ...)` with `io.to('room_male_browse').emit('availability_changed', ...)`
3. Keep `user_status_changed` on `io.emit()` for now (both genders may need it)

**Files:** `connection.handler.js` (room join), `connectionManager.js` (broadcast target), `availability.routes.js` (broadcast target)

---

## Priority Order for Implementation

| Priority | Fix Group | Impact | Effort |
|----------|-----------|--------|--------|
| 1 | **A** — Male resume re-fetch + listener re-registration | Fixes the most user-visible issue | Medium |
| 2 | **B** — Fix contradictory `user_disconnected` event | Prevents false removal of available females | Low |
| 3 | **E** — Reduce Tier 2 to 5 min + heartbeat | Prevents 30-min ghost cards | Medium |
| 4 | **C** — Debounce + timestamp dedup + fade-out cancel | Prevents flickering and race conditions | Medium |
| 5 | **D** — Socket listener cleanup | Prevents memory leaks | Low |
| 6 | **F** — Server restart resilience | Prevents post-deploy issues | Low |
| 7 | **G** — Broadcast rooms | Performance optimization | Low |

## Testing Strategy

Each fix group should be tested with these scenarios:
1. Female online → male backgrounds → male resumes → female card visible?
2. Female online → female backgrounds → male sees card?
3. Female force-closes → male sees card disappear within 5 min?
4. Female toggles rapidly on/off → male list consistent?
5. Male loses network → regains → list refreshes?
6. Server restarts → male list recovers?
7. Two males online → both receive correct events?

## Success Criteria

- Female card appears within 3 seconds of male resuming from background
- Female card disappears within 5 minutes of force-close (down from 30 min)
- No contradictory state flicker (card appearing/disappearing/reappearing)
- No memory leaks from accumulated socket listeners
- No ghost cards from stale FCM tokens
