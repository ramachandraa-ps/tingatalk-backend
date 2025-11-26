#!/bin/bash
# Verify the availability fix deployment

VPS_HOST="147.79.66.3"
VPS_USER="root"

echo "🔍 Verifying deployment on VPS..."

echo ""
echo "1️⃣ Checking if backend is running..."
ssh ${VPS_USER}@${VPS_HOST} "pm2 list | grep tingatalk-backend"

echo ""
echo "2️⃣ Checking recent logs for fix indicators..."
ssh ${VPS_USER}@${VPS_HOST} "tail -20 /root/TingaTalk/tingatalk_flutter/backend/logs/out.log | grep -E '(Availability check|connection:)'"

echo ""
echo "3️⃣ Testing health endpoint..."
curl -s http://${VPS_HOST}:3000/api/health | jq '.status, .connectedUsers, .busyUsers'

echo ""
echo "4️⃣ Checking for recent errors..."
ssh ${VPS_USER}@${VPS_HOST} "tail -10 /root/TingaTalk/tingatalk_flutter/backend/logs/err.log"

echo ""
echo "✅ Verification complete!"
echo ""
echo "💡 To test with real users:"
echo "   1. Have User A login to the app"
echo "   2. Have User B try to call User A"
echo "   3. Check logs: ssh ${VPS_USER}@${VPS_HOST} 'pm2 logs tingatalk-backend --lines 50'"
