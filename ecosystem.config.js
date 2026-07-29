module.exports = {
  apps: [{
    name: 'social-service',
    script: 'app.js',
    instances: 1,
    instance_var: 'INSTANCE_ID',
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'development',
      // 5040 chu khong phai 5010: upstream nginx tro vao 5040 va PM2 tren prod
      // dang giu gia tri do tu lan khoi dong cu. File nay ghi 5010 la mot qua
      // min — `pm2 restart --update-env` se doc khoi `env` nay va day service
      // sang 5010, lam no rung khoi upstream.
      PORT: 5040,
      SERVICE_NAME: 'social-service',
      LOG_LEVEL: 'debug'
    },
    env_production: {
      NODE_ENV: 'production',
      PORT: 5040,
      SERVICE_NAME: 'social-service',
      LOG_LEVEL: 'info'
    },
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    log_file: './logs/combined.log',
    time: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    max_restarts: 10,
    min_uptime: '10s',
    restart_delay: 4000,
    kill_timeout: 5000,
    listen_timeout: 8000,
    shutdown_with_message: true
  }]
}; 