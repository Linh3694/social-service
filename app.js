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

// Global safety nets to avoid worker crash
process.on('unhandledRejection', (reason) => {
  console.error('[Social Service] Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Social Service] Uncaught Exception:', err);
});

const app = express();
const server = http.createServer(app);

const uploadPath = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadPath)) fs.mkdirSync(uploadPath, { recursive: true });

const jwt = require('jsonwebtoken');
const User = require('./models/User');
const frappeService = require('./services/frappeService');
async function resolveSocketUser(token) {
  let decoded = null;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET || 'breakpoint');
  } catch {
    decoded = jwt.verify(token, process.env.PARENT_PORTAL_JWT_SECRET || process.env.JWT_SECRET || 'breakpoint');
  }
  const userEmail = decoded.sub || decoded.email;
  let user = null;
  if (userEmail) {
    user = await User.findOne({ email: userEmail }).select('fullname fullName email role roles department avatarUrl user_image sis_photo guardian_image guardian_id');
  }
  if (!user && decoded.id) {
    user = await User.findById(decoded.id).select('fullname fullName email role roles department avatarUrl user_image sis_photo guardian_image guardian_id');
  }
  if (!user && decoded.guardian) {
    const frappeUser = await frappeService.authenticateParentGuardian(token);
    user = await User.updateFromFrappe(frappeUser);
  }
  return user;
}

const io = new Server(server, {
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
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With', 'X-Frappe-Token', 'X-Frappe-CSRF-Token'],
};
app.use(cors(corsOptions));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
// Static uploads: expose under both /uploads and /api/social/uploads to work behind reverse proxy
app.use('/uploads', express.static(uploadPath));
app.use('/api/social/uploads', express.static(uploadPath));

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

// Chat routes phải mount trước postRoutes để /chat không bị bắt bởi /:postId
app.use('/api/social/chat', chatRoutes);
// Post routes
app.use('/api/social', postRoutes);
app.use('/api/posts', postRoutes);

// User sync routes - đồng bộ user từ Frappe
app.use('/api/social/user', userRoutes);

// Start
const PORT = process.env.PORT || 5010;
server.listen(PORT, () => console.log(`🚀 [Social Service] Running on port ${PORT}`));

database.connect().catch((e) => { console.error('DB connect error:', e.message); process.exit(1); });

module.exports = { app, io, server };

