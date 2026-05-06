const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Post = require('../models/Post');
const User = require('../models/User');
const PostService = require('../services/postService');
const redisClient = require('../config/redis');
const frappeService = require('../services/frappeService');
const { resolveMentions, getMentionedUserEmails } = require('../utils/mentionUtils');

const POST_AUTHOR_SELECT = 'name username guardian_id fullname fullName avatarUrl user_image sis_photo guardian_image email department jobTitle';
const POST_USER_SELECT = 'name username guardian_id fullname fullName avatarUrl user_image sis_photo guardian_image email';
const POST_REACTION_USER_SELECT = 'name username guardian_id fullname fullName avatarUrl user_image sis_photo guardian_image email jobTitle';

/**
 * Gửi notification đến Frappe (fire-and-forget, không block response)
 * Timeout ngắn để không chờ quá lâu
 */
function notify(event, data) {
  // Fire and forget - không await để không block response
  frappeService.sendWislifeNotification(event, data)
    .then(() => console.log(`[Social Service] ✅ Notification sent: ${event}`))
    .catch(e => console.error(`[Social Service] ⚠️ Notification error (${event}):`, e.message));
}

/** Wave 3: classId + studentIds trên post → payload Wislife (deep link mobile / Frappe). */
function wislifePayloadExtra(post) {
  if (!post) return {};
  const out = {};
  const cid = post.classId != null ? String(post.classId).trim() : '';
  if (cid) out.classId = cid;
  const sids = Array.isArray(post.studentIds)
    ? post.studentIds.map((s) => String(s).trim()).filter(Boolean)
    : [];
  if (sids.length) out.participantStudentIds = sids;
  return out;
}

function getBearerToken(req) {
  const authHeader = req.headers.authorization || '';
  return authHeader.split(' ')[1] || '';
}

function parsePagination(query) {
  const page = Math.max(parseInt(query.page || '1', 10), 1);
  const limit = Math.min(Math.max(parseInt(query.limit || '10', 10), 1), 50);
  return { page, limit, skip: (page - 1) * limit };
}

function populatePostQuery(query) {
  return query
    .populate('author', POST_AUTHOR_SELECT)
    .populate('tags', POST_USER_SELECT)
    .populate('comments.user', POST_USER_SELECT)
    .populate('comments.reactions.user', POST_REACTION_USER_SELECT)
    .populate('reactions.user', POST_REACTION_USER_SELECT);
}

function normalizeLookupKey(value) {
  return value ? String(value).trim().toLowerCase() : '';
}

function buildGuardianLookup(guardians = []) {
  const lookup = new Map();
  guardians.forEach((guardian) => {
    const displayNameKey = normalizeLookupKey(guardian.guardian_name);
    const uniqueMatchKeys = (guardian.matchKeys || []).filter((key) => (
      key && normalizeLookupKey(key) !== displayNameKey
    ));
    [
      guardian.name,
      guardian.guardian_id,
      guardian.email,
      guardian.portalEmail,
      ...uniqueMatchKeys,
    ].forEach((key) => {
      const normalized = normalizeLookupKey(key);
      if (normalized) lookup.set(normalized, guardian);
    });
  });
  return lookup;
}

function findGuardianForUser(user, guardianLookup) {
  if (!user) return null;
  const candidates = [
    user.guardian_id,
    user.name,
    user.username,
    user.email,
    user.email?.split('@')[0],
  ];
  for (const candidate of candidates) {
    const match = guardianLookup.get(normalizeLookupKey(candidate));
    if (match) return match;
  }
  return null;
}

function enrichSocialUserWithGuardian(user, guardianLookup) {
  if (!user) return user;
  const plain = typeof user.toObject === 'function' ? user.toObject() : user;
  const guardian = findGuardianForUser(plain, guardianLookup);
  if (!guardian) return plain;

  const guardianName = guardian.guardian_name || plain.fullname || plain.fullName;
  const guardianImage = guardian.guardian_image || plain.guardian_image || plain.avatarUrl;
  return {
    ...plain,
    name: plain.name || guardian.name,
    guardian_id: plain.guardian_id || guardian.guardian_id,
    fullname: guardianName,
    fullName: guardianName,
    guardian_image: guardian.guardian_image || plain.guardian_image || '',
    avatarUrl: guardianImage || '',
  };
}

function enrichPostsWithGuardianDirectory(posts, guardians = []) {
  const guardianLookup = buildGuardianLookup(guardians);
  if (guardianLookup.size === 0) return posts;

  return posts.map((post) => {
    const plainPost = typeof post.toObject === 'function' ? post.toObject() : post;
    return {
      ...plainPost,
      author: enrichSocialUserWithGuardian(plainPost.author, guardianLookup),
      reactions: (plainPost.reactions || []).map((reaction) => ({
        ...reaction,
        user: enrichSocialUserWithGuardian(reaction.user, guardianLookup),
      })),
      comments: (plainPost.comments || []).map((comment) => ({
        ...comment,
        user: enrichSocialUserWithGuardian(comment.user, guardianLookup),
        reactions: (comment.reactions || []).map((reaction) => ({
          ...reaction,
          user: enrichSocialUserWithGuardian(reaction.user, guardianLookup),
        })),
      })),
    };
  });
}

function paginationResponse(posts, totalPosts, page, limit) {
  const totalPages = Math.ceil(totalPosts / limit);
  return {
    posts,
    pagination: {
      currentPage: page,
      totalPages,
      totalPosts,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    },
  };
}

function normalizeAudience(value, classId) {
  if (value === 'class' || classId) return 'class';
  if (value === 'department') return 'department';
  return 'public';
}

function buildStudentClassFilters(scopes, schoolYearId) {
  return scopes
    .filter((scope) => scope.classId && (!schoolYearId || scope.schoolYearId === schoolYearId))
    .map((scope) => ({
      classId: scope.classId,
      ...(scope.schoolYearId ? { schoolYearId: scope.schoolYearId } : {}),
    }));
}

function isPostInStudentScopes(post, classFilters) {
  if (!post || post.audienceType !== 'class') return false;
  return classFilters.some((filter) => {
    if (String(post.classId || '') !== String(filter.classId || '')) return false;
    if (filter.schoolYearId) {
      return String(post.schoolYearId || '') === String(filter.schoolYearId);
    }
    return true;
  });
}

function paginatePostComments(post, query) {
  const { page, limit, skip } = parsePagination({
    page: query.commentPage || query.page || '1',
    limit: query.commentLimit || query.limit || '20',
  });
  const comments = Array.isArray(post.comments) ? [...post.comments] : [];
  const rootComments = comments
    .filter((comment) => !comment.parentComment)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const visibleRoots = rootComments.slice(skip, skip + limit);
  const visibleRootIds = new Set(visibleRoots.map((comment) => comment._id.toString()));
  const visibleReplies = comments
    .filter((comment) => comment.parentComment && visibleRootIds.has(comment.parentComment.toString()))
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const visibleComments = [...visibleRoots, ...visibleReplies];

  return {
    comments: visibleComments,
    pagination: {
      currentPage: page,
      totalPages: Math.ceil(rootComments.length / limit),
      totalComments: comments.length,
      totalRootComments: rootComments.length,
      hasNext: page < Math.ceil(rootComments.length / limit),
      hasPrev: page > 1,
    },
  };
}

async function buildClassPostMetadata({ audienceType, classId, schoolYearId, token }) {
  if (audienceType !== 'class') return {};
  if (!classId || !schoolYearId) {
    const err = new Error('Vui lòng chọn lớp và năm học cho bài viết Nhật ký');
    err.statusCode = 400;
    throw err;
  }

  const metadata = await frappeService.getClassMetadata(classId, token);
  if (!metadata) {
    const err = new Error('Không tìm thấy lớp để đăng bài');
    err.statusCode = 400;
    throw err;
  }
  if (metadata.schoolYearId && metadata.schoolYearId !== schoolYearId) {
    const err = new Error('Năm học không khớp với lớp đã chọn');
    err.statusCode = 400;
    throw err;
  }

  return {
    audienceType: 'class',
    classId: metadata.classId,
    classTitle: metadata.classTitle,
    schoolYearId: metadata.schoolYearId || schoolYearId,
    schoolYearTitle: metadata.schoolYearTitle || schoolYearId,
    campusId: metadata.campusId,
  };
}

exports.createPost = async (req, res) => {
  try {
    const {
      content,
      type = 'Chia sẻ',
      visibility = 'public',
      department,
      tags = [],
      badgeInfo,
      classId,
      schoolYearId,
      audienceType: rawAudienceType,
    } = req.body;
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
        const relative = `/uploads/posts/${file.filename}`;
        const filePath = `/api/social${relative}`;
        // Một số thiết bị iOS có thể gửi mimetype rỗng; fallback theo đuôi file
        const mime = file.mimetype || (file.originalname?.toLowerCase().endsWith('.mp4') ? 'video/mp4' : 'image/jpeg');
        if (mime.startsWith('image/')) images.push(filePath);
        else if (mime.startsWith('video/')) videos.push(filePath);
      });
    }

    const audienceType = normalizeAudience(rawAudienceType, classId);
    const classMetadata = await buildClassPostMetadata({
      audienceType,
      classId,
      schoolYearId,
      token: getBearerToken(req),
    });
    const postData = {
      author: authorId,
      content: content.trim(),
      type,
      visibility,
      audienceType,
      tags: parsedTags,
      images,
      videos,
      ...classMetadata,
    };
    if (visibility === 'department' && department) postData.department = department;
    if (type === 'Badge' && badgeInfo) { postData.badgeInfo = typeof badgeInfo === 'string' ? JSON.parse(badgeInfo) : badgeInfo; }

    const post = await Post.create(postData);
    const populatedPost = await populatePostQuery(Post.findById(post._id));

    const newfeedSocket = req.app.get('newfeedSocket');
    if (newfeedSocket) await newfeedSocket.broadcastNewPost(populatedPost);

    if (Array.isArray(parsedTags) && parsedTags.length > 0) {
      const taggedUsers = await User.find({ _id: { $in: parsedTags } }).select('email');
      const recipientEmails = taggedUsers.map((u) => u.email).filter(Boolean);
      notify('post_tagged', {
        postId: post._id.toString(),
        recipients: parsedTags,
        recipientEmails,
        authorId,
        authorName: req.user.fullname,
        ...wislifePayloadExtra(post),
      });
    }

    // Bài Nhật ký theo lớp không broadcast toàn trường; feed Wislife cũ vẫn theo quyền BOD/IT.
    const authorRoles = req.user.roles || [];
    const isBODorAdmin = authorRoles.some(role =>
      role === 'Mobile BOD' || role === 'Mobile IT'
    );

    if (audienceType !== 'class' && isBODorAdmin) {
      notify('new_post_broadcast', {
        postId: post._id.toString(),
        authorEmail: req.user.email,
        authorName: req.user.fullname,
        content: content.trim().substring(0, 100),
        type: type,
        ...wislifePayloadExtra(post),
      });
    } else {
      console.log(`[CreatePost] ⏭️ User không có role BOD/IT, skip broadcast notification`);
    }

    res.status(201).json({ success: true, message: 'Tạo bài viết thành công', data: populatedPost });
  } catch (error) {
    try {
      if (req.files?.length) {
        req.files.forEach(file => { const p = path.join(__dirname, '../uploads/posts/', file.filename); if (fs.existsSync(p)) fs.unlinkSync(p); });
      }
    } catch {}
    res.status(error.statusCode || 500).json({ success: false, message: error.statusCode ? error.message : 'Lỗi server khi tạo bài viết', error: error.message });
  }
};

exports.getNewsfeed = async (req, res) => {
  try {
    const { type, author, department, sortBy = 'createdAt', sortOrder = 'desc' } = req.query;
    const { page, limit, skip } = parsePagination(req.query);
    const userDepartment = req.user?.department;
    const filter = { audienceType: { $ne: 'class' }, $or: [{ visibility: 'public' }] };
    if (userDepartment) filter.$or.push({ visibility: 'department', department: userDepartment });
    if (type) filter.type = type; if (author) filter.author = author; if (department) filter.department = department;
    const sortOptions = { [sortBy]: sortOrder === 'desc' ? -1 : 1 };
    const [posts, totalPosts] = await Promise.all([
      populatePostQuery(Post.find(filter))
        .sort(sortOptions)
        .skip(skip)
        .limit(limit),
      Post.countDocuments(filter),
    ]);
    res.status(200).json({ success: true, data: paginationResponse(posts, totalPosts, page, limit) });
  } catch (error) { res.status(500).json({ success: false, message: 'Lỗi server khi lấy bảng tin', error: error.message }); }
};

exports.getClassFeed = async (req, res) => {
  try {
    const { classId, schoolYearId } = req.query;
    if (!classId) {
      return res.status(400).json({ success: false, message: 'Thiếu classId' });
    }

    const { page, limit, skip } = parsePagination(req.query);
    const filter = { audienceType: 'class', classId: String(classId) };
    if (schoolYearId) filter.schoolYearId = String(schoolYearId);

    const [posts, totalPosts] = await Promise.all([
      populatePostQuery(Post.find(filter))
        .sort({ isPinned: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Post.countDocuments(filter),
    ]);

    let enrichedPosts = posts;
    try {
      const token = getBearerToken(req);
      const directory = await frappeService.getClassGuardianDirectory(
        String(classId),
        schoolYearId ? String(schoolYearId) : undefined,
        token
      );
      enrichedPosts = enrichPostsWithGuardianDirectory(posts, directory.guardians || []);
    } catch (directoryError) {
      console.warn('[PostController] Không enrich được guardian directory cho class feed:', directoryError.message);
    }

    return res.status(200).json({ success: true, data: paginationResponse(enrichedPosts, totalPosts, page, limit) });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Lỗi server khi lấy Nhật ký lớp', error: error.message });
  }
};

exports.getClassGuardianDirectory = async (req, res) => {
  try {
    const { classId, schoolYearId } = req.query;
    if (!classId) {
      return res.status(400).json({ success: false, message: 'Thiếu classId' });
    }

    const token = getBearerToken(req);
    const data = await frappeService.getClassGuardianDirectory(
      String(classId),
      schoolYearId ? String(schoolYearId) : undefined,
      token
    );
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error('[PostController] getClassGuardianDirectory error:', error);
    return res.status(500).json({
      success: false,
      message: 'Lỗi server khi lấy danh sách phụ huynh của lớp',
      error: error.message,
    });
  }
};

exports.getStudentFeed = async (req, res) => {
  const { studentId, schoolYearId } = req.query;
  try {
    if (!studentId) {
      return res.status(400).json({ success: false, message: 'Thiếu studentId' });
    }

    const token = getBearerToken(req);
    const hasAccess = await frappeService.verifyGuardianStudentAccess(String(studentId), token);
    if (!hasAccess) {
      return res.status(403).json({ success: false, message: 'Bạn không có quyền xem Nhật ký của học sinh này' });
    }

    const scopes = await frappeService.getStudentClassScopes(String(studentId), token);
    const classFilters = buildStudentClassFilters(scopes, schoolYearId);

    if (classFilters.length === 0) {
      const { page, limit } = parsePagination(req.query);
      return res.status(200).json({ success: true, data: paginationResponse([], 0, page, limit), classScopes: scopes });
    }

    const { page, limit, skip } = parsePagination(req.query);
    const filter = { audienceType: 'class', $or: classFilters };
    const [posts, totalPosts] = await Promise.all([
      populatePostQuery(Post.find(filter))
        .sort({ isPinned: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Post.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      data: paginationResponse(posts, totalPosts, page, limit),
      classScopes: scopes,
    });
  } catch (error) {
    const upstreamStatus = error?.response?.status;
    const upstreamData = error?.response?.data;
    const upstreamMessage =
      upstreamData?.message?.message ||
      upstreamData?.message ||
      upstreamData?._server_messages ||
      upstreamData?.exception ||
      error.message;
    console.error('[StudentFeed] Lỗi lấy Nhật ký học sinh:', {
      status: upstreamStatus,
      message: upstreamMessage,
      studentId,
    });
    return res.status(500).json({
      success: false,
      message: 'Lỗi server khi lấy Nhật ký học sinh',
      error: upstreamMessage,
      upstreamStatus,
    });
  }
};

exports.getStudentPostDetail = async (req, res) => {
  const { postId } = req.params;
  const { studentId, schoolYearId } = req.query;

  try {
    if (!studentId) {
      return res.status(400).json({ success: false, message: 'Thiếu studentId' });
    }
    if (!mongoose.Types.ObjectId.isValid(postId)) {
      return res.status(400).json({ success: false, message: 'ID bài viết không hợp lệ' });
    }

    const token = getBearerToken(req);
    const hasAccess = await frappeService.verifyGuardianStudentAccess(String(studentId), token);
    if (!hasAccess) {
      return res.status(403).json({ success: false, message: 'Bạn không có quyền xem Nhật ký của học sinh này' });
    }

    const scopes = await frappeService.getStudentClassScopes(String(studentId), token);
    const classFilters = buildStudentClassFilters(scopes, schoolYearId);
    if (classFilters.length === 0) {
      return res.status(403).json({ success: false, message: 'Bạn không có quyền xem bài viết này' });
    }

    const post = await populatePostQuery(Post.findById(postId));
    if (!post) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy bài viết' });
    }
    if (!isPostInStudentScopes(post, classFilters)) {
      return res.status(403).json({ success: false, message: 'Bạn không có quyền xem bài viết này' });
    }

    const { comments, pagination } = paginatePostComments(post, req.query);
    const detailPost = post.toObject();
    detailPost.comments = comments;

    return res.status(200).json({
      success: true,
      data: {
        post: detailPost,
        commentPagination: pagination,
      },
      classScopes: scopes,
    });
  } catch (error) {
    const upstreamStatus = error?.response?.status;
    const upstreamData = error?.response?.data;
    const upstreamMessage =
      upstreamData?.message?.message ||
      upstreamData?.message ||
      upstreamData?._server_messages ||
      upstreamData?.exception ||
      error.message;
    console.error('[StudentPostDetail] Lỗi lấy chi tiết Nhật ký:', {
      status: upstreamStatus,
      message: upstreamMessage,
      studentId,
      postId,
    });
    return res.status(500).json({
      success: false,
      message: 'Lỗi server khi lấy chi tiết Nhật ký',
      error: upstreamMessage,
      upstreamStatus,
    });
  }
};

exports.getPostById = async (req, res) => {
  try {
    const { postId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(postId)) return res.status(400).json({ success: false, message: 'ID bài viết không hợp lệ' });
    const post = await Post.findById(postId)
      .populate('author', POST_AUTHOR_SELECT)
      .populate('tags', POST_USER_SELECT)
      .populate('comments.user', POST_USER_SELECT)
      .populate('comments.reactions.user', POST_REACTION_USER_SELECT)
      .populate('reactions.user', POST_REACTION_USER_SELECT);
    if (!post) return res.status(404).json({ success: false, message: 'Không tìm thấy bài viết' });
    const userDepartment = req.user?.department;
    if (post.visibility === 'department' && post.department && post.department !== userDepartment) return res.status(403).json({ success: false, message: 'Bạn không có quyền xem bài viết này' });
    res.status(200).json({ success: true, data: post });
  } catch (error) { res.status(500).json({ success: false, message: 'Lỗi server khi lấy bài viết', error: error.message }); }
};

exports.updatePost = async (req, res) => {
  try {
    const { postId } = req.params;
    const { content, type, visibility, department, tags, badgeInfo, images, videos, isPinned } = req.body;
    const userId = req.user._id;
    
    if (!mongoose.Types.ObjectId.isValid(postId)) {
      return res.status(400).json({ success: false, message: 'ID bài viết không hợp lệ' });
    }
    
    const post = await Post.findById(postId);
    if (!post) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy bài viết' });
    }
    
    // Kiểm tra quyền: author hoặc Mobile BOD
    const userRoles = req.user.roles || [];
    const isMobileBOD = userRoles.some(role => role === 'Mobile BOD');
    const isAuthor = post.author.toString() === userId.toString();
    
    if (!isAuthor && !isMobileBOD) {
      return res.status(403).json({ success: false, message: 'Bạn không có quyền chỉnh sửa bài viết này' });
    }
    
    if (tags && tags.length > 0) {
      const validUsers = await User.find({ _id: { $in: tags } }).select('_id');
      const validIds = validUsers.map(u => u._id.toString());
      const invalid = tags.filter(id => !validIds.includes(id));
      if (invalid.length) {
        return res.status(400).json({ success: false, message: 'Một số người dùng được tag không tồn tại', invalidTags: invalid });
      }
    }
    
    const normalizeMediaList = (value) => {
      if (value === undefined) return undefined;
      if (Array.isArray(value)) return value;
      return [value].filter(Boolean);
    };

    let nextImages = normalizeMediaList(images);
    let nextVideos = normalizeMediaList(videos);
    if (req.files?.length) {
      req.files.forEach(file => {
        const relative = `/uploads/posts/${file.filename}`;
        const filePath = `/api/social${relative}`;
        const mime = file.mimetype || (file.originalname?.toLowerCase().endsWith('.mp4') ? 'video/mp4' : 'image/jpeg');
        if (mime.startsWith('image/')) {
          if (!nextImages) nextImages = [...(post.images || [])];
          nextImages.push(filePath);
        } else if (mime.startsWith('video/')) {
          if (!nextVideos) nextVideos = [...(post.videos || [])];
          nextVideos.push(filePath);
        }
      });
    }

    const updateData = {};
    if (content !== undefined) updateData.content = content.trim();
    if (type !== undefined) updateData.type = type;
    if (visibility !== undefined) updateData.visibility = visibility;
    if (department !== undefined) updateData.department = department;
    if (tags !== undefined) updateData.tags = tags;
    if (nextImages !== undefined) updateData.images = nextImages;
    if (nextVideos !== undefined) updateData.videos = nextVideos;
    if (badgeInfo !== undefined) updateData.badgeInfo = badgeInfo;
    // Chỉ Mobile BOD mới được update isPinned qua updatePost (không khuyến khích, nên dùng pin/unpin endpoint)
    if (isPinned !== undefined && isMobileBOD) updateData.isPinned = isPinned;
    
    const updated = await Post.findByIdAndUpdate(postId, updateData, { new: true, runValidators: true })
      .populate('author', POST_AUTHOR_SELECT)
      .populate('tags', POST_USER_SELECT)
      .populate('comments.user', POST_USER_SELECT)
      .populate('comments.reactions.user', POST_REACTION_USER_SELECT)
      .populate('reactions.user', POST_REACTION_USER_SELECT);
      
    res.status(200).json({ success: true, message: 'Cập nhật bài viết thành công', data: updated });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Lỗi server khi cập nhật bài viết', error: error.message });
  }
};

exports.deletePost = async (req, res) => {
  try {
    const { postId } = req.params;
    const userId = req.user._id;
    if (!mongoose.Types.ObjectId.isValid(postId)) {
      return res.status(400).json({ success: false, message: 'ID bài viết không hợp lệ' });
    }
    
    const post = await Post.findById(postId);
    if (!post) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy bài viết' });
    }
    
    // Kiểm tra quyền: author hoặc Mobile BOD
    const userRoles = req.user.roles || [];
    const isMobileBOD = userRoles.some(role => role === 'Mobile BOD');
    const isAuthor = post.author.toString() === userId.toString();
    
    if (!isAuthor && !isMobileBOD) {
      return res.status(403).json({ success: false, message: 'Bạn không có quyền xóa bài viết này' });
    }
    
    await Post.findByIdAndDelete(postId);
    res.status(200).json({ success: true, message: 'Xóa bài viết thành công' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Lỗi server khi xóa bài viết', error: error.message });
  }
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
      .populate('author', POST_AUTHOR_SELECT)
      .populate('reactions.user', POST_REACTION_USER_SELECT)
      .populate('comments.user', POST_USER_SELECT)
      .populate('comments.reactions.user', POST_REACTION_USER_SELECT)
      .populate('tags', POST_USER_SELECT);
    if (post.author.toString() !== userId.toString()) {
      // Lấy email của post author để gửi notification
      const author = await User.findById(post.author).select('email');
      if (author?.email) {
        notify('post_reacted', { 
          postId, 
          recipientEmail: author.email, 
          userEmail: req.user.email,
          userName: req.user.fullname, 
          reactionType: type.trim(),
          ...wislifePayloadExtra(post),
        });
      }
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
      .populate('author', POST_AUTHOR_SELECT)
      .populate('reactions.user', POST_REACTION_USER_SELECT)
      .populate('comments.user', POST_USER_SELECT)
      .populate('tags', POST_USER_SELECT);
    res.status(200).json({ success: true, message: 'Xóa reaction thành công', data: updated });
  } catch (error) { res.status(500).json({ success: false, message: 'Lỗi server khi xóa reaction', error: error.message }); }
};

exports.addComment = async (req, res) => {
  try {
    const { postId } = req.params;
    const { content, mentions: clientMentions } = req.body; // clientMentions: array of user IDs từ frontend
    const userId = req.user._id;
    
    if (!mongoose.Types.ObjectId.isValid(postId)) {
      return res.status(400).json({ success: false, message: 'ID bài viết không hợp lệ' });
    }
    if (!content || content.trim() === '') {
      return res.status(400).json({ success: false, message: 'Nội dung comment không được để trống' });
    }
    
    const post = await Post.findById(postId);
    if (!post) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy bài viết' });
    }
    
    // Thêm comment
    post.comments.push({ 
      user: userId, 
      content: content.trim(), 
      createdAt: new Date(), 
      reactions: [] 
    });
    await post.save();
    
    const updated = await Post.findById(postId)
      .populate('author', POST_AUTHOR_SELECT)
      .populate('comments.user', POST_USER_SELECT);
    
    const newCommentId = updated.comments[updated.comments.length - 1]._id;
    
    // Gửi notification cho author của post
    if (post.author.toString() !== userId.toString()) {
      const author = await User.findById(post.author).select('email');
      if (author?.email) {
        notify('post_commented', { 
          postId, 
          recipientEmail: author.email, 
          userEmail: req.user.email,
          userName: req.user.fullname, 
          content: content.trim(),
          ...wislifePayloadExtra(post),
        });
      }
    }
    
    // Xử lý mentions - hỗ trợ cả client gửi lên và parse từ content
    try {
      let mentionedUsers = [];
      
      // Ưu tiên 1: Sử dụng mentions từ client (đã chọn từ dropdown)
      if (Array.isArray(clientMentions) && clientMentions.length > 0) {
        mentionedUsers = await User.find({
          _id: { $in: clientMentions },
          active: true
        }).select('_id email fullname');
      } else {
        // Fallback: Parse mentions từ content text
        mentionedUsers = await resolveMentions(content);
      }
      
      // Gửi notification cho từng người được mention (trừ người comment)
      if (mentionedUsers.length > 0) {
        const mentionedEmails = mentionedUsers
          .filter(u => u._id.toString() !== userId.toString())
          .map(u => u.email)
          .filter(Boolean);
        
        if (mentionedEmails.length > 0) {
          notify('post_mention', {
            postId: postId.toString(),
            commentId: newCommentId.toString(),
            mentionedEmails: mentionedEmails, // Gửi emails trực tiếp
            userId: userId.toString(),
            userName: req.user.fullname,
            ...wislifePayloadExtra(post),
          });
          
          console.log(`📢 [Mention] Sent notifications to ${mentionedEmails.length} users`);
        }
      }
    } catch (mentionError) {
      // Log error nhưng không fail request
      console.error('[Mention] Error processing mentions:', mentionError.message);
    }
    
    res.status(200).json({ success: true, message: 'Thêm comment thành công', data: updated });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Lỗi server khi thêm comment', error: error.message });
  }
};

exports.deleteComment = async (req, res) => {
  try {
    const { postId, commentId } = req.params;
    const userId = req.user._id;
    
    if (!mongoose.Types.ObjectId.isValid(postId) || !mongoose.Types.ObjectId.isValid(commentId)) {
      return res.status(400).json({ success: false, message: 'ID không hợp lệ' });
    }
    
    const post = await Post.findById(postId);
    if (!post) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy bài viết' });
    }
    
    const idx = post.comments.findIndex(c => c._id.toString() === commentId.toString());
    if (idx === -1) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy comment' });
    }
    
    const comment = post.comments[idx];
    
    // Kiểm tra quyền: comment/reply author, post author, hoặc Mobile BOD
    const userRoles = req.user.roles || [];
    const isMobileBOD = userRoles.some(role => role === 'Mobile BOD');
    const isCommentAuthor = comment.user.toString() === userId.toString();
    const isPostAuthor = post.author.toString() === userId.toString();
    
    if (!isCommentAuthor && !isPostAuthor && !isMobileBOD) {
      return res.status(403).json({ success: false, message: 'Bạn không có quyền xóa bình luận này' });
    }
    
    // Nếu là comment gốc (không có parentComment), xóa luôn các replies của nó
    const isParentComment = !comment.parentComment;
    if (isParentComment) {
      // Lọc bỏ comment gốc và tất cả replies có parentComment = commentId
      post.comments = post.comments.filter(c => 
        c._id.toString() !== commentId.toString() && 
        (!c.parentComment || c.parentComment.toString() !== commentId.toString())
      );
    } else {
      // Chỉ xóa reply này
      post.comments.splice(idx, 1);
    }
    
    await post.save();
    
    const updated = await Post.findById(postId)
      .populate('author', POST_AUTHOR_SELECT)
      .populate('comments.user', POST_USER_SELECT)
      .populate('comments.reactions.user', POST_REACTION_USER_SELECT);
      
    res.status(200).json({ 
      success: true, 
      message: isParentComment ? 'Xóa bình luận và các trả lời thành công' : 'Xóa trả lời thành công', 
      data: updated 
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Lỗi server khi xóa bình luận', error: error.message });
  }
};

// Reply vào một comment
exports.replyComment = async (req, res) => {
  try {
    const { postId, commentId } = req.params;
    const { content, mentions: clientMentions } = req.body;
    const userId = req.user._id;

    if (!mongoose.Types.ObjectId.isValid(postId) || !mongoose.Types.ObjectId.isValid(commentId)) {
      return res.status(400).json({ success: false, message: 'ID không hợp lệ' });
    }
    if (!content || content.trim() === '') {
      return res.status(400).json({ success: false, message: 'Nội dung reply không được để trống' });
    }

    const post = await Post.findById(postId);
    if (!post) return res.status(404).json({ success: false, message: 'Không tìm thấy bài viết' });

    const hasParent = post.comments.some((c) => c._id.toString() === commentId.toString());
    if (!hasParent) return res.status(404).json({ success: false, message: 'Không tìm thấy comment để trả lời' });

    post.comments.push({
      user: userId,
      content: content.trim(),
      createdAt: new Date(),
      reactions: [],
      parentComment: commentId,
    });

    await post.save();

    const updated = await Post.findById(postId)
      .populate('author', POST_AUTHOR_SELECT)
      .populate('reactions.user', POST_REACTION_USER_SELECT)
      .populate('comments.user', POST_USER_SELECT)
      .populate('tags', POST_USER_SELECT);

    const newReplyId = updated.comments[updated.comments.length - 1]._id;

    // Gửi notification cho author của parent comment
    const parentComment = post.comments.find(c => c._id.toString() === commentId.toString());
    if (parentComment && parentComment.user.toString() !== userId.toString()) {
      const commentAuthor = await User.findById(parentComment.user).select('email');
      if (commentAuthor?.email) {
        notify('comment_replied', {
          postId: postId.toString(),
          commentId: commentId.toString(),
          recipientEmail: commentAuthor.email,
          userEmail: req.user.email,
          userName: req.user.fullname,
          content: content.trim().substring(0, 100),
          ...wislifePayloadExtra(post),
        });
      }
    }

    // Xử lý mentions trong reply
    try {
      let mentionedUsers = [];
      
      if (Array.isArray(clientMentions) && clientMentions.length > 0) {
        mentionedUsers = await User.find({
          _id: { $in: clientMentions },
          active: true
        }).select('_id email fullname');
      } else {
        mentionedUsers = await resolveMentions(content);
      }
      
      if (mentionedUsers.length > 0) {
        const mentionedEmails = mentionedUsers
          .filter(u => u._id.toString() !== userId.toString())
          .map(u => u.email)
          .filter(Boolean);
        
        if (mentionedEmails.length > 0) {
          notify('post_mention', {
            postId: postId.toString(),
            commentId: newReplyId.toString(),
            mentionedEmails: mentionedEmails,
            userId: userId.toString(),
            userName: req.user.fullname,
            ...wislifePayloadExtra(post),
          });
        }
      }
    } catch (mentionError) {
      console.error('[Mention] Error in reply:', mentionError.message);
    }

    return res.status(200).json({ success: true, message: 'Trả lời bình luận thành công', data: updated });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Lỗi server khi trả lời comment', error: error.message });
  }
};

// Thêm reaction cho comment
exports.addCommentReaction = async (req, res) => {
  try {
    const { postId, commentId } = req.params;
    const { type = 'like' } = req.body;
    const userId = req.user._id;
    if (!mongoose.Types.ObjectId.isValid(postId) || !mongoose.Types.ObjectId.isValid(commentId)) {
      return res.status(400).json({ success: false, message: 'ID không hợp lệ' });
    }
    if (!type || typeof type !== 'string' || type.trim() === '') {
      return res.status(400).json({ success: false, message: 'Loại reaction không hợp lệ' });
    }

    const post = await Post.findById(postId);
    if (!post) return res.status(404).json({ success: false, message: 'Không tìm thấy bài viết' });

    const idx = post.comments.findIndex((c) => c._id.toString() === commentId.toString());
    if (idx === -1) return res.status(404).json({ success: false, message: 'Không tìm thấy comment' });

    const comment = post.comments[idx];
    const reactionIdx = (comment.reactions || []).findIndex(
      (r) => r.user.toString() === userId.toString()
    );

    if (reactionIdx !== -1) {
      comment.reactions[reactionIdx].type = type.trim();
      comment.reactions[reactionIdx].createdAt = new Date();
    } else {
      comment.reactions = comment.reactions || [];
      comment.reactions.push({ user: userId, type: type.trim(), createdAt: new Date() });
    }

    await post.save();
    const updated = await Post.findById(postId)
      .populate('author', POST_AUTHOR_SELECT)
      .populate('reactions.user', POST_REACTION_USER_SELECT)
      .populate('comments.user', POST_USER_SELECT)
      .populate('comments.reactions.user', POST_REACTION_USER_SELECT)
      .populate('tags', POST_USER_SELECT);

    // Gửi notification cho author của comment
    if (comment.user.toString() !== userId.toString()) {
      const commentAuthor = await User.findById(comment.user).select('email');
      if (commentAuthor?.email) {
        notify('comment_reacted', {
          postId: postId.toString(),
          commentId: commentId.toString(),
          recipientEmail: commentAuthor.email,
          userEmail: req.user.email,
          userName: req.user.fullname,
          reactionType: type.trim(),
          ...wislifePayloadExtra(post),
        });
      }
    }

    return res.status(200).json({ success: true, message: 'Thêm reaction cho comment thành công', data: updated });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Lỗi server khi thêm reaction cho comment', error: error.message });
  }
};

// Xoá reaction của comment
exports.removeCommentReaction = async (req, res) => {
  try {
    const { postId, commentId } = req.params;
    const userId = req.user._id;
    if (!mongoose.Types.ObjectId.isValid(postId) || !mongoose.Types.ObjectId.isValid(commentId)) {
      return res.status(400).json({ success: false, message: 'ID không hợp lệ' });
    }

    const post = await Post.findById(postId);
    if (!post) return res.status(404).json({ success: false, message: 'Không tìm thấy bài viết' });

    const idx = post.comments.findIndex((c) => c._id.toString() === commentId.toString());
    if (idx === -1) return res.status(404).json({ success: false, message: 'Không tìm thấy comment' });

    const comment = post.comments[idx];
    comment.reactions = (comment.reactions || []).filter(
      (r) => r.user.toString() !== userId.toString()
    );

    await post.save();
    const updated = await Post.findById(postId)
      .populate('author', POST_AUTHOR_SELECT)
      .populate('reactions.user', POST_REACTION_USER_SELECT)
      .populate('comments.user', POST_USER_SELECT)
      .populate('comments.reactions.user', POST_REACTION_USER_SELECT)
      .populate('tags', POST_USER_SELECT);

    return res.status(200).json({ success: true, message: 'Xoá reaction của comment thành công', data: updated });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Lỗi server khi xoá reaction của comment', error: error.message });
  }
};

// Pin một bài viết (chỉ Mobile BOD)
exports.pinPost = async (req, res) => {
  try {
    const { postId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(postId)) {
      return res.status(400).json({ success: false, message: 'ID bài viết không hợp lệ' });
    }

    // Kiểm tra quyền Mobile BOD
    const userRoles = req.user.roles || [];
    const isMobileBOD = userRoles.some(role => role === 'Mobile BOD');
    if (!isMobileBOD) {
      return res.status(403).json({ success: false, message: 'Chỉ Mobile BOD mới có quyền ghim bài viết' });
    }

    const post = await Post.findById(postId);
    if (!post) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy bài viết' });
    }

    // Đặt isPinned = true
    post.isPinned = true;
    await post.save();

    const updated = await Post.findById(postId)
      .populate('author', POST_AUTHOR_SELECT)
      .populate('tags', POST_USER_SELECT)
      .populate('comments.user', POST_USER_SELECT)
      .populate('comments.reactions.user', POST_REACTION_USER_SELECT)
      .populate('reactions.user', POST_REACTION_USER_SELECT);

    res.status(200).json({ 
      success: true, 
      message: 'Đã ghim bài viết lên đầu', 
      data: updated 
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: 'Lỗi server khi ghim bài viết', 
      error: error.message 
    });
  }
};

// Unpin một bài viết (chỉ Mobile BOD)
exports.unpinPost = async (req, res) => {
  try {
    const { postId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(postId)) {
      return res.status(400).json({ success: false, message: 'ID bài viết không hợp lệ' });
    }

    // Kiểm tra quyền Mobile BOD
    const userRoles = req.user.roles || [];
    const isMobileBOD = userRoles.some(role => role === 'Mobile BOD');
    if (!isMobileBOD) {
      return res.status(403).json({ success: false, message: 'Chỉ Mobile BOD mới có quyền bỏ ghim bài viết' });
    }

    const post = await Post.findById(postId);
    if (!post) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy bài viết' });
    }

    // Đặt isPinned = false
    post.isPinned = false;
    await post.save();

    const updated = await Post.findById(postId)
      .populate('author', POST_AUTHOR_SELECT)
      .populate('tags', POST_USER_SELECT)
      .populate('comments.user', POST_USER_SELECT)
      .populate('comments.reactions.user', POST_REACTION_USER_SELECT)
      .populate('reactions.user', POST_REACTION_USER_SELECT);

    res.status(200).json({ 
      success: true, 
      message: 'Đã bỏ ghim bài viết', 
      data: updated 
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: 'Lỗi server khi bỏ ghim bài viết', 
      error: error.message 
    });
  }
};

exports.getPinnedPosts = async (req, res) => {
  try {
    const userDepartment = req.user.department;
    const filter = { isPinned: true, $or: [{ visibility: 'public' }, { visibility: 'department', department: userDepartment }] };
    const pinned = await Post.find(filter).populate('author', POST_AUTHOR_SELECT).populate('tags', POST_USER_SELECT).sort({ updatedAt: -1 });
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

