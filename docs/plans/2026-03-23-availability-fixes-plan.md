# Availability Edge-Case Fixes — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 22 edge-case bugs in the female availability system so cards appear/disappear reliably on the male home screen.

**Architecture:** Seven fix groups (A–G) ordered by impact. Each group is self-contained and independently testable. Frontend changes in Flutter (D:\welbuilt\TingaTalk), backend changes in Node.js (D:\welbuilt\tingatalk-backend).

**Tech Stack:** Flutter/Dart (Socket.IO client), Node.js/Express (Socket.IO server), Firebase Firestore, Redis.

---

### Task 1: Add reconnect callback system to WebSocketService

**Files:**
- Modify: `D:\welbuilt\TingaTalk\lib\services\websocket_service.dart`

**Step 1: Add reconnect callback list and registration methods**

After the existing static fields (around line 30), add:

```dart
static final List<VoidCallback> _reconnectCallbacks = [];

/// Register a callback to be invoked after WebSocket reconnects.
static void onReconnect(VoidCallback callback) {
  _reconnectCallbacks.add(callback);
}

/// Remove a reconnect callback.
static void removeReconnectCallback(VoidCallback callback) {
  _reconnectCallbacks.remove(callback);
}
```

**Step 2: Invoke callbacks after successful reconnect**

In `_attemptReconnect()` (line ~918), after `if (success) {` block, add:

```dart
// In the existing success block around line 918-919:
if (success) {
  if (kDebugMode) print('📡 ✅ Automatic reconnection successful');
  // Notify listeners that reconnection happened
  for (final cb in _reconnectCallbacks) {
    try { cb(); } catch (_) {}
  }
}
```

Also in `connect()` method — after a successful `forceReconnect` connect (around line 213-220), add the same callback invocation:

```dart
if (forceReconnect) {
  for (final cb in _reconnectCallbacks) {
    try { cb(); } catch (_) {}
  }
}
```

**Step 3: Clean up callbacks on dispose**

In the `disconnect()` method (line ~711), do NOT clear `_reconnectCallbacks` — they should persist across reconnects. Only clear them if the service is fully disposed.

**Step 4: Commit**

```bash
cd D:\welbuilt\TingaTalk
git add lib/services/websocket_service.dart
git commit -m "feat: add onReconnect callback system to WebSocketService"
```

---

### Task 2: Re-fetch females and re-register listeners on male app resume

**Files:**
- Modify: `D:\welbuilt\TingaTalk\lib\screens\male\male_home_screen.dart`

**Step 1: Update `didChangeAppLifecycleState` to refresh on resume**

Replace the existing `didChangeAppLifecycleState` method (line ~687):

```dart
@override
void didChangeAppLifecycleState(AppLifecycleState state) {
  super.didChangeAppLifecycleState(state);

  if (state == AppLifecycleState.resumed) {
    if (kDebugMode) print('📱 App resumed — refreshing available females');

    // Re-fetch female list immediately
    _loadBrowseDates();

    // Re-register socket listeners if needed
    if (WebSocketService.isConnected) {
      if (!_directListenersRegistered) {
        _setupDirectSocketListener();
      }
    }

    // Reset daily check to allow showing popup again if eligible
    DailyRewardsManager.resetDailyCheck();
    Future.delayed(const Duration(seconds: 1), () {
      if (mounted) _checkDailyRewards();
    });
  }
}
```

**Step 2: Add listener registration flag**

Add a field near the other state variables (around line 30):

```dart
bool _directListenersRegistered = false;
```

In `_setupDirectSocketListener()` (line ~515), set it at the end:

```dart
_directListenersRegistered = true;
```

**Step 3: Register reconnect callback in `initState` flow**

In `_initializeData()` (after `_setupWebSocketListener()` around line 209), add:

```dart
// Re-register listeners after any WebSocket reconnect
WebSocketService.onReconnect(_onWebSocketReconnect);
```

Add the callback method:

```dart
void _onWebSocketReconnect() {
  if (!mounted) return;
  if (kDebugMode) print('🔄 WebSocket reconnected — re-registering listeners and refreshing');
  _directListenersRegistered = false;
  _setupDirectSocketListener();
  _loadBrowseDates();
}
```

**Step 4: Clean up in dispose**

In `dispose()` (line ~663), add:

```dart
WebSocketService.removeReconnectCallback(_onWebSocketReconnect);
```

**Step 5: Commit**

```bash
cd D:\welbuilt\TingaTalk
git add lib/screens/male/male_home_screen.dart
git commit -m "fix: re-fetch females and re-register WS listeners on app resume and reconnect"
```

---

### Task 3: Fix contradictory `user_disconnected` event handling

**Files:**
- Modify: `D:\welbuilt\TingaTalk\lib\screens\male\male_home_screen.dart`

**Step 1: Change `user_disconnected` handler to preserve `isAvailable`**

Replace lines 541-548 in `_setupDirectSocketListener()`:

```dart
// Only process if a female user disconnected
if (disconnectedUserId != null && userType == 'female') {
  if (kDebugMode) print('👋 Female user disconnected: $disconnectedUserId');
  _handleAvailabilityChange({
    'femaleUserId': disconnectedUserId,
    'isAvailable': true,   // PRESERVE — Tier 1 timeout will confirm
    'isOnline': false,
    'status': 'disconnected',
  });
}
```

**Step 2: Commit**

```bash
cd D:\welbuilt\TingaTalk
git add lib/screens/male/male_home_screen.dart
git commit -m "fix: user_disconnected preserves isAvailable to match Tier 1 design"
```

---

### Task 4: Reduce Tier 2 timeout from 30 minutes to 5 minutes

**Files:**
- Modify: `D:\welbuilt\tingatalk-backend\src\shared\constants.js`

**Step 1: Change AVAILABILITY_TIMEOUT_MS**

Replace line 42:

```javascript
export const AVAILABILITY_TIMEOUT_MS = 300000;     // 5 minutes safety net (Tier 2: isAvailable=false for force-close)
```

**Step 2: Commit**

```bash
cd D:\welbuilt\tingatalk-backend
git add src/shared/constants.js
git commit -m "fix: reduce Tier 2 availability timeout from 30 min to 5 min"
```

---

### Task 5: Add debouncing to `_loadBrowseDates` and timestamp deduplication

**Files:**
- Modify: `D:\welbuilt\TingaTalk\lib\screens\male\male_home_screen.dart`

**Step 1: Add debounce timer and timestamp tracking fields**

Near the other state variables:

```dart
Timer? _loadDebounceTimer;
final Map<String, String> _lastEventTimestamp = {};
```

**Step 2: Create debounced load method**

```dart
/// Debounced version of _loadBrowseDates — prevents concurrent/rapid calls
void _debouncedLoadBrowseDates() {
  _loadDebounceTimer?.cancel();
  _loadDebounceTimer = Timer(const Duration(milliseconds: 500), () {
    if (mounted) _loadBrowseDates();
  });
}
```

**Step 3: Replace `_loadBrowseDates()` calls in event handlers**

In `_handleAvailabilityChange()` (lines 599 and 606), replace `_loadBrowseDates()` with `_debouncedLoadBrowseDates()`.

Keep the direct call in `didChangeAppLifecycleState` (resume) as non-debounced since it should be immediate.

**Step 4: Add timestamp deduplication to `_handleAvailabilityChange`**

At the start of `_handleAvailabilityChange()`, after extracting `femaleUserId`, add:

```dart
// Deduplicate by timestamp
final eventTimestamp = data['timestamp'] as String?;
if (eventTimestamp != null && femaleUserId != null) {
  final lastTs = _lastEventTimestamp[femaleUserId];
  if (lastTs != null && eventTimestamp.compareTo(lastTs) <= 0) {
    if (kDebugMode) print('⏭️ Skipping stale event for $femaleUserId (ts=$eventTimestamp <= $lastTs)');
    return;
  }
  _lastEventTimestamp[femaleUserId] = eventTimestamp;
}
```

**Step 5: Cancel fade-out if user comes back online**

In `_handleAvailabilityChange()`, before the `isReachable` check, add:

```dart
// Cancel any pending fade-out for this user
if (isAvailable == true && _fadingOutUsers.containsKey(femaleUserId)) {
  if (kDebugMode) print('🔄 Cancelling fade-out for $femaleUserId — came back available');
  setState(() {
    _fadingOutUsers.remove(femaleUserId);
  });
}
```

**Step 6: Clean up in dispose**

```dart
_loadDebounceTimer?.cancel();
```

**Step 7: Commit**

```bash
cd D:\welbuilt\TingaTalk
git add lib/screens/male/male_home_screen.dart
git commit -m "fix: add debouncing, timestamp dedup, and fade-out cancellation"
```

---

### Task 6: Clean up socket listeners on screen dispose

**Files:**
- Modify: `D:\welbuilt\TingaTalk\lib\screens\male\male_home_screen.dart`

**Step 1: Track registered event names**

Add field:

```dart
final List<String> _registeredSocketEvents = [];
```

**Step 2: Update `_setupDirectSocketListener` to track events**

After each `WebSocketService.on(...)` call, add the event name to the list:

```dart
WebSocketService.on('availability_changed', (data) { ... });
_registeredSocketEvents.add('availability_changed');

WebSocketService.on('user_disconnected', (data) { ... });
_registeredSocketEvents.add('user_disconnected');

WebSocketService.on('female_offline', (data) { ... });
_registeredSocketEvents.add('female_offline');
```

**Step 3: Remove listeners in dispose**

In `dispose()`, before `super.dispose()`:

```dart
// Remove direct socket listeners
for (final event in _registeredSocketEvents) {
  WebSocketService.off(event);
}
_registeredSocketEvents.clear();
```

**Step 4: Reset flag and list on re-registration**

In `_setupDirectSocketListener()`, at the start:

```dart
// Remove old listeners before re-registering
for (final event in _registeredSocketEvents) {
  WebSocketService.off(event);
}
_registeredSocketEvents.clear();
```

**Step 5: Commit**

```bash
cd D:\welbuilt\TingaTalk
git add lib/screens/male/male_home_screen.dart
git commit -m "fix: clean up socket event listeners on screen dispose and re-registration"
```

---

### Task 7: Add stale connection cleanup to backend background jobs

**Files:**
- Modify: `D:\welbuilt\tingatalk-backend\src\backgroundJobs.js`

**Step 1: Read current backgroundJobs.js**

Read the file to find where to add the cleanup job.

**Step 2: Add periodic stale connection cleanup (every 5 minutes)**

Add a new function and call it from the main setup:

```javascript
function startStaleConnectionCleanup(io) {
  setInterval(() => {
    const allUsers = getAllConnectedUsers();
    let cleaned = 0;

    for (const [userId, userData] of allUsers.entries()) {
      if (!userData.isOnline) continue;

      const socket = io.sockets.sockets.get(userData.socketId);
      if (!socket || !socket.connected) {
        logger.info(`Cleaning stale connection for ${userId} (socket ${userData.socketId} is dead)`);
        userData.isOnline = false;
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.info(`Cleaned ${cleaned} stale connections`);
    }
  }, 300000); // Every 5 minutes
}
```

**Step 3: Call from the existing startup function**

Add `startStaleConnectionCleanup(io)` to wherever background jobs are initialized.

**Step 4: Commit**

```bash
cd D:\welbuilt\tingatalk-backend
git add src/backgroundJobs.js
git commit -m "fix: add periodic stale WebSocket connection cleanup (5 min interval)"
```

---

### Task 8: Use Socket.IO rooms to scope availability broadcasts

**Files:**
- Modify: `D:\welbuilt\tingatalk-backend\src\socket\handlers\connection.handler.js`
- Modify: `D:\welbuilt\tingatalk-backend\src\socket\state\connectionManager.js`
- Modify: `D:\welbuilt\tingatalk-backend\src\features\availability\availability.routes.js`

**Step 1: Join males to a browse room on connect**

In `connection.handler.js`, inside the `join` handler, after `socket.join(roomName)` (line 99), add:

```javascript
// Males join browse room for scoped availability broadcasts
if (userType === 'male') {
  socket.join('room_male_browse');
}
```

**Step 2: Replace `io.emit('availability_changed', ...)` with room-scoped emit**

In `connectionManager.js`, change all `io.emit('availability_changed', ...)` calls to:
```javascript
io.to('room_male_browse').emit('availability_changed', ...)
```

Locations:
- `startDisconnectTimeout` (line 194)
- `_startAvailabilityTimeout` (line 268)
- `forceSetUnavailable` (line 308)

In `connection.handler.js`:
- `join` handler broadcast (line 119)

In `availability.routes.js`:
- `update_availability` broadcast (line 246): change `io.sockets.emit` to `io.to('room_male_browse').emit`

Keep `user_disconnected` and `user_status_changed` as `io.emit()` for now (both genders may need them).

**Step 3: Commit**

```bash
cd D:\welbuilt\tingatalk-backend
git add src/socket/handlers/connection.handler.js src/socket/state/connectionManager.js src/features/availability/availability.routes.js
git commit -m "perf: scope availability_changed broadcasts to male browse room"
```

---

### Task 9: Add startup cleanup for stale online users

**Files:**
- Modify: `D:\welbuilt\tingatalk-backend\src\server.js`

**Step 1: Read current server.js startup sequence**

Find where the server starts listening (after `app.listen` or `httpServer.listen`).

**Step 2: Add startup cleanup**

After server is listening and Firestore is connected, add:

```javascript
// Clean up stale online statuses from previous server instance
try {
  const db = getFirestore();
  if (db) {
    const staleUsers = await db.collection('users')
      .where('isOnline', '==', true)
      .get();

    if (!staleUsers.empty) {
      const batch = db.batch();
      let count = 0;
      staleUsers.docs.forEach(doc => {
        batch.update(doc.ref, { isOnline: false });
        count++;
      });
      await batch.commit();
      logger.info(`Startup cleanup: reset ${count} stale isOnline=true users`);
    }
  }
} catch (err) {
  logger.warn(`Startup cleanup failed: ${err.message}`);
}
```

**Step 3: Commit**

```bash
cd D:\welbuilt\tingatalk-backend
git add src/server.js
git commit -m "fix: reset stale isOnline users on server startup"
```

---

### Task 10: Deploy to staging and verify

**Step 1: Push backend changes**

```bash
cd D:\welbuilt\tingatalk-backend
git push origin feature/modular-backend
```

CI/CD pipeline auto-deploys to staging VPS.

**Step 2: Push frontend changes**

```bash
cd D:\welbuilt\TingaTalk
git push origin android
```

Build and install on test device pointing to `https://staging-api.tingatalk.in`.

**Step 3: Test scenarios**

Run through the 7 test scenarios from the design doc:
1. Female online → male backgrounds → male resumes → female card visible?
2. Female online → female backgrounds → male sees card?
3. Female force-closes → male sees card disappear within 5 min?
4. Female toggles rapidly on/off → male list consistent?
5. Male loses network → regains → list refreshes?
6. Server restarts → male list recovers?
7. Two males online → both receive correct events?

**Step 4: Commit any test fixes**

If issues found, fix and re-deploy.
