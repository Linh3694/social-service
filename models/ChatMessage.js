const mongoose = require('mongoose');

const senderSnapshotSchema = new mongoose.Schema({
  name: { type: String, trim: true },
  email: { type: String, trim: true, lowercase: true },
  role: { type: String, enum: ['teacher', 'guardian'], required: true },
  avatarUrl: { type: String, default: '' },
}, { _id: false });

const replySnapshotSchema = new mongoose.Schema({
  messageId: { type: mongoose.Schema.Types.ObjectId, ref: 'ChatMessage' },
  content: { type: String, trim: true },
  senderName: { type: String, trim: true },
}, { _id: false });

const readReceiptSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  readAt: { type: Date, default: Date.now },
}, { _id: false });

/** Một reaction trên tin nhắn — mỗi user tối đa một bản ghi trong mảng. */
const reactionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  email: { type: String, trim: true, lowercase: true, default: '' },
  name: { type: String, trim: true, default: '' },
  emoji: { type: String, required: true, trim: true },
  createdAt: { type: Date, default: Date.now },
}, { _id: false });

/** File/ảnh/video đính kèm (URL phục vụ từ /uploads/chat/). */
const attachmentSchema = new mongoose.Schema({
  kind: { type: String, enum: ['image', 'file', 'video'], required: true },
  url: { type: String, required: true, trim: true },
  name: { type: String, default: '', trim: true },
  mimeType: { type: String, default: '', trim: true },
  size: { type: Number, default: 0 },
  width: { type: Number },
  height: { type: Number },
  /**
   * Khoá `cdn://` của ảnh poster video (SIS-174). Chỉ có với kind='video'.
   * Phải lưu thành giá trị riêng chứ không để client tự suy: URL ra ngoài là URL
   * đã ký theo từng path, client nối `_poster.webp` vào là chữ ký sai (403).
   */
  posterUrl: { type: String, default: '', trim: true },
  /**
   * Khoá `cdn://` của bản thu nhỏ 480px (chỉ với kind='image').
   *
   * Rỗng khi không chắc có biến thể — client thấy rỗng thì dùng ảnh đầy đủ. Cùng
   * lý do với `posterUrl`: client không tự suy khoá được vì URL đã ký theo path.
   */
  thumbUrl: { type: String, default: '', trim: true },
}, { _id: false });

/** Một phương án của bình chọn. `id` do server sinh ('o1','o2'…) và ổn định suốt đời poll. */
const pollOptionSchema = new mongoose.Schema({
  id: { type: String, required: true },
  text: { type: String, required: true, trim: true, maxlength: 200 },
}, { _id: false });

/** Một lá phiếu — mỗi (user, optionId) một bản ghi; chọn nhiều ⇒ nhiều bản ghi cùng user. */
const pollVoteSchema = new mongoose.Schema({
  optionId: { type: String, required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  email: { type: String, trim: true, lowercase: true, default: '' },
  name: { type: String, trim: true, default: '' },
  role: { type: String, enum: ['teacher', 'guardian'], default: 'guardian' },
  avatarUrl: { type: String, default: '' },
  votedAt: { type: Date, default: Date.now },
}, { _id: false });

/**
 * Bình chọn kiểu Zalo, nhúng trong tin nhắn nhóm lớp.
 * `votes` LUÔN lưu đủ danh tính — `anonymous` chỉ là quy tắc SERIALIZE (ẩn với phụ huynh,
 * giáo viên vẫn xem được ai bầu gì). Xem pollPayloadForViewer trong chatController.
 * `closedAt` chỉ ghi khi kết thúc sớm thủ công; hết `closesAt` được tính lười lúc đọc/bỏ phiếu.
 */
const pollSchema = new mongoose.Schema({
  question: { type: String, required: true, trim: true, maxlength: 500 },
  options: { type: [pollOptionSchema], required: true },
  allowMultiple: { type: Boolean, default: false },
  anonymous: { type: Boolean, default: false },
  /** null = mở tới khi người tạo/GVCN bấm kết thúc. */
  closesAt: { type: Date, default: null },
  closedAt: { type: Date, default: null },
  closedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  /** Số phút nhắc trước hạn (vd 10). null = không nhắc. Chỉ đặt được khi có `closesAt`. */
  remindBeforeMinutes: { type: Number, default: null },
  /**
   * Mốc bắn nhắc = `closesAt - remindBeforeMinutes` phút, tính sẵn lúc tạo để scheduler quét
   * bằng range query có index (thay vì $expr không dùng được index).
   */
  remindAt: { type: Date, default: null },
  /** Đã bắn nhắc chưa — scheduler set bằng update nguyên tử để không bắn trùng. */
  remindedAt: { type: Date, default: null },
  /** Đã bắn thông báo kết thúc chưa (kết thúc sớm hoặc hết hạn). */
  closeNotifiedAt: { type: Date, default: null },
  votes: { type: [pollVoteSchema], default: [] },
  /** Tăng mỗi lần bỏ phiếu/kết thúc — client dùng để bỏ broadcast đến trễ. */
  rev: { type: Number, default: 0 },
}, { _id: false });

const chatMessageSchema = new mongoose.Schema({
  conversation: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ChatConversation',
    required: true,
    index: true,
  },
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  senderSnapshot: senderSnapshotSchema,
  /** Tin chỉ đính kèm cho phép để trống — kiểm tra ở controller. */
  content: { type: String, default: '', trim: true, maxlength: 5000 },
  attachments: {
    type: [attachmentSchema],
    default: [],
  },
  replyTo: replySnapshotSchema,
  readBy: [readReceiptSchema],
  reactions: [reactionSchema],
  /** Tin bình chọn — null với tin thường. `content` vẫn giữ "[Bình chọn] <câu hỏi>" để suy biến. */
  poll: { type: pollSchema, default: null },
  /** Tin đã thu hồi — FE hiển thị placeholder; `content` giữ nguyên để audit. */
  recalledAt: { type: Date, default: null },
  recalledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  isDeleted: { type: Boolean, default: false },
}, { timestamps: true });

chatMessageSchema.index({ conversation: 1, createdAt: -1 });
/** Tin theo hội thoại — lọc isDeleted giống getMessages */
chatMessageSchema.index({ conversation: 1, isDeleted: 1, createdAt: -1 });
/** markRead: updateMany readBy.user $ne */
chatMessageSchema.index({ conversation: 1, 'readBy.user': 1 });
/** Tìm reaction theo user trong một tin (toggle nhanh). */
chatMessageSchema.index({ 'reactions.user': 1 });
/**
 * Hàng đợi job của bình chọn — partial index nên CHỈ chứa tin poll có hạn, không đụng tới
 * hàng chục nghìn tin thường. Scheduler quét mỗi phút bằng range query trên hai index này.
 */
chatMessageSchema.index(
  { 'poll.remindAt': 1 },
  { partialFilterExpression: { 'poll.remindAt': { $type: 'date' } } },
);
chatMessageSchema.index(
  { 'poll.closesAt': 1 },
  { partialFilterExpression: { 'poll.closesAt': { $type: 'date' } } },
);

module.exports = mongoose.model('ChatMessage', chatMessageSchema);
