const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: './config.env' });

const database = require('./config/database');
const redisClient = require('./config/redis');
// Phải require SAU dotenv ở trên — config CDN đọc process.env một lần lúc nạp module.
const { config: cdnConfig } = require('./services/cdn/config');

// Global safety nets to avoid worker crash
process.on('unhandledRejection', (reason) => {
  console.error('[Social Service] Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Social Service] Uncaught Exception:', err);
});

const app = express();
try {
	const { initObservability } = require('@wis/observability');
	initObservability({ expressApp: app, serviceName: 'social-service' });
} catch (e) {
	console.warn('[social-service] @wis/observability:', e.message);
}
const server = http.createServer(app);

const uploadPath = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadPath)) fs.mkdirSync(uploadPath, { recursive: true });

const { resolveSocketUser } = require('./utils/authResolve');

const io = new Server(server, {
  path: '/api/social/socket.io',
  cors: { origin: '*' },
  allowRequest: async (req, callback) => {
    try {
      const token = req._query?.token;
      if (!token) return callback('unauthorized', false);
      const user = await resolveSocketUser(token);
      if (!user) return callback('unauthorized', false);
      req.user = user;
      callback(null, true);
    } catch (e) {
      return callback('unauthorized', false);
    }
  },
});

global.io = io;

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) return next(new Error('unauthorized'));
    const user = await resolveSocketUser(token);
    if (!user) return next(new Error('unauthorized'));
    socket.user = {
      _id: user._id,
      fullname: user.fullname || user.fullName,
      fullName: user.fullName,
      email: user.email,
      role: user.role,
      roles: user.roles || [],
      department: user.department,
      avatarUrl: user.avatarUrl,
      user_image: user.user_image,
      sis_photo: user.sis_photo,
      guardian_image: user.guardian_image,
      guardian_id: user.guardian_id,
    };
    next();
  } catch (error) {
    next(new Error('unauthorized'));
  }
});

(async () => {
  try {
    await redisClient.connect();
    io.adapter(createAdapter(redisClient.getPubClient(), redisClient.getSubClient()));
  } catch (e) { console.warn('[Social Service] Redis adapter not available:', e.message); }
})();

// CORS Configuration
// Hỗ trợ: WIS frontend, Parent Portal, Workspace Mobile (via nginx proxy)
const corsOptions = {
  origin: (process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean).length ? 
    (process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean) : 
    [
      'http://localhost:3000',
      'http://localhost:5173',
      'https://wis.wellspring.edu.vn',
      'https://wis-staging.wellspring.edu.vn',
      'https://parentportal.wellspring.edu.vn',
      'https://parentportal-staging.wellspring.edu.vn',
      'https://admin.sis.wellspring.edu.vn'
    ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With', 'X-Frappe-Token', 'X-Frappe-CSRF-Token', 'X-Campus-Id'],
};
app.use(cors(corsOptions));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
// Static uploads — dữ liệu CŨ trên đĩa.
//
// Khi CDN bật: guard bắt buộc token (lỗ hổng P3 — trước đây ai có URL cũng tải
// được ảnh chat GV↔PH). Client bình thường không đi đường này nữa vì đã nhận URL
// CDN đã ký; mount chỉ còn là lưới an toàn cho client giữ cache cũ.
//
// Khi CDN tắt: guard cho qua thẳng, `/uploads` LÀ nguồn phục vụ chính thức —
// đường rollback (§11) phải chạy y như cũ.
//
// Chỉ gỡ hẳn mount ở Phase 4, khi legacyUploadsGuard.stats.allowed ngừng tăng
// (CDN-Design.md §9 Bước 5).
const staticUploadsOptions = {
  setHeaders(res) {
    // `public` chỉ đúng khi không có guard. Có guard ⇒ nội dung đã xác thực,
    // proxy dùng chung tuyệt đối không được cache hộ. Guard đã set `private`
    // trước đó; ở đây chỉ set khi CDN tắt để giữ nguyên hành vi cũ.
    if (!cdnConfig.enabled) {
      res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    }
  },
};
const legacyUploadsGuard = require('./middleware/legacyUploadsGuard');
const staticUploads = express.static(uploadPath, staticUploadsOptions);
app.use('/uploads', legacyUploadsGuard, staticUploads);
app.use('/api/social/uploads', legacyUploadsGuard, staticUploads);

// Ký media cho mọi response REST — phải đứng TRƯỚC khi mount routes.
app.use(require('./middleware/cdnSignResponse'));
require('./services/cdn').logStartupState();

app.use((req, res, next) => {
  res.setHeader('X-Service', 'social-service');
  next();
});

// Health
app.get('/health', async (req, res) => {
  res.json({ status: 'ok', service: 'social-service', timestamp: new Date().toISOString() });
});

// Models (ensure registered)
require('./models/Post');
require('./models/PostComment');
require('./models/ChatConversation');
require('./models/ChatMessage');
// User model is already required above for socket auth

// Socket for newfeed
const NewfeedSocket = require('./utils/newfeedSocket');
const newfeedSocket = new NewfeedSocket(io);
app.set('newfeedSocket', newfeedSocket);
const ChatSocket = require('./utils/chatSocket');
const chatSocket = new ChatSocket(io);
app.set('chatSocket', chatSocket);

// Routes: mount path mới (/api/social) và giữ path cũ (/api/posts) để tương thích
const postRoutes = require('./routes/postRoutes');
const userRoutes = require('./routes/userRoutes');
const chatRoutes = require('./routes/chatRoutes');
const mediaRoutes = require('./routes/mediaRoutes');

// Chat routes phải mount trước postRoutes để /chat không bị bắt bởi /:postId
app.use('/api/social/chat', chatRoutes);
// Upload trực tiếp lên CDN (Phase 3) — cũng phải đứng trước postRoutes
app.use('/api/social/media', mediaRoutes);
// Post routes
app.use('/api/social', postRoutes);
app.use('/api/posts', postRoutes);

// User sync routes - đồng bộ user từ Frappe
app.use('/api/social/user', userRoutes);

// Start
const PORT = process.env.PORT || 5010;
server.listen(PORT, () => console.log(`🚀 [Social Service] Running on port ${PORT}`));

const { startPollScheduler } = require('./services/pollScheduler');
const { startTranscodeScheduler } = require('./services/transcodeScheduler');

database.connect()
  .then(() => {
    // Lịch bình chọn (nhắc trước hạn + báo hết hạn) chạy in-process vì cần global.io để
    // broadcast socket — PM2 cron ở ecosystem-cron.config.js không có io.
    // try/catch riêng: lỗi ở scheduler KHÔNG được rơi vào catch của connect bên dưới,
    // nếu không sẽ process.exit(1) và giết cả service chỉ vì một job phụ.
    try {
      startPollScheduler();
    } catch (e) {
      console.error('[PollScheduler] không khởi động được:', e.message);
    }
    // Transcode video HEVC → H.264 (SIS-174) — cũng in-process vì cùng lý do: xong
    // job phải đẩy socket cho người đang mở hội thoại.
    try {
      startTranscodeScheduler();
    } catch (e) {
      console.error('[Transcode] không khởi động được:', e.message);
    }
  })
  .catch((e) => { console.error('DB connect error:', e.message); process.exit(1); });

module.exports = { app, io, server };

