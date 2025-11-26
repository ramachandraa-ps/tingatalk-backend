#!/bin/bash
# Deploy availability fix to VPS

echo "🚀 Deploying availability fix to VPS..."

# VPS Details
VPS_HOST="147.79.66.3"
VPS_USER="root"
VPS_PATH="/root/TingaTalk/tingatalk_flutter/backend"

echo "📦 Uploading fixed server.js..."
scp server.js ${VPS_USER}@${VPS_HOST}:${VPS_PATH}/

echo "🔄 Restarting backend service..."
ssh ${VPS_USER}@${VPS_HOST} "cd ${VPS_PATH} && pm2 restart tingatalk-backend"

echo "✅ Deployment complete!"
echo "📊 Check status with: ssh ${VPS_USER}@${VPS_HOST} 'pm2 status && pm2 logs tingatalk-backend --lines 20'"
