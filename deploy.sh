#!/bin/bash

# TingaTalk Backend VPS Deployment Script
# Run this script on your VPS server to deploy the backend

set -e  # Exit on any error

echo "🚀 Starting TingaTalk Backend Deployment..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if running as root
if [[ $EUID -eq 0 ]]; then
   print_error "This script should not be run as root for security reasons"
   exit 1
fi

# Update system packages
print_status "Updating system packages..."
sudo apt update && sudo apt upgrade -y

# Install Node.js 18.x
print_status "Installing Node.js 18.x..."
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install PM2 globally
print_status "Installing PM2 process manager..."
sudo npm install -g pm2

# Install Nginx
print_status "Installing Nginx..."
sudo apt install nginx -y

# Install UFW firewall
print_status "Installing and configuring UFW firewall..."
sudo apt install ufw -y
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow ssh
sudo ufw allow 80
sudo ufw allow 443
sudo ufw --force enable

# Create application directory
APP_DIR="/opt/tingatalk-backend"
print_status "Creating application directory at $APP_DIR..."
sudo mkdir -p $APP_DIR
sudo chown $USER:$USER $APP_DIR

# Create logs directory
print_status "Creating logs directory..."
mkdir -p $APP_DIR/logs

# Create systemd service for PM2
print_status "Setting up PM2 startup service..."
sudo env PATH=$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u $USER --hp $HOME

print_success "VPS setup completed!"
print_status "Next steps:"
echo "1. Clone your repository to $APP_DIR"
echo "2. Copy .env.example to .env and configure your environment variables"
echo "3. Run 'npm install' in the application directory"
echo "4. Configure Nginx with the provided nginx.conf"
echo "5. Start the application with 'npm run pm2:start'"
echo ""
print_warning "Don't forget to:"
echo "- Configure your domain name in nginx.conf"
echo "- Set up SSL certificates"
echo "- Configure your environment variables in .env"
echo "- Update your Flutter app with the new backend URL"
