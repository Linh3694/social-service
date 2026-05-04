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
 * Phát một event tới tập room — mỗi socket chỉ nhận một lần dù nằm trong nhiều room.
 *
 * Trước đây lặp `io.to(room).emit` từng room khiến client join `user_*` + `email_*` + `guardian_*`
 * nhận trùng `chat:message` (unread +2 mỗi tin).
 *
 * @param {import('socket.io').Server} io
 * @param {string[]} rooms
 * @param {string} event
 * @param {unknown} payload
 */
function ioEmitToEachRoom(io, rooms, event, payload) {
  if (!io || !rooms.length) return;
  const uniqueRooms = Array.from(new Set(rooms));
  io.to(uniqueRooms).emit(event, payload);
}

/**
 * Typing: broadcast tới các room, mỗi subscriber chỉ nhận một lần (trừ emitter xử lý riêng).
 *
 * @param {import('socket.io').Socket} socket
 * @param {string[]} rooms
 * @param {string} event
 * @param {unknown} payload
 */
function socketEmitToEachRoomExceptSender(socket, rooms, event, payload) {
  if (!socket || !rooms.length) return;
  const uniqueRooms = Array.from(new Set(rooms));
  socket.to(uniqueRooms).emit(event, payload);
}

module.exports = {
  getChatBroadcastRooms,
  ioEmitToEachRoom,
  socketEmitToEachRoomExceptSender,
};
