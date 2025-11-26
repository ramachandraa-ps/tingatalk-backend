# TingaTalk Backend - Production Deployment Guide

## 🔧 Critical Fixes Implemented

### Bug Fix: Call Notifications Not Reaching Recipient
**Problem:** The female user was not receiving incoming call notifications despite successful call tracking.

**Root Cause:** 
- Used `socket.to('user_${recipientId}')` which emits to OTHER sockets in the room, excluding the sender
- Since the caller (sender) was emitting, the recipient never received the event

**Solution:**
- Changed to `io.to(recipientSocketId)` for direct socket emission
- Added dual emission strategy: direct socket + room (for redundancy)
- Enhanced socket connection tracking to prevent duplicate connections
- Added comprehensive logging for troubleshooting

### Additional Production Enhancements

1. **Duplicate Connection Prevention**
   - Detects and handles reconnection scenarios
   - Properly disconnects old socket when user reconnects
   
2. **Call Timeout (30 seconds)**
   - Auto-cancels calls if recipient doesn't respond within 30 seconds
   - Properly cleans up state and notifies both parties

3. **Enhanced Disconnect Handling**
   - Detects disconnection during active calls
   - Notifies other participants
   - Cleans up server timers and call state
   - Proper status reset

4. **Comprehensive Logging**
   - Socket connection/disconnection with IP and User-Agent
   - Call flow tracking (initiate → ring → accept/decline → end)
   - Error conditions and warnings
   - All timestamps in ISO format

---

## 📋 Pre-Deployment Checklist

### Local Testing (Before VPS Deployment)
- [ ] All changes tested locally with `npm run dev`
- [ ] Call flow verified: initiate → ring → accept → end
- [ ] Call flow verified: initiate → ring → decline
- [ ] Call flow verified: initiate → timeout (30s)
- [ ] Disconnect during call tested
- [ ] Multiple simultaneous users tested
- [ ] Duplicate connection scenario tested

---

## 🚀 VPS Deployment Steps

### Step 1: Backup Current Server (CRITICAL!)

```bash
# SSH into your VPS
ssh root@srv1073916.your-domain.com

# Create backup directory
mkdir -p ~/tingatalk_backups

# Backup current deployment
cd /root
tar -czf ~/tingatalk_backups/backup_$(date +%Y%m%d_%H%M%S).tar.gz backend/

# Backup PM2 configuration
pm2 save
cp ~/.pm2/dump.pm2 ~/tingatalk_backups/dump.pm2.backup
```

### Step 2: Update Files on VPS

#### Option A: Using Git (Recommended)
```bash
cd ~/backend
git pull origin main
```

#### Option B: Manual File Transfer (from your local machine)
```powershell
# From your local machine (Windows PowerShell)
scp D:\welbuilt\TingaTalk\tingatalk_flutter\backend\server.js root@YOUR_VPS_IP:/root/backend/
```

#### Option C: Direct Edit on VPS
```bash
# Edit the file directly on VPS
nano ~/backend/server.js
# Copy and paste the updated content
```

### Step 3: Verify Environment Configuration

```bash
cd ~/backend

# Check if .env file exists and has all required variables
cat .env

# Required environment variables:
# TWILIO_ACCOUNT_SID=your_account_sid
# TWILIO_API_KEY_SID=your_api_key_sid
# TWILIO_API_KEY_SECRET=your_api_key_secret
# PORT=3000
# NODE_ENV=production
# CORS_ORIGIN=*  (or your specific origins)
# LOG_LEVEL=info
```

### Step 4: Install/Update Dependencies

```bash
cd ~/backend
npm install --production
```

### Step 5: Test Configuration (Dry Run)

```bash
# Test if server starts without errors
node server.js

# Press Ctrl+C to stop after verifying it starts successfully
```

### Step 6: Restart PM2 Service

```bash
# Method 1: Restart existing app
pm2 restart tingatalk-backend

# Method 2: If restart doesn't work, delete and recreate
pm2 delete tingatalk-backend
pm2 start ecosystem.config.js --env production

# Save PM2 configuration
pm2 save
```

### Step 7: Verify Deployment

```bash
# Check PM2 status
pm2 status

# View real-time logs (press Ctrl+C to exit)
pm2 logs tingatalk-backend --lines 50

# Check health endpoint
curl http://localhost:3000/api/health

# Should return JSON with status: "OK"
```

### Step 8: Monitor for Issues

```bash
# Watch logs in real-time
pm2 logs tingatalk-backend

# Monitor system resources
pm2 monit
```

---

## 🧪 Production Testing Procedure

### Test 1: User Connection
1. Open your Flutter app on 2 devices (male & female users)
2. Check server logs for connection messages:
```bash
pm2 logs tingatalk-backend --lines 50 --nostream | grep "User connected"
pm2 logs tingatalk-backend --lines 50 --nostream | grep "joined"
```

**Expected Output:**
```
[INFO] 🔌 User connected: <socket_id> from <ip>
[INFO] 👤 User <user_id> (male/female) joined - Socket: <socket_id> - Status: available
```

### Test 2: Call Initiation (CRITICAL TEST)
1. Male user initiates call to female user
2. Check logs:
```bash
pm2 logs tingatalk-backend --lines 50 --nostream | grep "Call initiated"
pm2 logs tingatalk-backend --lines 50 --nostream | grep "incoming_call"
```

**Expected Output:**
```
[INFO] 📞 Call initiated: call_<id> from <caller_id> to <recipient_id> (audio/video)
[INFO] 📡 Sending incoming_call to recipient socket: <socket_id> in room: user_<recipient_id>
```

**CRITICAL:** Female user MUST see incoming call screen within 1-2 seconds

### Test 3: Call Accept
1. Female user accepts the call
2. Check logs:
```bash
pm2 logs tingatalk-backend --lines 50 --nostream | grep "Call accepted"
```

**Expected Output:**
```
[INFO] ✅ Call accepted: <call_id> by <recipient_id> - Notifying caller <caller_id>
[INFO] ✅ Call accepted: <call_id> by <recipient_id> - Both users marked as busy
```

### Test 4: Call Decline
1. Female user declines the call
2. Check logs:
```bash
pm2 logs tingatalk-backend --lines 50 --nostream | grep "Call declined"
```

**Expected Output:**
```
[INFO] ❌ Call declined: <call_id> by <recipient_id>
```

### Test 5: Call Timeout (30 seconds)
1. Male user initiates call
2. Female user does NOT respond
3. Wait 30 seconds
4. Check logs:
```bash
pm2 logs tingatalk-backend --lines 50 --nostream | grep "timeout"
```

**Expected Output:**
```
[WARN] ⏱️  Call timeout: <call_id> - No response from <recipient_id>
```

### Test 6: Concurrent Call Prevention
1. Male user calls female user (call in progress)
2. Another user tries to call the same female user
3. Check logs - second call should be blocked:
```bash
pm2 logs tingatalk-backend --lines 50 --nostream | grep "Call blocked"
```

**Expected Output:**
```
[WARN] 📞 Call blocked: Recipient <recipient_id> is busy
```

---

## 🔍 Debugging Common Issues

### Issue 1: Recipient Not Getting Call Notification

**Symptoms:**
- Logs show "Call initiated"
- No "incoming_call" in logs
- Female user sees nothing

**Debug Steps:**
```bash
# Check if recipient is connected
pm2 logs tingatalk-backend | grep "<recipient_user_id>" | tail -20

# Check socket mapping
# Look for: "User <user_id> joined - Socket: <socket_id>"

# Verify emission
# Look for: "Sending incoming_call to recipient socket"
```

**Solution:** 
- Verify recipient is connected before call
- Check if socket ID is valid
- Ensure recipient joined with correct user ID

### Issue 2: Duplicate User Connections

**Symptoms:**
- User shows "joined" multiple times in logs
- Calls not working properly

**Debug Steps:**
```bash
# Check for multiple joins
pm2 logs tingatalk-backend --lines 100 --nostream | grep "User.*joined"
```

**Solution:**
- New code handles this automatically
- Old socket is disconnected when user reconnects
- Check for "User reconnecting" warnings in logs

### Issue 3: Calls Not Timing Out

**Symptoms:**
- User initiates call
- Recipient doesn't respond
- Call never ends

**Debug Steps:**
```bash
# Check active calls via health endpoint
curl http://localhost:3000/api/health | jq '.activeCalls'
```

**Solution:**
- Timeout is now 30 seconds (hardcoded)
- Check for "Call timeout" warnings in logs

---

## 📊 Monitoring & Maintenance

### Key Metrics to Monitor

```bash
# 1. Application Status
pm2 status tingatalk-backend

# 2. Active Connections
curl http://localhost:3000/api/health | jq '{activeCalls, connectedUsers, busyUsers}'

# 3. Memory Usage
pm2 describe tingatalk-backend | grep memory

# 4. Uptime
pm2 describe tingatalk-backend | grep uptime

# 5. Error Rate
pm2 logs tingatalk-backend --err --lines 100
```

### Daily Health Check Script

Create a file: `~/health_check.sh`
```bash
#!/bin/bash
echo "=== TingaTalk Health Check $(date) ==="
echo ""
echo "1. PM2 Status:"
pm2 status tingatalk-backend
echo ""
echo "2. Server Health:"
curl -s http://localhost:3000/api/health | jq '.'
echo ""
echo "3. Recent Errors (last 10):"
pm2 logs tingatalk-backend --err --lines 10 --nostream
echo ""
echo "4. Memory & CPU:"
pm2 describe tingatalk-backend | grep -E "memory|cpu"
```

Make it executable:
```bash
chmod +x ~/health_check.sh
```

Run daily:
```bash
./health_check.sh
```

---

## 🔄 Rollback Procedure (If Something Goes Wrong)

### Quick Rollback

```bash
# 1. Stop current app
pm2 stop tingatalk-backend

# 2. Find your backup
ls -lh ~/tingatalk_backups/

# 3. Restore backup (replace with your backup filename)
cd /root
tar -xzf ~/tingatalk_backups/backup_YYYYMMDD_HHMMSS.tar.gz

# 4. Restart app
pm2 restart tingatalk-backend

# 5. Verify
pm2 logs tingatalk-backend --lines 20
```

---

## 📝 Post-Deployment Verification

### Checklist (Mark as completed)

- [ ] PM2 status shows app is "online"
- [ ] Health endpoint returns 200 OK
- [ ] User connection logs appear when app opens
- [ ] Call initiated logs appear when call starts
- [ ] **CRITICAL:** Female user receives incoming call notification
- [ ] Call accept/decline works properly
- [ ] Call timeout works after 30 seconds
- [ ] Concurrent calls are blocked properly
- [ ] Disconnection during call handled gracefully
- [ ] No errors in PM2 error logs
- [ ] Memory usage is stable (< 500MB)

---

## 🎯 Success Criteria

The deployment is successful when:

1. ✅ Male user can initiate call
2. ✅ Female user receives call notification within 1-2 seconds
3. ✅ Female user can accept/decline call
4. ✅ Call audio/video works properly
5. ✅ Call ends gracefully when either party hangs up
6. ✅ Call times out after 30 seconds if no response
7. ✅ Concurrent calls are blocked
8. ✅ No errors in server logs
9. ✅ Server restarts automatically if it crashes

---

## 🆘 Emergency Contacts

If deployment fails and you need help:

1. **Check logs first:** `pm2 logs tingatalk-backend --lines 100`
2. **Check health:** `curl http://localhost:3000/api/health`
3. **Rollback if needed** (see Rollback Procedure above)
4. **Document the error** and share logs

---

## 📞 Testing Commands Reference

```bash
# Quick test after deployment
pm2 logs tingatalk-backend --lines 50 --nostream | grep -E "User connected|joined|Call initiated|incoming_call|accepted|declined"

# Monitor real-time
pm2 logs tingatalk-backend | grep --color=always -E "User connected|joined|Call|incoming_call|accepted|declined|timeout|ERROR|WARN"

# Check specific user
pm2 logs tingatalk-backend --lines 200 --nostream | grep "<user_id>"

# Check call flow
pm2 logs tingatalk-backend --lines 200 --nostream | grep "<call_id>"
```

---

## ✅ Final Checklist Before Going Live

- [ ] Local testing completed and all tests pass
- [ ] VPS backup created
- [ ] Environment variables verified
- [ ] Files updated on VPS
- [ ] Dependencies installed
- [ ] PM2 restarted successfully
- [ ] Health check passes
- [ ] User connection tested
- [ ] Call flow tested (initiate → ring → accept → end)
- [ ] Call flow tested (initiate → ring → decline)
- [ ] Call timeout tested (30 seconds)
- [ ] Concurrent call blocking tested
- [ ] Disconnect handling tested
- [ ] No errors in logs for 5 minutes
- [ ] Flutter app updated with correct backend URL
- [ ] Team notified of deployment

---

## 📚 Additional Resources

- PM2 Documentation: https://pm2.keymetrics.io/docs/usage/quick-start/
- Socket.IO Documentation: https://socket.io/docs/v4/
- Twilio Video Documentation: https://www.twilio.com/docs/video

---

**Deployment Date:** _________________
**Deployed By:** _________________
**Backup File:** _________________
**Status:** [ ] Success  [ ] Partial  [ ] Failed
**Notes:** _________________
