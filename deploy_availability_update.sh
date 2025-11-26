#!/bin/bash

# Deployment script for availability feature update
# This script deploys the updated server.js to the VPS

VPS_HOST="147.79.66.3"
VPS_USER="root"
VPS_PATH="/root/TingaTalk/tingatalk_flutter/backend"

echo "🚀 Deploying availability feature update to VPS..."
echo ""

# Step 1: Copy updated server.js
echo "📤 Uploading server.js..."
scp -o StrictHostKeyChecking=no server.js ${VPS_USER}@${VPS_HOST}:${VPS_PATH}/

if [ $? -ne 0 ]; then
    echo "❌ Failed to upload server.js"
    exit 1
fi

echo "✅ server.js uploaded successfully"
echo ""

# Step 2: Restart PM2 process
echo "🔄 Restarting backend server..."
ssh -o StrictHostKeyChecking=no ${VPS_USER}@${VPS_HOST} << 'ENDSSH'
cd /root/TingaTalk/tingatalk_flutter/backend
pm2 restart tingatalk-backend || pm2 start ecosystem.config.js
pm2 status
ENDSSH

if [ $? -ne 0 ]; then
    echo "❌ Failed to restart server"
    exit 1
fi

echo "✅ Server restarted successfully"
echo ""

# Step 3: Verify deployment
echo "🔍 Verifying deployment..."
sleep 3

ssh -o StrictHostKeyChecking=no ${VPS_USER}@${VPS_HOST} << 'ENDSSH'
echo "Checking server health..."
curl -s http://localhost:3000/api/health | python3 -m json.tool || echo "Health check failed"
echo ""
echo "PM2 status:"
pm2 status
ENDSSH

echo ""
echo "✅ Deployment complete!"
echo ""
echo "📋 New endpoint available:"
echo "   POST /api/update_availability"
echo ""
echo "🧪 To test the new endpoint:"
echo "   curl -X POST http://${VPS_HOST}:3000/api/update_availability \\"
echo "     -H 'Content-Type: application/json' \\"
echo "     -d '{\"user_id\":\"test_user\",\"is_available\":true}'"
echo ""
