const Post = require('../models/Post');
const { signMediaDeep } = require('../services/cdn/signDeep');

class NewfeedSocket {
  constructor(io) {
    this.io = io;
    this.setupEventHandlers();
  }

  setupEventHandlers() {
    this.io.on('connection', (socket) => {
      if (socket.user) {
        socket.join(`user_${socket.user._id}`);
        if (socket.user.department) socket.join(`department_${socket.user.department}`);
      }
    });
  }

  async broadcastNewPost(post) {
    try {
      const populated = await Post.findById(post._id)
        .populate('author', 'fullname avatarUrl email department jobTitle')
        .populate('tags', 'fullname avatarUrl email');
      if (!populated) return;
      // Ký MỘT lần rồi dùng lại cho cả 3 nhánh emit — payload realtime phải đi
      // qua cùng hàm ký với REST, nếu không ảnh bài mới sẽ vỡ (CDN-Design.md §6.4).
      const data = signMediaDeep(populated);
      if (data.visibility === 'public') {
        this.io.emit('new_post', { type: 'post_created', data });
      } else if (data.visibility === 'department' && data.department) {
        this.io.to(`department_${data.department}`).emit('new_post', { type: 'post_created', data });
      }
      if (data.tags?.length) {
        data.tags.forEach(u => this.io.to(`user_${u._id}`).emit('post_tagged', { type: 'tagged_in_post', data }));
      }
    } catch (e) { console.error('[Social Service] broadcastNewPost error:', e.message); }
  }
}

module.exports = NewfeedSocket;

