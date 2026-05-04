const ChatConversation = require('../models/ChatConversation');
const { canAccessConversation } = require('../controllers/chatController');
const {
  getChatBroadcastRooms,
  ioEmitToEachRoom,
} = require('./chatBroadcastRooms');

function normalizeRoomValue(value) {
  return value ? String(value).trim().toLowerCase() : '';
}

function portalGuardianIdFromEmail(email) {
  const normalized = normalizeRoomValue(email);
  const suffix = '@parent.wellspring.edu.vn';
  return normalized.endsWith(suffix) ? normalized.slice(0, -suffix.length) : '';
}

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
      const emailRoom = normalizeRoomValue(socket.user?.email);
      if (emailRoom) socket.join(`email_${emailRoom}`);
      const guardianRoom = normalizeRoomValue(socket.user?.guardian_id);
      if (guardianRoom) socket.join(`guardian_${guardianRoom}`);
      const portalGuardianRoom = portalGuardianIdFromEmail(socket.user?.email);
      if (portalGuardianRoom) socket.join(`guardian_${portalGuardianRoom}`);

      socket.on('chat:join', async ({ conversationId } = {}) => {
        try {
          if (!conversationId || !socket.user) return;
          // Luôn join phòng theo _id chuẩn trong DB — khớp getChatBroadcastRooms (tránh lệch chat_<raw client>).
          const conversation = await ChatConversation.findById(String(conversationId).trim());
          if (!conversation || !canAccessConversation(conversation, socket.user)) {
            console.warn('[ChatSocket] join denied', {
              socketId: socket.id,
              conversationId,
              userId: socket.user?._id,
              email: socket.user?.email,
            });
            return;
          }
          const cid = String(conversation._id);
          socket.join(`chat_${cid}`);
          console.log('[ChatSocket] joined', {
            socketId: socket.id,
            conversationId: cid,
            email: socket.user?.email,
          });
          socket.emit('chat:joined', { conversationId: cid });
        } catch (error) {
          console.error('[ChatSocket] join error:', error.message);
          socket.emit('chat:error', { message: 'Không thể vào nhóm chat' });
        }
      });

      socket.on('chat:leave', async ({ conversationId } = {}) => {
        try {
          if (!conversationId) return;
          const normalized = String(conversationId).trim();
          const conversation = await ChatConversation.findById(normalized).select('_id');
          const cid = conversation ? String(conversation._id) : normalized;
          socket.leave(`chat_${cid}`);
        } catch (error) {
          console.error('[ChatSocket] leave error:', error.message);
        }
      });

      socket.on('chat:typing', async ({ conversationId, isTyping = true } = {}) => {
        try {
          // Log mọi event nhận được để debug đường truyền typing từ mobile -> server -> web.
          console.log('[ChatSocket][typing] recv', {
            socketId: socket.id,
            email: socket.user?.email,
            userId: socket.user?._id,
            guardianId: socket.user?.guardian_id,
            conversationId,
            isTyping,
          });
          if (!conversationId || !socket.user) {
            console.warn('[ChatSocket][typing] skip — missing conversationId/user');
            return;
          }
          const conversation = await ChatConversation.findById(String(conversationId).trim());
          if (!conversation) {
            console.warn('[ChatSocket][typing] skip — conversation not found', { conversationId });
            return;
          }
          if (conversation.status === 'locked') {
            console.warn('[ChatSocket][typing] skip — conversation locked', {
              conversationId: String(conversation._id),
            });
            return;
          }
          if (!canAccessConversation(conversation, socket.user)) {
            console.warn('[ChatSocket][typing] skip — access denied', {
              conversationId: String(conversation._id),
              email: socket.user?.email,
              userId: socket.user?._id,
              guardianId: socket.user?.guardian_id,
            });
            return;
          }
          const cid = String(conversation._id);
          const isGuardianTyping =
            Boolean(normalizeRoomValue(socket.user?.guardian_id)) ||
            Boolean(portalGuardianIdFromEmail(socket.user?.email));
          const rooms = getChatBroadcastRooms(conversation);
          console.log('[ChatSocket][typing] broadcast', {
            conversationId: cid,
            email: socket.user?.email,
            isGuardianTyping,
            isTyping,
            rooms,
          });
          // Payload conversationId thống nhất với REST/socket broadcast để client so khớp selectedId.
          ioEmitToEachRoom(this.io, rooms, 'chat:typing', {
            conversationId: cid,
            userId: String(socket.user._id),
            senderEmail: socket.user.email,
            name: socket.user.fullname || socket.user.fullName || socket.user.email,
            isGuardianTyping,
            isTyping,
          });
        } catch (error) {
          console.error('[ChatSocket][typing] error:', error?.message);
          socket.emit('chat:error', { message: 'Không thể gửi trạng thái đang nhập' });
        }
      });
    });
  }
}

module.exports = ChatSocket;
