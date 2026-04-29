const ChatConversation = require('../models/ChatConversation');
const { canAccessConversation } = require('../controllers/chatController');

class ChatSocket {
  constructor(io) {
    this.io = io;
    this.setupEventHandlers();
  }

  setupEventHandlers() {
    this.io.on('connection', (socket) => {
      console.log('[ChatSocket] connected', {
        socketId: socket.id,
        userId: socket.user?._id,
        email: socket.user?.email,
      });
      if (socket.user?._id) {
        socket.join(`user_${socket.user._id}`);
      }

      socket.on('chat:join', async ({ conversationId } = {}) => {
        try {
          if (!conversationId || !socket.user) return;
          const conversation = await ChatConversation.findById(conversationId);
          if (!conversation || !canAccessConversation(conversation, socket.user)) {
            console.warn('[ChatSocket] join denied', {
              socketId: socket.id,
              conversationId,
              userId: socket.user?._id,
              email: socket.user?.email,
            });
            return;
          }
          socket.join(`chat_${conversationId}`);
          console.log('[ChatSocket] joined', {
            socketId: socket.id,
            conversationId,
            email: socket.user?.email,
          });
          socket.emit('chat:joined', { conversationId });
        } catch (error) {
          console.error('[ChatSocket] join error:', error.message);
          socket.emit('chat:error', { message: 'Không thể vào nhóm chat' });
        }
      });

      socket.on('chat:leave', ({ conversationId } = {}) => {
        if (conversationId) socket.leave(`chat_${conversationId}`);
      });

      socket.on('chat:typing', async ({ conversationId, isTyping = true } = {}) => {
        try {
          if (!conversationId || !socket.user) return;
          const conversation = await ChatConversation.findById(conversationId);
          if (!conversation || conversation.status === 'locked' || !canAccessConversation(conversation, socket.user)) return;
          socket.to(`chat_${conversationId}`).emit('chat:typing', {
            conversationId,
            userId: String(socket.user._id),
            name: socket.user.fullname || socket.user.fullName || socket.user.email,
            isTyping,
          });
        } catch (error) {
          socket.emit('chat:error', { message: 'Không thể gửi trạng thái đang nhập' });
        }
      });
    });
  }
}

module.exports = ChatSocket;
