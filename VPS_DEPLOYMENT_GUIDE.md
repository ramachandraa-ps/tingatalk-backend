# TingaTalk Backend VPS Deployment Guide

This guide will help you deploy the TingaTalk backend to a VPS server, replacing the ngrok tunnel with a production-ready setup.

## Prerequisites

- VPS server with Ubuntu 20.04+ (or similar Linux distribution)
- Domain name (optional but recommended)
- SSH access to your VPS
- Twilio account with Video API enabled

## Step 1: VPS Server Setup

### 1.1 Connect to your VPS
```bash
ssh username@your-vps-ip
```

### 1.2 Run the automated setup script
```bash
# Download and run the deployment script
curl -fsSL https://raw.githubusercontent.com/your-repo/tingatalk_flutter/main/backend/deploy.sh | bash
```

Or manually run the setup commands:
```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 18.x
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install PM2 globally
sudo npm install -g pm2

# Install Nginx
sudo apt install nginx -y

# Install UFW firewall
sudo apt install ufw -y
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow ssh
sudo ufw allow 80
sudo ufw allow 443
sudo ufw --force enable
```

## Step 2: Deploy the Backend

### 2.1 Clone the repository
```bash
# Create application directory
sudo mkdir -p /opt/tingatalk-backend
sudo chown $USER:$USER /opt/tingatalk-backend
cd /opt/tingatalk-backend

# Clone your repository
git clone https://github.com/your-username/tingatalk_flutter.git .
cd backend
```

### 2.2 Install dependencies
```bash
npm install
```

### 2.3 Configure environment variables
```bash
# Copy environment template
cp .env.example .env

# Edit the .env file with your values
nano .env
```

Required environment variables:
```env
# Twilio Configuration (Required)
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_API_KEY_SID=SKxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_API_KEY_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Server Configuration
PORT=3000
NODE_ENV=production
HOST=0.0.0.0

# CORS Configuration (Replace with your actual domains)
CORS_ORIGIN=https://yourdomain.com,https://app.yourdomain.com

# Rate Limiting
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100

# Security
TRUST_PROXY=true
HELMET_ENABLED=true
```

### 2.4 Create logs directory
```bash
mkdir -p logs
```

## Step 3: Configure Nginx

### 3.1 Copy Nginx configuration
```bash
# Copy the nginx configuration
sudo cp nginx.conf /etc/nginx/sites-available/tingatalk-backend

# Create symlink to enable the site
sudo ln -s /etc/nginx/sites-available/tingatalk-backend /etc/nginx/sites-enabled/

# Remove default nginx site
sudo rm -f /etc/nginx/sites-enabled/default
```

### 3.2 Update Nginx configuration
Edit the configuration file:
```bash
sudo nano /etc/nginx/sites-available/tingatalk-backend
```

Update these values:
- `server_name your-domain.com;` → Replace with your actual domain or IP
- SSL certificate paths (if using SSL)

### 3.3 Test and reload Nginx
```bash
# Test nginx configuration
sudo nginx -t

# If test passes, reload nginx
sudo systemctl reload nginx
```

## Step 4: SSL Certificate (Optional but Recommended)

### 4.1 Install Certbot
```bash
sudo apt install certbot python3-certbot-nginx -y
```

### 4.2 Get SSL certificate
```bash
# Replace your-domain.com with your actual domain
sudo certbot --nginx -d your-domain.com
```

## Step 5: Start the Application

### 5.1 Start with PM2
```bash
# Start the application
npm run pm2:start

# Check status
npm run pm2:status

# View logs
npm run pm2:logs
```

### 5.2 Configure PM2 to start on boot
```bash
# Save PM2 configuration
pm2 save

# Generate startup script
pm2 startup
# Follow the instructions provided by the command above
```

## Step 6: Update Flutter App Configuration

### 6.1 Update Flutter app config
In your Flutter project, update `lib/config/app_config.dart`:

```dart
class AppConfig {
  // Replace with your VPS domain/IP
  static const String backendUrl = String.fromEnvironment(
    'BACKEND_URL',
    defaultValue: 'https://your-domain.com',  // Your VPS domain
  );

  static const String websocketOrigin = String.fromEnvironment(
    'WEBSOCKET_URL',
    defaultValue: 'https://your-domain.com',  // Your VPS domain
  );
  
  // ... rest of the configuration
}
```

### 6.2 Build Flutter app with new backend URL
```bash
# For Android
flutter build apk --dart-define=BACKEND_URL=https://your-domain.com

# For iOS
flutter build ios --dart-define=BACKEND_URL=https://your-domain.com
```

## Step 7: Testing

### 7.1 Test backend health
```bash
curl https://your-domain.com/api/health
```

Expected response:
```json
{
  "status": "OK",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "activeCalls": 0,
  "connectedUsers": 0,
  "serverInfo": {
    "port": 3000,
    "nodeVersion": "v18.x.x",
    "uptime": 123.456,
    "memoryUsage": {...}
  }
}
```

### 7.2 Test WebSocket connection
```bash
# Test Socket.IO endpoint
curl https://your-domain.com/api/socket-test
```

## Step 8: Monitoring and Maintenance

### 8.1 Monitor application
```bash
# Check PM2 status
pm2 status

# View logs
pm2 logs tingatalk-backend

# Monitor system resources
pm2 monit
```

### 8.2 Restart application
```bash
# Restart the application
npm run pm2:restart

# Or stop and start
npm run pm2:stop
npm run pm2:start
```

### 8.3 Update application
```bash
# Pull latest changes
git pull origin main

# Install new dependencies (if any)
npm install

# Restart application
npm run pm2:restart
```

## Troubleshooting

### Common Issues

1. **Port already in use**
   ```bash
   # Check what's using port 3000
   sudo lsof -i :3000
   
   # Kill the process if needed
   sudo kill -9 <PID>
   ```

2. **Nginx configuration errors**
   ```bash
   # Test nginx configuration
   sudo nginx -t
   
   # Check nginx error logs
   sudo tail -f /var/log/nginx/error.log
   ```

3. **PM2 not starting**
   ```bash
   # Check PM2 logs
   pm2 logs tingatalk-backend
   
   # Check if environment variables are loaded
   pm2 show tingatalk-backend
   ```

4. **SSL certificate issues**
   ```bash
   # Check certificate status
   sudo certbot certificates
   
   # Renew certificates
   sudo certbot renew
   ```

### Log Files

- Application logs: `/opt/tingatalk-backend/logs/`
- Nginx logs: `/var/log/nginx/`
- PM2 logs: `~/.pm2/logs/`

## Security Considerations

1. **Firewall**: UFW is configured to only allow necessary ports
2. **SSL/TLS**: Use HTTPS for all communications
3. **Rate Limiting**: Implemented at both Nginx and application level
4. **Environment Variables**: Never commit `.env` file to version control
5. **Regular Updates**: Keep system and dependencies updated

## Performance Optimization

1. **PM2 Clustering**: For high traffic, consider using PM2 cluster mode
2. **Nginx Caching**: Configure static file caching
3. **Database Connection Pooling**: If using external database
4. **CDN**: Use CDN for static assets

## Backup Strategy

1. **Code Backup**: Your code is in Git repository
2. **Environment Backup**: Keep `.env` file backed up securely
3. **SSL Certificates**: Certbot handles automatic renewal
4. **Log Rotation**: Configure log rotation to prevent disk space issues

## Support

If you encounter issues:

1. Check the logs first
2. Verify environment variables
3. Test individual components (Nginx, PM2, Node.js)
4. Check firewall and network connectivity
5. Verify SSL certificate status

For additional help, refer to the main project documentation or create an issue in the repository.
