# Call Debugging Guide - TingaTalk Backend

## Changes Made

### Backend Enhancements (server.js)

1. **Enhanced Join Event Logging** (Lines 478-568)
   - Added detailed logging for join events
   - Logs socket ID, user ID, data format
   - Verifies room membership after join
   - Confirms socket is in expected room `user_{userId}`

2. **Enhanced Initiate Call Logging** (Lines 574-701)
   - Comprehensive logging of call initiation
   - Logs recipient status and socket connection
   - Verifies recipient socket exists and is in rooms
   - Emits `incoming_call` with ALL required fields:
     - `callId`, `roomName`, `callerId`, `recipientId`, `callType`, `timestamp`
     - Alternative formats: `call_id`, `room_name`, `caller_id`, `recipient_id`, `call_type`

3. **Triple Emission Strategy**
   - Method 1: Direct emit to recipient socket ID (most reliable)
   - Method 2: Emit to room `user_{recipientId}` (backup)
   - Method 3: Broadcast to all sockets via `debug_incoming_call` (debugging)

4. **New Diagnostic Endpoints**
   - `GET /api/diagnostic/connections` - View all connections, rooms, and calls
   - `GET /api/diagnostic/user/:userId` - Check specific user's connection status

### Flutter Enhancements (websocket_service.dart)

1. **Enhanced Event Listening** (Lines 268-327)
   - Added listener for `debug_incoming_call` broadcast
   - Comprehensive logging of ALL Socket.IO events via `onAny`
   - Logs event name, type, data structure, and current user
   - Helps identify if events are reaching the client

## Testing Steps

### Step 1: Restart Backend Server

```bash
cd backend
pm2 restart tingatalk-backend
# Or if not using PM2:
# npm start
```

### Step 2: Check Backend Logs

Monitor the backend logs in real-time:

```bash
pm2 logs tingatalk-backend --lines 100
```

### Step 3: Test Female User Connection

1. Open female user app
2. Backend should log:
```
🚪 === JOIN EVENT RECEIVED ===
🚪 Socket ID: <socket_id>
🚪 Data: <user_data>
🚪 User <user_id> stored in connectedUsers map
🚪 Socket <socket_id> joined room: user_<user_id>
🚪 Socket <socket_id> is now in rooms: ["<socket_id>","user_<user_id>"]
🚪 Room user_<user_id> contains: ✅ THIS SOCKET
```

3. Flutter console should show:
```
✅ Socket.IO connected successfully for user: <user_id>
🏭 Joined user room for: <user_id>
```

### Step 4: Check User Connection via API

Open browser or use curl:

```bash
# Check all connections
curl http://147.79.66.3:3000/api/diagnostic/connections

# Check specific female user
curl http://147.79.66.3:3000/api/diagnostic/user/<female_user_id>
```

Expected response for connected female user:
```json
{
  "userId": "user_1758437441394_9345364408",
  "isConnected": true,
  "socketId": "OVlvFP94btyRJA36AAAB",
  "socketExists": true,
  "rooms": ["OVlvFP94btyRJA36AAAB", "user_user_1758437441394_9345364408"],
  "expectedRoom": "user_user_1758437441394_9345364408",
  "isInExpectedRoom": true,
  "status": "available"
}
```

⚠️ **Critical Check**: `isInExpectedRoom` MUST be `true`

### Step 5: Initiate Call from Male User

1. Male user initiates call to female user
2. Backend should log:

```
📞 === INITIATE_CALL EVENT RECEIVED ===
📞 Data: {...}
📞 Caller: <male_user_id>, Recipient: <female_user_id>, Type: video
📞 Recipient <female_user_id> status: available
📞 Generated call ID: call_<id>
📞 Generated room name: video_<caller>_<recipient>
📞 Call object created and stored: call_<id>
📞 Recipient connection status: ONLINE
📞 Recipient socket ID: <socket_id>
📞 Recipient socket rooms: ["<socket_id>","user_<female_user_id>"]
📞 Incoming call payload: {...}
📡 === EMITTING INCOMING_CALL EVENT ===
📡 Target socket ID: <socket_id>
📡 Target room: user_<female_user_id>
📡 Method 1: Emitting directly to socket <socket_id>...
📡 ✅ Method 1 emit completed
📡 Method 2: Emitting to room user_<female_user_id>...
📡 ✅ Method 2 emit completed
📡 Method 3: Broadcasting to all sockets for debugging...
📡 ✅ Method 3 broadcast completed
```

3. Female Flutter app should log:

```
📬 === Socket.IO EVENT RECEIVED ===
📬 Event name: incoming_call
📬 Data: {callId: ..., roomName: ..., callerId: ..., ...}
📬 Data as Map keys: [callId, roomName, callerId, recipientId, callType, ...]
📞 [CALL EVENT DETECTED] incoming_call: {...}
📞 Recipient ID in payload: <female_user_id>
📞 Is this for me? true
```

AND/OR:

```
🔴 DEBUG_INCOMING_CALL received: {...}
🔴 Target recipient: <female_user_id>
🔴 Current user: <female_user_id>
🔴 ✅ This debug call is FOR ME! Processing...
```

### Step 6: Verify IncomingCallService Processing

Female app should log:

```
📞 === PROCESSING INCOMING CALL ===
📞 Call ID: call_<id>
📞 Caller ID: <male_user_id>
📞 Room Name: video_<caller>_<recipient>
📞 Call Type: video
📞 Source: socketIO
📞 Current User: <female_user_id> (female)
👩 Female user - processing incoming call...
📱 User availability check: true
✅ All checks passed - processing valid incoming call!
👤 Fetching caller name for: <male_user_id>
📢 === SHOWING RINGER SCREEN ===
📢 Call ID: call_<id>
📢 Caller: <name> (<male_user_id>)
📢 NavigatorKey available: true
📢 Navigation context available: true
📢 Navigator state available: true
🚀 ✅ All navigation checks passed - showing ringer screen
```

## Troubleshooting

### Problem: Female user not in room

**Symptom**: `isInExpectedRoom: false` in diagnostic API

**Solution**:
1. Check if join event was received on backend
2. Verify `socket.join()` was called
3. Ensure no errors in join event handler
4. Try reconnecting the female user app

### Problem: Backend emits but female app doesn't receive

**Symptom**: Backend logs show successful emit, but no event in Flutter

**Solution**:
1. Check if Socket.IO is connected in Flutter: `WebSocketService.isConnected`
2. Verify listeners are set up: Check `_setupSocketIOListeners()` was called
3. Look for connection errors in Flutter console
4. Check CORS settings if running on different domains

### Problem: Event reaches Flutter but not processed

**Symptom**: Event logged in `onAny` but not in `incoming_call` listener

**Solution**:
1. Check event payload structure
2. Verify `recipientId` matches `_currentUserId`
3. Check `IncomingCallService` is initialized
4. Verify `_processIncomingCall` is not filtering out the call

### Problem: Call processed but ringer doesn't show

**Symptom**: Processing logs appear but no ringer screen

**Solution**:
1. Check `NavigationService.navigatorKey` is set
2. Verify app is in foreground
3. Check female user gender is set correctly (not 'male')
4. Look for navigation errors in logs

## Key Files Modified

1. **backend/server.js**
   - Lines 478-568: Join event handler
   - Lines 574-701: Initiate call handler
   - Lines 201-311: Diagnostic endpoints

2. **lib/services/websocket_service.dart**
   - Lines 268-327: Enhanced event listeners

## Firestore Integration (TODO)

The backend currently does NOT write to Firestore. To add this:

1. Add Firebase Admin SDK to backend:
```bash
cd backend
npm install firebase-admin
```

2. Add Firestore write in `initiate_call` handler after line 620:
```javascript
await admin.firestore().collection('calls').doc(finalCallId).set({
  callId: finalCallId,
  callerId: callerId,
  recipientId: recipientId,
  callType: callType,
  roomName: finalRoomName,
  status: 'ringing',
  createdAt: admin.firestore.FieldValue.serverTimestamp()
});
```

This provides redundancy if Socket.IO fails.

## Next Steps

1. Test the call flow with enhanced logging
2. If female user still doesn't receive call, check the specific failure point using logs
3. Use diagnostic endpoints to verify room membership
4. Consider adding Firestore as backup notification channel
5. Test with multiple female users to ensure scalability

## Support

If issues persist after following this guide:
1. Collect full logs from both backend and Flutter
2. Run diagnostic API and share results
3. Verify network connectivity between devices
4. Check firewall/security group settings on server
