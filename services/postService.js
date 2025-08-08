const Post = require('../models/Post');
const User = require('../models/User');
const mongoose = require('mongoose');

class PostService {
  static async getTrendingPosts(limit = 10, timeFrame = 7) {
    const dateThreshold = new Date();
    dateThreshold.setDate(dateThreshold.getDate() - timeFrame);
    const posts = await Post.aggregate([
      { $match: { createdAt: { $gte: dateThreshold }, visibility: 'public' } },
      { $addFields: { totalEngagement: { $add: [{ $size: '$reactions' }, { $size: '$comments' }] } } },
      { $sort: { totalEngagement: -1, createdAt: -1 } },
      { $limit: limit },
    ]);
    await Post.populate(posts, [
      { path: 'author', select: 'fullname avatarUrl email department' },
      { path: 'tags', select: 'fullname avatarUrl email' },
      { path: 'comments.user', select: 'fullname avatarUrl email' },
      { path: 'reactions.user', select: 'fullname avatarUrl email' },
    ]);
    return posts;
  }

  static async getFollowingPosts(userId, page = 1, limit = 10) {
    const user = await User.findById(userId).populate('following', '_id');
    const followingIds = user?.following?.map(f => f._id) || [];
    followingIds.push(new mongoose.Types.ObjectId(userId));
    const skip = (page - 1) * limit;
    const filter = {
      author: { $in: followingIds },
      $or: [{ visibility: 'public' }, { visibility: 'department', department: user?.department }],
    };
    const [posts, totalPosts] = await Promise.all([
      Post.find(filter)
        .populate('author', 'fullname avatarUrl email department jobTitle')
        .populate('tags', 'fullname avatarUrl email')
        .populate('comments.user', 'fullname avatarUrl email')
        .populate('reactions.user', 'fullname avatarUrl email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Post.countDocuments(filter),
    ]);
    return {
      posts,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(totalPosts / limit),
        totalPosts,
        hasNext: page < Math.ceil(totalPosts / limit),
        hasPrev: page > 1,
      },
    };
  }

  static async searchPosts(query, userId, page = 1, limit = 10) {
    const user = await User.findById(userId);
    const skip = (page - 1) * limit;
    const searchFilter = {
      $or: [
        { content: { $regex: query, $options: 'i' } },
        { 'badgeInfo.badgeName': { $regex: query, $options: 'i' } },
        { 'badgeInfo.message': { $regex: query, $options: 'i' } },
      ],
      $and: [{ $or: [{ visibility: 'public' }, { visibility: 'department', department: user?.department }] }],
    };
    const [posts, totalPosts] = await Promise.all([
      Post.find(searchFilter)
        .populate('author', 'fullname avatarUrl email department jobTitle')
        .populate('tags', 'fullname avatarUrl email')
        .populate('comments.user', 'fullname avatarUrl email')
        .populate('reactions.user', 'fullname avatarUrl email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Post.countDocuments(searchFilter),
    ]);
    return {
      posts,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(totalPosts / limit),
        totalPosts,
        hasNext: page < Math.ceil(totalPosts / limit),
        hasPrev: page > 1,
      },
    };
  }

  static async getPostEngagementStats(postId) {
    const post = await Post.findById(postId);
    if (!post) throw new Error('Không tìm thấy bài viết');
    const reactionStats = post.reactions.reduce((acc, r) => ((acc[r.type] = (acc[r.type] || 0) + 1), acc), {});
    const commentsByDate = post.comments.reduce((acc, c) => { const d = c.createdAt.toISOString().split('T')[0]; acc[d] = (acc[d] || 0) + 1; return acc; }, {});
    return { totalReactions: post.reactions.length, totalComments: post.comments.length, reactionBreakdown: reactionStats, commentsByDate, engagementRate: (post.reactions.length + post.comments.length) };
  }

  static async getRelatedPosts(postId, limit = 5) {
    const post = await Post.findById(postId);
    if (!post) throw new Error('Không tìm thấy bài viết');
    const relatedFilter = { _id: { $ne: postId }, $or: [{ tags: { $in: post.tags } }, { department: post.department }, { type: post.type }, { author: post.author }] };
    return await Post.find(relatedFilter)
      .populate('author', 'fullname avatarUrl email department jobTitle')
      .populate('tags', 'fullname avatarUrl email')
      .sort({ createdAt: -1 })
      .limit(limit);
  }

  static async getTopContributors(timeFrame = 30, limit = 10) {
    const dateThreshold = new Date();
    dateThreshold.setDate(dateThreshold.getDate() - timeFrame);
    const top = await Post.aggregate([
      { $match: { createdAt: { $gte: dateThreshold } } },
      { $group: { _id: '$author', postCount: { $sum: 1 }, totalReactions: { $sum: { $size: '$reactions' } }, totalComments: { $sum: { $size: '$comments' } } } },
      { $addFields: { totalEngagement: { $add: ['$totalReactions', '$totalComments'] } } },
      { $sort: { postCount: -1, totalEngagement: -1 } },
      { $limit: limit },
    ]);
    await Post.populate(top, { path: '_id', select: 'fullname avatarUrl email department', model: 'User' });
    return top.map(t => ({ user: t._id, postCount: t.postCount, totalReactions: t.totalReactions, totalComments: t.totalComments, totalEngagement: t.totalEngagement }));
  }

  static async getPopularPostsByDepartment(departmentId, limit = 10) {
    const posts = await Post.aggregate([
      { $match: { $or: [{ department: new mongoose.Types.ObjectId(departmentId) }, { visibility: 'public' }] } },
      { $addFields: { totalEngagement: { $add: [{ $size: '$reactions' }, { $size: '$comments' }] } } },
      { $sort: { totalEngagement: -1, createdAt: -1 } },
      { $limit: limit },
    ]);
    await Post.populate(posts, [
      { path: 'author', select: 'fullname avatarUrl email department' },
      { path: 'tags', select: 'fullname avatarUrl email' },
      { path: 'comments.user', select: 'fullname avatarUrl email' },
      { path: 'reactions.user', select: 'fullname avatarUrl email' },
    ]);
    return posts;
  }
}

module.exports = PostService;

