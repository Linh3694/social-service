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

const chatMessageSchema = new mongoose.Schema({
  conversation: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ChatConversation',
    required: true,
    index: true,
  },
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  senderSnapshot: senderSnapshotSchema,
  content: { type: String, required: true, trim: true, maxlength: 5000 },
  replyTo: replySnapshotSchema,
  readBy: [readReceiptSchema],
  isDeleted: { type: Boolean, default: false },
}, { timestamps: true });

chatMessageSchema.index({ conversation: 1, createdAt: -1 });

module.exports = mongoose.model('ChatMessage', chatMessageSchema);
