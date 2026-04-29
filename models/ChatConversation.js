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
}, { _id: false });

const memberSnapshotSchema = new mongoose.Schema({
  email: { type: String, trim: true, lowercase: true },
  name: { type: String, trim: true },
  guardianId: { type: String, trim: true },
  teacherId: { type: String, trim: true },
  studentIds: [{ type: String, trim: true }],
  avatarUrl: { type: String, default: '' },
}, { _id: false });

const chatConversationSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['class_general', 'homeroom_guardians'],
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
    senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdAt: Date,
  },
}, { timestamps: true });

chatConversationSchema.index({ classId: 1, schoolYearId: 1, type: 1 }, { unique: true });
chatConversationSchema.index({ 'participants.user': 1, updatedAt: -1 });
chatConversationSchema.index({ 'participants.email': 1, updatedAt: -1 });
chatConversationSchema.index({ 'participants.guardianId': 1, updatedAt: -1 });

module.exports = mongoose.model('ChatConversation', chatConversationSchema);
