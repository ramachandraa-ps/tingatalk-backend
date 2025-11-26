#!/bin/bash

# Deployment script for unified terminology fix
# This script deploys the updated server.js to VPS and restarts the backend

echo "🚀 Deploying unified terminology fix to VPS..."
echo ""

# VPS credentials
VPS_HOST="147.79.66.3"
VPS_USER="root"
VPS_PASSWORD="CSILDTjU+02TXhgQ)w''''5"
VPS_PATH="/root/TingaTalk/tingatalk_flutter/backend"

# Check if sshpass is installed
if ! command -v sshpass &> /dev/null; then
    echo "⚠️ sshpass not found. Installing..."
    if command -v apt-get &> /dev/null; then
        sudo apt-get update && sudo apt-get install -y sshpass
    elif command -v yum &> /dev/null; then
        sudo yum install -y sshpass
    else
        echo "❌ Could not install sshpass. Please install it manually:"
        echo "   Ubuntu/Debian: sudo apt-get install sshpass"
        echo "   CentOS/RHEL: sudo yum install sshpass"
        echo ""
        echo "Alternative: Use manual deployment commands below"
        echo ""
        echo "Manual deployment:"
        echo "1. Copy server.js to VPS:"
        echo "   scp server.js root@$VPS_HOST:$VPS_PATH/"
        echo ""
        echo "2. SSH to VPS and restart backend:"
        echo "   ssh root@$VPS_HOST \"cd $VPS_PATH && pm2 restart tingatalk-backend\""
        exit 1
    fi
fi

# Deploy server.js
echo "📦 Deploying server.js..."
sshpass -p "$VPS_PASSWORD" scp -o StrictHostKeyChecking=no server.js $VPS_USER@$VPS_HOST:$VPS_PATH/

if [ $? -eq 0 ]; then
    echo "✅ server.js deployed successfully"
else
    echo "❌ Failed to deploy server.js"
    exit 1
fi

# Restart backend
echo "🔄 Restarting backend service..."
sshpass -p "$VPS_PASSWORD" ssh -o StrictHostKeyChecking=no $VPS_USER@$VPS_HOST "cd $VPS_PATH && pm2 restart tingatalk-backend"

if [ $? -eq 0 ]; then
    echo "✅ Backend restarted successfully"
else
    echo "❌ Failed to restart backend"
    exit 1
fi

# Check backend status
echo ""
echo "📊 Checking backend status..."
sshpass -p "$VPS_PASSWORD" ssh -o StrictHostKeyChecking=no $VPS_USER@$VPS_HOST "pm2 status tingatalk-backend"

echo ""
echo "🎉 Deployment complete!"
echo ""
echo "Backend URL: http://$VPS_HOST:3000"
echo "Health check: curl http://$VPS_HOST:3000/api/health"
