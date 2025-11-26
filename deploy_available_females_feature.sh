#!/bin/bash

# Deploy Available Females Feature
# This script deploys the new /api/get_available_females endpoint and WebSocket events

echo "🚀 Deploying Available Females Feature..."
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

# Deploy server.js
echo "📦 Deploying updated server.js..."
sshpass -p "$VPS_PASSWORD" scp -o StrictHostKeyChecking=no server.js $VPS_USER@$VPS_HOST:$VPS_PATH/

if [ $? -ne 0 ]; then
    echo "❌ Failed to deploy server.js"
    exit 1
fi

echo "✅ server.js deployed"
echo ""

# Restart PM2
echo "🔄 Restarting backend..."
sshpass -p "$VPS_PASSWORD" ssh -o StrictHostKeyChecking=no $VPS_USER@$VPS_HOST << 'EOF'
cd /root/TingaTalk/tingatalk_flutter/backend

# Reload backend (graceful restart)
echo "🔄 Reloading backend..."
pm2 reload tingatalk-backend

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
    echo "🎉 Available Females Feature deployed!"
    echo ""
    echo "📡 New endpoint: http://$VPS_HOST:3000/api/get_available_females"
    echo "📡 WebSocket event: availability_changed"
    echo ""
    echo "🧪 Test the new endpoint:"
    echo "   curl http://$VPS_HOST:3000/api/get_available_females"
    echo ""
    echo "📝 Features deployed:"
    echo "   ✅ New API endpoint: /api/get_available_females"
    echo "   ✅ WebSocket broadcast: availability_changed event"
    echo "   ✅ Filters by availability + WebSocket connection"
    echo "   ✅ Returns full user stats (rating, calls, likes)"
else
    echo ""
    echo "❌ Failed to restart backend"
    exit 1
fi
