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
const io = new Server(server, {
  cors: { origin: '*' },
  allowRequest: async (req, callback) => {
    try {
      const token = req._query?.token;
      if (!token) return callback('unauthorized', false);
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.id).select('fullname fullName email role department');
      if (!user) return callback('unauthorized', false);
      req.user = { _id: user._id, fullname: user.fullname || user.fullName, email: user.email, role: user.role, department: user.department };
      callback(null, true);
    } catch (e) {
      return callback('unauthorized', false);
    }
  },
});

global.io = io;

(async () => {
  try {
    await redisClient.connect();
    io.adapter(createAdapter(redisClient.getPubClient(), redisClient.getSubClient()));
  } catch (e) { console.warn('[Social Service] Redis adapter not available:', e.message); }
})();

const corsOptions = {
  origin: (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean).length ? (process.env.ALLOWED_ORIGINS || '').split(',') : ['http://localhost:3000','http://localhost:5173'],
  credentials: true,
};
app.use(cors(corsOptions));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use('/uploads', express.static(uploadPath));

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
// User model is already required above for socket auth

// Socket for newfeed
const NewfeedSocket = require('./utils/newfeedSocket');
const newfeedSocket = new NewfeedSocket(io);
app.set('newfeedSocket', newfeedSocket);

// Routes: mount path mới (/api/social) và giữ path cũ (/api/posts) để tương thích
const postRoutes = require('./routes/postRoutes');
app.use('/api/social', postRoutes);
app.use('/api/posts', postRoutes);

// Start
const PORT = process.env.PORT || 5010;
server.listen(PORT, () => console.log(`🚀 [Social Service] Running on port ${PORT}`));

database.connect().catch((e) => { console.error('DB connect error:', e.message); process.exit(1); });

module.exports = { app, io, server };

