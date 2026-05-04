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
  /** Tin đã thu hồi — FE hiển thị placeholder; `content` giữ nguyên để audit. */
  recalledAt: { type: Date, default: null },
  recalledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  isDeleted: { type: Boolean, default: false },
}, { timestamps: true });

chatMessageSchema.index({ conversation: 1, createdAt: -1 });
/** Tìm reaction theo user trong một tin (toggle nhanh). */
chatMessageSchema.index({ 'reactions.user': 1 });

module.exports = mongoose.model('ChatMessage', chatMessageSchema);
