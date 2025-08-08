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

    // Optionally subscribe to user events
    await this.subscribeUserEvents();
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

  async subscribeUserEvents() {
    if (process.env.ENABLE_USER_EVENTS !== 'true') {
      console.log('[Social Service] User events disabled by ENABLE_USER_EVENTS');
      return;
    }
    const userChannel = process.env.REDIS_USER_CHANNEL || 'user_events';
    await this.subClient.subscribe(userChannel, async (message) => {
      try {
        const data = JSON.parse(message);
        if (!data || !data.type) return;
        switch (data.type) {
          case 'user_created':
          case 'user_updated': {
            // Upsert vào local nếu Social cần thông tin user để hiển thị
            // (Có thể dùng models/User.updateFromFrappe nếu cần)
            console.log('[Social Service] user upsert event:', data.user?.email || data.user_id);
            break;
          }
          case 'user_deleted': {
            console.log('[Social Service] user deleted event:', data.user?.email || data.user_id);
            break;
          }
          default:
            break;
        }
      } catch (e) {
        console.warn('[Social Service] Failed handling user event:', e.message);
      }
    });
  }

  getPubClient() { return this.pubClient; }
  getSubClient() { return this.subClient; }
}

module.exports = new RedisClient();

