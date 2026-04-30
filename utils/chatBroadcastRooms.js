/**
 * Phòng Socket.IO dùng cho chat (một nguồn sự thật cho emitToConversation + chat:typing).
 * Phải khớp phép join khi connection (email_*, guardian_*, user_*, chat_*).
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
 * Phát từng room — union rõ ràng (redis-adapter + io.to([a,b]) có thể sót client).
 * Client chat đã upsert theo _id nên trùng event cùng tin nhắn là an toàn.
 *
 * @param {import('socket.io').Server} io
 * @param {string[]} rooms
 * @param {string} event
 * @param {unknown} payload
 */
function ioEmitToEachRoom(io, rooms, event, payload) {
  if (!io || !rooms.length) return;
  rooms.forEach((room) => {
    io.to(room).emit(event, payload);
  });
}

/**
 * Tin typing: emitter không nhận lại; phát từng room (giống socket.to(room).emit lặp).
 *
 * @param {import('socket.io').Socket} socket
 * @param {string[]} rooms
 * @param {string} event
 * @param {unknown} payload
 */
function socketEmitToEachRoomExceptSender(socket, rooms, event, payload) {
  if (!socket || !rooms.length) return;
  rooms.forEach((room) => {
    socket.to(room).emit(event, payload);
  });
}

module.exports = {
  getChatBroadcastRooms,
  ioEmitToEachRoom,
  socketEmitToEachRoomExceptSender,
};
