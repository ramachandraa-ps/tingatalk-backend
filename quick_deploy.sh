#!/bin/bash

# TingaTalk Backend - Quick Deployment Script
# Usage: ./quick_deploy.sh

set -e

echo "================================================"
echo "  TingaTalk Backend - Quick Deploy"
echo "================================================"
echo ""

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info() { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; }

# Check if running on VPS
if [ ! -f "/root/backend/server.js" ] && [ ! -f "$HOME/backend/server.js" ]; then
    error "Backend directory not found. Are you on the VPS?"
    exit 1
fi

# Determine backend path
if [ -d "/root/backend" ]; then
    BACKEND_DIR="/root/backend"
else
    BACKEND_DIR="$HOME/backend"
fi

cd "$BACKEND_DIR"

info "Backend directory: $BACKEND_DIR"
echo ""

# Step 1: Create backup
info "Creating backup..."
BACKUP_DIR="$HOME/tingatalk_backups"
mkdir -p "$BACKUP_DIR"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_FILE="$BACKUP_DIR/backup_$TIMESTAMP.tar.gz"

if [ -f "server.js" ]; then
    tar -czf "$BACKUP_FILE" server.js ecosystem.config.js package.json .env 2>/dev/null || true
    info "Backup created: $BACKUP_FILE"
else
    warn "No files to backup"
fi

# Step 2: Pull latest changes (if git repo)
if [ -d ".git" ]; then
    info "Pulling latest changes from git..."
    git pull || warn "Git pull failed, continuing..."
else
    warn "Not a git repository - files must be updated manually"
fi

# Step 3: Install dependencies (only if package.json changed)
if [ -f "package.json" ]; then
    info "Checking dependencies..."
    npm install --production --quiet
fi

# Step 4: Restart PM2
info "Restarting PM2 application..."
pm2 restart tingatalk-backend

# Wait for app to start
info "Waiting for application to start..."
sleep 3

# Step 5: Check status
info "Checking application status..."
pm2 status tingatalk-backend

echo ""
info "Recent logs:"
pm2 logs tingatalk-backend --lines 15 --nostream

echo ""
# Step 6: Health check
info "Performing health check..."
sleep 2

if curl -sf http://localhost:3000/api/health > /dev/null; then
    info "✅ Health check PASSED"
    echo ""
    info "================================================"
    info "  Deployment Successful!"
    info "================================================"
    echo ""
    info "Commands:"
    echo "  View logs:    pm2 logs tingatalk-backend"
    echo "  Monitor:      pm2 monit"
    echo "  Stop:         pm2 stop tingatalk-backend"
    echo "  Restart:      pm2 restart tingatalk-backend"
    echo "  Rollback:     tar -xzf $BACKUP_FILE -C $BACKEND_DIR"
    echo ""
else
    error "❌ Health check FAILED"
    error "Check logs: pm2 logs tingatalk-backend"
    echo ""
    warn "To rollback: tar -xzf $BACKUP_FILE -C $BACKEND_DIR"
    exit 1
fi
