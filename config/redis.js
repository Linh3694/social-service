const { createClient } = require('redis');

class RedisClient {
  constructor() {
    this.client = null;
    this.pubClient = null;
    this.subClient = null;
  }

  async connect() {
    this.client = createClient({
      socket: { host: process.env.REDIS_HOST, port: process.env.REDIS_PORT },
      password: process.env.REDIS_PASSWORD || undefined,
    });
    this.pubClient = createClient({
      socket: { host: process.env.REDIS_HOST, port: process.env.REDIS_PORT },
      password: process.env.REDIS_PASSWORD || undefined,
    });
    this.subClient = this.pubClient.duplicate();

    this.client.on('error', (err) => console.error('[Social Service] Redis error:', err.message));
    this.pubClient.on('error', (err) => console.error('[Social Service] Redis pub error:', err.message));
    this.subClient.on('error', (err) => console.error('[Social Service] Redis sub error:', err.message));

    await this.client.connect();
    await this.pubClient.connect();
    await this.subClient.connect();
    console.log('✅ [Social Service] Redis connected');
  }

  async publishToNotification(event, data) {
    const channel = process.env.REDIS_NOTIFICATION_CHANNEL || 'notification-service';
    const message = {
      service: 'social-service',
      event,
      data,
      timestamp: new Date().toISOString(),
    };
    await this.pubClient.publish(channel, JSON.stringify(message));
  }

  getPubClient() { return this.pubClient; }
  getSubClient() { return this.subClient; }
}

module.exports = new RedisClient();

