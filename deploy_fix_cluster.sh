#!/bin/bash

# Fix PM2 Cluster Mode Issue
# This script deploys the fixed ecosystem.config.js and restarts backend

echo "🔥 Deploying PM2 cluster mode fix..."
echo ""

VPS_HOST="147.79.66.3"
VPS_USER="root"
VPS_PASSWORD="CSILDTjU+02TXhgQ)w''''5"
VPS_PATH="/root/TingaTalk/tingatalk_flutter/backend"

# Check sshpass
if ! command -v sshpass &> /dev/null; then
    echo "⚠️ sshpass not found. Please install it:"
    echo "   sudo apt-get install sshpass"
    exit 1
fi

# Deploy ecosystem.config.js
echo "📦 Deploying ecosystem.config.js..."
sshpass -p "$VPS_PASSWORD" scp -o StrictHostKeyChecking=no ecosystem.config.js $VPS_USER@$VPS_HOST:$VPS_PATH/

if [ $? -ne 0 ]; then
    echo "❌ Failed to deploy ecosystem.config.js"
    exit 1
fi

echo "✅ ecosystem.config.js deployed"
echo ""

# Restart PM2 with new config
echo "🔄 Restarting backend with new config..."
sshpass -p "$VPS_PASSWORD" ssh -o StrictHostKeyChecking=no $VPS_USER@$VPS_HOST << 'EOF'
cd /root/TingaTalk/tingatalk_flutter/backend

# Stop all instances
echo "⏹️  Stopping all instances..."
pm2 stop tingatalk-backend

# Delete from PM2
echo "🗑️  Deleting from PM2..."
pm2 delete tingatalk-backend

# Start with new config
echo "🚀 Starting with new config (single instance)..."
pm2 start ecosystem.config.js --env production

# Save PM2 config
echo "💾 Saving PM2 config..."
pm2 save

# Show status
echo ""
echo "📊 Backend status:"
pm2 status tingatalk-backend

echo ""
echo "📝 Recent logs:"
pm2 logs tingatalk-backend --lines 20 --nostream
EOF

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Backend restarted successfully!"
    echo ""
    echo "🎉 Fix deployed! Backend now running in single instance mode."
    echo ""
    echo "Backend URL: http://$VPS_HOST:3000"
    echo "Health check: curl http://$VPS_HOST:3000/api/health"
else
    echo ""
    echo "❌ Failed to restart backend"
    exit 1
fi
