const Post = require('../models/Post');

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
      if (populated.visibility === 'public') {
        this.io.emit('new_post', { type: 'post_created', data: populated });
      } else if (populated.visibility === 'department' && populated.department) {
        this.io.to(`department_${populated.department}`).emit('new_post', { type: 'post_created', data: populated });
      }
      if (populated.tags?.length) {
        populated.tags.forEach(u => this.io.to(`user_${u._id}`).emit('post_tagged', { type: 'tagged_in_post', data: populated }));
      }
    } catch (e) { console.error('[Social Service] broadcastNewPost error:', e.message); }
  }
}

module.exports = NewfeedSocket;

