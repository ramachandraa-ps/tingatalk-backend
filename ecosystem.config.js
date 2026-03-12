module.exports = {
  apps: [{
    name: 'tingatalk-backend',
    script: 'src/server.js',
    instances: 1,  // 🔥 FIX: Single instance for WebSocket compatibility
    exec_mode: 'fork',  // 🔥 FIX: Fork mode (not cluster) for Socket.IO
    env: {
      NODE_ENV: 'development',
      PORT: 3000
    },
    env_production: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    // PM2 Configuration
    max_memory_restart: "2G",
    node_args: '--max-old-space-size=2048',
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_file: './logs/combined.log',
    time: true,
    // Auto restart on crash
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
    // Watch for changes (development only)
    watch: false,
    ignore_watch: ['node_modules', 'logs'],
    // Health monitoring
    health_check_grace_period: 3000,
    // Process management
    kill_timeout: 5000,
    wait_ready: false,  // ✅ CHANGED: Disable for cluster mode
    listen_timeout: 10000,
    // ✅ NEW: Cluster mode specific settings
    instance_var: 'INSTANCE_ID',
    merge_logs: true
  }]
};
