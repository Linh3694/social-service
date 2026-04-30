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

function portalGuardianIdFromEmail(email) {
  const normalized = normalizeEmail(email);
  const suffix = '@parent.wellspring.edu.vn';
  return normalized.endsWith(suffix) ? normalized.slice(0, -suffix.length) : '';
}

function parentPortalEmailFromGuardianId(guardianId) {
  const normalized = normalizeId(guardianId).toLowerCase();
  return normalized ? `${normalized}@parent.wellspring.edu.vn` : '';
}

function participantRooms(participant) {
  const rooms = [];
  if (participant.user) rooms.push(`user_${participant.user}`);

  const email = normalizeEmail(participant.email);
  if (email) {
    rooms.push(`email_${email}`);
    const portalGuardianId = portalGuardianIdFromEmail(email);
    if (portalGuardianId) rooms.push(`guardian_${portalGuardianId}`);
  }

  const guardianId = normalizeId(participant.guardianId).toLowerCase();
  if (guardianId) {
    rooms.push(`guardian_${guardianId}`);
    rooms.push(`email_${parentPortalEmailFromGuardianId(guardianId)}`);
  }

  return rooms;
}

/**
 * @param {import('mongoose').Document | object} conversation
 * @returns {string[]}
 */
function getChatBroadcastRooms(conversation) {
  const conversationId = String(conversation?._id || conversation || '');
  const rooms = [
    `chat_${conversationId}`,
    ...(conversation?.participants || []).flatMap(participantRooms),
  ].filter(Boolean);
  return Array.from(new Set(rooms));
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
