const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Post = require('../models/Post');
const User = require('../models/User');
const PostService = require('../services/postService');
const redisClient = require('../config/redis');

async function notify(event, data) {
  try { await redisClient.publishToNotification(event, data); } catch (e) { console.error('[Social Service] notify error:', e.message); }
}

exports.createPost = async (req, res) => {
  try {
    const { content, type = 'Chia sẻ', visibility = 'public', department, tags = [], badgeInfo } = req.body;
    // Bảo vệ khi req.user chưa đầy đủ (trường hợp GET pass-through không áp dụng cho POST)
    if (!req.user || !req.user._id) {
      return res.status(401).json({ success: false, message: 'Unauthorized - Missing user context' });
    }
    const authorId = req.user._id;
    if (!content || content.trim() === '') return res.status(400).json({ message: 'Nội dung bài viết không được để trống' });

    let parsedTags = tags;
    if (typeof tags === 'string') {
      try { parsedTags = JSON.parse(tags); } catch { parsedTags = tags.split(',').map(t => t.trim()).filter(Boolean); }
    }

    if (Array.isArray(parsedTags) && parsedTags.length > 0) {
      const validUsers = await User.find({ _id: { $in: parsedTags } }).select('_id');
      const validIds = validUsers.map(u => u._id.toString());
      const invalid = parsedTags.filter(id => !validIds.includes(id));
      if (invalid.length) return res.status(400).json({ message: 'Một số người dùng được tag không tồn tại', invalidTags: invalid });
    }

    let images = [], videos = [];
    if (req.files?.length) {
      req.files.forEach(file => {
        const filePath = `/uploads/posts/${file.filename}`;
        if (file.mimetype.startsWith('image/')) images.push(filePath);
        else if (file.mimetype.startsWith('video/')) videos.push(filePath);
      });
    }

    const postData = { author: authorId, content: content.trim(), type, visibility, tags: parsedTags, images, videos };
    if (visibility === 'department' && department) postData.department = department;
    if (type === 'Badge' && badgeInfo) { postData.badgeInfo = typeof badgeInfo === 'string' ? JSON.parse(badgeInfo) : badgeInfo; }

    const post = await Post.create(postData);
    const populatedPost = await Post.findById(post._id)
      .populate('author', 'fullname avatarUrl email department jobTitle')
      .populate('tags', 'fullname avatarUrl email');

    const newfeedSocket = req.app.get('newfeedSocket');
    if (newfeedSocket) await newfeedSocket.broadcastNewPost(populatedPost);

    if (parsedTags.length > 0) {
      await notify('post_tagged', { postId: post._id.toString(), recipients: parsedTags, authorId, authorName: req.user.fullname });
    }

    res.status(201).json({ success: true, message: 'Tạo bài viết thành công', data: populatedPost });
  } catch (error) {
    try {
      if (req.files?.length) {
        req.files.forEach(file => { const p = path.join(__dirname, '../uploads/posts/', file.filename); if (fs.existsSync(p)) fs.unlinkSync(p); });
      }
    } catch {}
    res.status(500).json({ success: false, message: 'Lỗi server khi tạo bài viết', error: error.message });
  }
};

exports.getNewsfeed = async (req, res) => {
  try {
    const { page = 1, limit = 10, type, author, department, sortBy = 'createdAt', sortOrder = 'desc' } = req.query;
    const userDepartment = req.user.department;
    const filter = { $or: [{ visibility: 'public' }] };
    if (userDepartment) filter.$or.push({ visibility: 'department', department: userDepartment });
    if (type) filter.type = type; if (author) filter.author = author; if (department) filter.department = department;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const sortOptions = { [sortBy]: sortOrder === 'desc' ? -1 : 1 };
    const [posts, totalPosts] = await Promise.all([
      Post.find(filter)
        .populate('author', 'fullname avatarUrl email department jobTitle')
        .populate('tags', 'fullname avatarUrl email')
        .populate('comments.user', 'fullname avatarUrl email')
        .populate('reactions.user', 'fullname avatarUrl email')
        .sort(sortOptions)
        .skip(skip)
        .limit(parseInt(limit)),
      Post.countDocuments(filter),
    ]);
    res.status(200).json({ success: true, data: { posts, pagination: { currentPage: parseInt(page), totalPages: Math.ceil(totalPosts / parseInt(limit)), totalPosts, hasNext: parseInt(page) < Math.ceil(totalPosts / parseInt(limit)), hasPrev: parseInt(page) > 1 } } });
  } catch (error) { res.status(500).json({ success: false, message: 'Lỗi server khi lấy bảng tin', error: error.message }); }
};

exports.getPostById = async (req, res) => {
  try {
    const { postId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(postId)) return res.status(400).json({ success: false, message: 'ID bài viết không hợp lệ' });
    const post = await Post.findById(postId)
      .populate('author', 'fullname avatarUrl email department jobTitle')
      .populate('tags', 'fullname avatarUrl email')
      .populate('comments.user', 'fullname avatarUrl email')
      .populate('reactions.user', 'fullname avatarUrl email');
    if (!post) return res.status(404).json({ success: false, message: 'Không tìm thấy bài viết' });
    const userDepartment = req.user.department;
    if (post.visibility === 'department' && post.department && post.department !== userDepartment) return res.status(403).json({ success: false, message: 'Bạn không có quyền xem bài viết này' });
    res.status(200).json({ success: true, data: post });
  } catch (error) { res.status(500).json({ success: false, message: 'Lỗi server khi lấy bài viết', error: error.message }); }
};

exports.updatePost = async (req, res) => {
  try {
    const { postId } = req.params;
    const { content, type, visibility, department, tags, badgeInfo, images, videos, isPinned } = req.body;
    const userId = req.user._id;
    if (!mongoose.Types.ObjectId.isValid(postId)) return res.status(400).json({ success: false, message: 'ID bài viết không hợp lệ' });
    const post = await Post.findById(postId);
    if (!post) return res.status(404).json({ success: false, message: 'Không tìm thấy bài viết' });
    if (post.author.toString() !== userId.toString() && req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Bạn không có quyền chỉnh sửa bài viết này' });
    if (tags && tags.length > 0) {
      const validUsers = await User.find({ _id: { $in: tags } }).select('_id');
      const validIds = validUsers.map(u => u._id.toString());
      const invalid = tags.filter(id => !validIds.includes(id));
      if (invalid.length) return res.status(400).json({ success: false, message: 'Một số người dùng được tag không tồn tại', invalidTags: invalid });
    }
    const updateData = {};
    if (content !== undefined) updateData.content = content.trim();
    if (type !== undefined) updateData.type = type;
    if (visibility !== undefined) updateData.visibility = visibility;
    if (department !== undefined) updateData.department = department;
    if (tags !== undefined) updateData.tags = tags;
    if (images !== undefined) updateData.images = images;
    if (videos !== undefined) updateData.videos = videos;
    if (badgeInfo !== undefined) updateData.badgeInfo = badgeInfo;
    if (isPinned !== undefined && req.user.role === 'admin') updateData.isPinned = isPinned;
    const updated = await Post.findByIdAndUpdate(postId, updateData, { new: true, runValidators: true })
      .populate('author', 'fullname avatarUrl email department jobTitle')
      .populate('tags', 'fullname avatarUrl email')
      .populate('comments.user', 'fullname avatarUrl email')
      .populate('reactions.user', 'fullname avatarUrl email');
    res.status(200).json({ success: true, message: 'Cập nhật bài viết thành công', data: updated });
  } catch (error) { res.status(500).json({ success: false, message: 'Lỗi server khi cập nhật bài viết', error: error.message }); }
};

exports.deletePost = async (req, res) => {
  try {
    const { postId } = req.params; const userId = req.user._id;
    if (!mongoose.Types.ObjectId.isValid(postId)) return res.status(400).json({ success: false, message: 'ID bài viết không hợp lệ' });
    const post = await Post.findById(postId);
    if (!post) return res.status(404).json({ success: false, message: 'Không tìm thấy bài viết' });
    if (post.author.toString() !== userId.toString() && req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Bạn không có quyền xóa bài viết này' });
    await Post.findByIdAndDelete(postId);
    res.status(200).json({ success: true, message: 'Xóa bài viết thành công' });
  } catch (error) { res.status(500).json({ success: false, message: 'Lỗi server khi xóa bài viết', error: error.message }); }
};

exports.addReaction = async (req, res) => {
  try {
    const { postId } = req.params; const { type = 'like' } = req.body; const userId = req.user._id;
    if (!mongoose.Types.ObjectId.isValid(postId)) return res.status(400).json({ success: false, message: 'ID bài viết không hợp lệ' });
    if (!type || typeof type !== 'string' || type.trim() === '') return res.status(400).json({ success: false, message: 'Loại reaction không hợp lệ' });
    const post = await Post.findById(postId); if (!post) return res.status(404).json({ success: false, message: 'Không tìm thấy bài viết' });
    const idx = post.reactions.findIndex(r => r.user.toString() === userId.toString());
    if (idx !== -1) { post.reactions[idx].type = type.trim(); post.reactions[idx].createdAt = new Date(); }
    else { post.reactions.push({ user: userId, type: type.trim(), createdAt: new Date() }); }
    await post.save();
    const updated = await Post.findById(postId)
      .populate('author', 'fullname avatarUrl email')
      .populate('reactions.user', 'fullname avatarUrl email')
      .populate('comments.user', 'fullname avatarUrl email')
      .populate('tags', 'fullname avatarUrl email');
    if (post.author.toString() !== userId.toString()) {
      await notify('post_reacted', { postId, recipientId: post.author.toString(), userId: userId.toString(), reactionType: type.trim() });
    }
    res.status(200).json({ success: true, message: 'Thêm reaction thành công', data: updated });
  } catch (error) { res.status(500).json({ success: false, message: 'Lỗi server khi thêm reaction', error: error.message }); }
};

exports.removeReaction = async (req, res) => {
  try { const { postId } = req.params; const userId = req.user._id;
    if (!mongoose.Types.ObjectId.isValid(postId)) return res.status(400).json({ success: false, message: 'ID bài viết không hợp lệ' });
    const post = await Post.findById(postId); if (!post) return res.status(404).json({ success: false, message: 'Không tìm thấy bài viết' });
    post.reactions = post.reactions.filter(r => r.user.toString() !== userId.toString());
    await post.save();
    const updated = await Post.findById(postId)
      .populate('author', 'fullname avatarUrl email')
      .populate('reactions.user', 'fullname avatarUrl email')
      .populate('comments.user', 'fullname avatarUrl email')
      .populate('tags', 'fullname avatarUrl email');
    res.status(200).json({ success: true, message: 'Xóa reaction thành công', data: updated });
  } catch (error) { res.status(500).json({ success: false, message: 'Lỗi server khi xóa reaction', error: error.message }); }
};

exports.addComment = async (req, res) => {
  try { const { postId } = req.params; const { content } = req.body; const userId = req.user._id;
    if (!mongoose.Types.ObjectId.isValid(postId)) return res.status(400).json({ success: false, message: 'ID bài viết không hợp lệ' });
    if (!content || content.trim() === '') return res.status(400).json({ success: false, message: 'Nội dung comment không được để trống' });
    const post = await Post.findById(postId); if (!post) return res.status(404).json({ success: false, message: 'Không tìm thấy bài viết' });
    post.comments.push({ user: userId, content: content.trim(), createdAt: new Date(), reactions: [] });
    await post.save();
    const updated = await Post.findById(postId)
      .populate('author', 'fullname avatarUrl email')
      .populate('comments.user', 'fullname avatarUrl email');
    if (post.author.toString() !== userId.toString()) {
      await notify('post_commented', { postId, recipientId: post.author.toString(), userId: userId.toString(), content: content.trim() });
    }
    res.status(200).json({ success: true, message: 'Thêm comment thành công', data: updated });
  } catch (error) { res.status(500).json({ success: false, message: 'Lỗi server khi thêm comment', error: error.message }); }
};

exports.deleteComment = async (req, res) => {
  try { const { postId, commentId } = req.params; const userId = req.user._id;
    if (!mongoose.Types.ObjectId.isValid(postId) || !mongoose.Types.ObjectId.isValid(commentId)) return res.status(400).json({ success: false, message: 'ID không hợp lệ' });
    const post = await Post.findById(postId); if (!post) return res.status(404).json({ success: false, message: 'Không tìm thấy bài viết' });
    const idx = post.comments.findIndex(c => c._id.toString() === commentId.toString());
    if (idx === -1) return res.status(404).json({ success: false, message: 'Không tìm thấy comment' });
    const comment = post.comments[idx];
    if (comment.user.toString() !== userId.toString() && post.author.toString() !== userId.toString() && req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Bạn không có quyền xóa comment này' });
    post.comments.splice(idx, 1); await post.save();
    const updated = await Post.findById(postId).populate('author', 'fullname avatarUrl email').populate('comments.user', 'fullname avatarUrl email');
    res.status(200).json({ success: true, message: 'Xóa comment thành công', data: updated });
  } catch (error) { res.status(500).json({ success: false, message: 'Lỗi server khi xóa comment', error: error.message }); }
};

exports.togglePinPost = async (req, res) => {
  try { const { postId } = req.params; if (!mongoose.Types.ObjectId.isValid(postId)) return res.status(400).json({ success: false, message: 'ID bài viết không hợp lệ' });
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Chỉ admin mới có quyền pin/unpin bài viết' });
    const post = await Post.findById(postId); if (!post) return res.status(404).json({ success: false, message: 'Không tìm thấy bài viết' });
    post.isPinned = !post.isPinned; await post.save();
    const updated = await Post.findById(postId).populate('author', 'fullname avatarUrl email department jobTitle');
    res.status(200).json({ success: true, message: post.isPinned ? 'Pin bài viết thành công' : 'Unpin bài viết thành công', data: updated });
  } catch (error) { res.status(500).json({ success: false, message: 'Lỗi server khi pin/unpin bài viết', error: error.message }); }
};

exports.getPinnedPosts = async (req, res) => {
  try {
    const userDepartment = req.user.department;
    const filter = { isPinned: true, $or: [{ visibility: 'public' }, { visibility: 'department', department: userDepartment }] };
    const pinned = await Post.find(filter).populate('author', 'fullname avatarUrl email department jobTitle').populate('tags', 'fullname avatarUrl email').sort({ updatedAt: -1 });
    res.status(200).json({ success: true, data: pinned });
  } catch (error) { res.status(500).json({ success: false, message: 'Lỗi server khi lấy bài viết đã pin', error: error.message }); }
};

exports.getTrendingPosts = async (req, res) => {
  try { const { limit = 10, timeFrame = 7 } = req.query; const trending = await PostService.getTrendingPosts(parseInt(limit), parseInt(timeFrame)); res.status(200).json({ success: true, data: trending }); }
  catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

exports.getPersonalizedFeed = async (req, res) => {
  try { const { page = 1, limit = 10 } = req.query; const result = await PostService.getPersonalizedFeed?.(req.user._id, parseInt(page), parseInt(limit)); res.status(200).json({ success: true, data: result }); }
  catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

exports.searchPosts = async (req, res) => {
  try { const { q: query, page = 1, limit = 10 } = req.query; if (!query || query.trim() === '') return res.status(400).json({ success: false, message: 'Từ khóa tìm kiếm không được để trống' }); const result = await PostService.searchPosts(query.trim(), req.user._id, parseInt(page), parseInt(limit)); res.status(200).json({ success: true, data: result }); }
  catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

exports.getFollowingPosts = async (req, res) => {
  try { const { page = 1, limit = 10 } = req.query; const result = await PostService.getFollowingPosts(req.user._id, parseInt(page), parseInt(limit)); res.status(200).json({ success: true, data: result }); }
  catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

exports.getRelatedPosts = async (req, res) => {
  try { const { postId } = req.params; const { limit = 5 } = req.query; if (!mongoose.Types.ObjectId.isValid(postId)) return res.status(400).json({ success: false, message: 'ID bài viết không hợp lệ' }); const related = await PostService.getRelatedPosts(postId, parseInt(limit)); res.status(200).json({ success: true, data: related }); }
  catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

exports.getPostEngagementStats = async (req, res) => {
  try { const { postId } = req.params; if (!mongoose.Types.ObjectId.isValid(postId)) return res.status(400).json({ success: false, message: 'ID bài viết không hợp lệ' }); const stats = await PostService.getPostEngagementStats(postId); res.status(200).json({ success: true, data: stats }); }
  catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

