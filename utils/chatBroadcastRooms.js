/**
 * Phòng Socket.IO dùng cho chat (một nguồn sự thật cho emitToConversation + chat:typing).
 * Phải khớp với phép join khi connection (email_*, guardian_*, user_*, chat_*).
 */

function normalizeEmail(value) {
  return value ? String(value).trim().toLowerCase() : '';
}

function normalizeId(value) {
  return value ? String(value).trim() : '';
}

/**
 * @param {import('mongoose').Document | object} conversation
 * @returns {string[]}
 */
function getChatBroadcastRooms(conversation) {
  const conversationId = String(conversation?._id || conversation || '');
  const participantRooms = (conversation?.participants || []).flatMap((participant) => ([
    participant.user && `user_${participant.user}`,
    participant.email && `email_${normalizeEmail(participant.email)}`,
    participant.guardianId && `guardian_${normalizeId(participant.guardianId).toLowerCase()}`,
  ])).filter(Boolean);
  return [`chat_${conversationId}`, ...participantRooms];
}

/**
 * Socket.IO v4 + redis-adapter: io.to([a,b]) đôi khi lệch; chuỗi .to(a).to(b)… phát union ổn định hơn.
 * @param {import('socket.io').Server} io
 * @param {string[]} rooms
 * @param {string} event
 * @param {unknown} payload
 */
function ioEmitToRoomsUnion(io, rooms, event, payload) {
  if (!io || !rooms.length) return;
  let op = io;
  rooms.forEach((room) => {
    op = op.to(room);
  });
  op.emit(event, payload);
}

/**
 * Emitter socket: broadcast tới union room nhưng không gửi lại chính socket (giống socket.to).
 * @param {import('socket.io').Socket} socket
 * @param {string[]} rooms
 * @param {string} event
 * @param {unknown} payload
 */
function socketEmitToRoomsUnionExceptSender(socket, rooms, event, payload) {
  if (!socket || !rooms.length) return;
  let op = socket;
  rooms.forEach((room) => {
    op = op.to(room);
  });
  op.emit(event, payload);
}

module.exports = {
  getChatBroadcastRooms,
  ioEmitToRoomsUnion,
  socketEmitToRoomsUnionExceptSender,
};
