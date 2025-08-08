const mongoose = require('mongoose');

const reactionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  type: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

const commentSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  content: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  reactions: [reactionSchema],
  parentComment: { type: mongoose.Schema.Types.ObjectId, default: null },
  replies: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Comment' }],
  isDeleted: { type: Boolean, default: false },
});

const postSchema = new mongoose.Schema(
  {
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    content: { type: String, required: true },
    images: [{ type: String }],
    videos: [{ type: String }],
    type: { type: String, enum: ['Thông báo', 'Chia sẻ', 'Câu hỏi', 'Badge', 'Khác'], default: 'Chia sẻ' },
    visibility: { type: String, enum: ['public', 'department'], default: 'public' },
    department: { type: String },
    tags: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    badgeInfo: { badgeName: String, badgeIcon: String, message: String },
    isPinned: { type: Boolean, default: false },
    comments: [commentSchema],
    reactions: [reactionSchema],
  },
  { timestamps: true }
);

module.exports = mongoose.model('Post', postSchema);

