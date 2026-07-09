const mongoose = require('mongoose');

const participantSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  email: { type: String, trim: true, lowercase: true, index: true },
  name: { type: String, trim: true },
  role: { type: String, enum: ['teacher', 'guardian'], required: true },
  guardianId: { type: String, trim: true, index: true },
  teacherId: { type: String, trim: true, index: true },
  studentIds: [{ type: String, trim: true }],
  avatarUrl: { type: String, default: '' },
  /**
   * Soft-remove khi rời roster (sync membership). null/absent = đang active.
   * Chỉ flow sync (scope authoritative) được set; read-path không tự revoke.
   */
  removedAt: { type: Date, default: null },
  removedReason: { type: String, trim: true }, // 'roster_sync' | 'manual'
  /**
   * GVBM được GVCN/phó add thủ công vào nhóm lớp (GVBM không auto-join).
   * Sync giữ participant này chừng nào còn phân công giảng dạy với lớp.
   */
  manualAdd: { type: Boolean, default: false },
  addedBy: { type: String, trim: true, lowercase: true }, // email GVCN/phó đã add
}, { _id: false });

const memberSnapshotSchema = new mongoose.Schema({
  email: { type: String, trim: true, lowercase: true },
  name: { type: String, trim: true },
  guardianId: { type: String, trim: true },
  teacherId: { type: String, trim: true },
  studentIds: [{ type: String, trim: true }],
  /** Tên HS gắn PH — phục vụ subtitle "Phụ huynh của …" (workspace GV). */
  studentNames: [{ type: String, trim: true }],
  /** Môn dạy (GVBM) — app PH hiển thị "Giáo viên môn …". */
  subjects: [{
    id: { type: String, trim: true },
    title: { type: String, trim: true },
  }],
  avatarUrl: { type: String, default: '' },
  /** Soft-remove khi rời roster — đồng bộ với participant tương ứng. */
  removedAt: { type: Date, default: null },
  /** GVBM add thủ công (đồng bộ với participant.manualAdd) — FE phân biệt với CN/phó. */
  manualAdd: { type: Boolean, default: false },
}, { _id: false });

/** Snapshot tin ghim (1 conversation tối đa 1 tin) — hiển thị banner, đồng bộ socket. */
const pinnedMessageSchema = new mongoose.Schema({
  messageId: { type: mongoose.Schema.Types.ObjectId, ref: 'ChatMessage' },
  contentPreview: { type: String, default: '' },
  attachmentsCount: { type: Number, default: 0 },
  senderName: { type: String, default: '' },
  senderEmail: { type: String, trim: true, lowercase: true, default: '' },
  avatarUrl: { type: String, default: '' },
  pinnedBy: { type: String, trim: true, lowercase: true, default: '' },
  pinnedAt: { type: Date, default: Date.now },
}, { _id: false });

const chatConversationSchema = new mongoose.Schema({
  type: {
    type: String,
    required: true,
    index: true,
  },
  title: { type: String, required: true, trim: true },
  classId: { type: String, required: true, trim: true, index: true },
  className: { type: String, required: true, trim: true },
  schoolYearId: { type: String, required: true, trim: true, index: true },
  schoolYearName: { type: String, trim: true },
  status: { type: String, enum: ['active', 'locked'], default: 'active', index: true },
  lockedReason: { type: String, trim: true },
  participants: [participantSchema],
  studentIds: [{ type: String, trim: true, index: true }],
  guardians: [memberSnapshotSchema],
  teachers: [memberSnapshotSchema],
  unreadCounts: { type: Map, of: Number, default: {} },
  lastMessage: {
    messageId: { type: mongoose.Schema.Types.ObjectId, ref: 'ChatMessage' },
    content: String,
    senderName: String,
    senderEmail: { type: String, trim: true, lowercase: true },
    senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdAt: Date,
  },
  pinnedMessage: { type: pinnedMessageSchema, default: null },
  /**
   * Ẩn khỏi danh sách (soft) — key = participantKey(User) = String(user._id).
   * Tin mới trong hội thoại luôn gỡ ẩn cho người nhận (không gồm người gửi).
   */
  hiddenFromListAtByUserId: { type: Map, of: Date, default: {} },
  /** Lần cuối flow sync membership (roster) chạy trên conversation này. */
  membershipSyncedAt: { type: Date },
}, { timestamps: true });

chatConversationSchema.index({ classId: 1, schoolYearId: 1, type: 1 }, { unique: true });
/** Sort danh sách chat theo hoạt động cuối (sau unread-priority trong app). */
chatConversationSchema.index({ 'lastMessage.createdAt': -1 });
chatConversationSchema.index({ 'participants.user': 1, updatedAt: -1 });
chatConversationSchema.index({ 'participants.email': 1, updatedAt: -1 });
chatConversationSchema.index({ 'participants.guardianId': 1, updatedAt: -1 });

module.exports = mongoose.model('ChatConversation', chatConversationSchema);
