const mongoose = require('mongoose');

const reactionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  type: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
}, { _id: false });

const postCommentSchema = new mongoose.Schema({
  post: { type: mongoose.Schema.Types.ObjectId, ref: 'Post', required: true, index: true },
  /** Khớp `_id` subdocument trong `Post.comments` (dual-write). */
  legacyCommentId: { type: mongoose.Schema.Types.ObjectId, index: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  content: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  reactions: { type: [reactionSchema], default: [] },
  parentComment: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
  isDeleted: { type: Boolean, default: false, index: true },
}, { timestamps: true });

postCommentSchema.index({ post: 1, createdAt: -1 });
postCommentSchema.index({ post: 1, parentComment: 1, createdAt: -1 });

module.exports = mongoose.model('PostComment', postCommentSchema);
