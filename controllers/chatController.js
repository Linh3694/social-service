const ChatConversation = require('../models/ChatConversation');
const ChatMessage = require('../models/ChatMessage');
const User = require('../models/User');
const frappeService = require('../services/frappeService');
const {
  getChatBroadcastRooms,
  ioEmitToRoomsUnion,
} = require('../utils/chatBroadcastRooms');

const USER_SELECT = 'fullname fullName email avatarUrl user_image sis_photo guardian_image guardian_id roles role';

function getBearerToken(req) {
  const authHeader = req.headers.authorization || '';
  return authHeader.split(' ')[1] || '';
}

function userDisplayName(user) {
  return user?.fullname || user?.fullName || user?.email || 'Người dùng';
}

function userAvatar(user) {
  return user?.avatarUrl || user?.guardian_image || user?.user_image || user?.sis_photo || '';
}

function userRole(user) {
  const roles = user?.roles || [];
  if (roles.includes('Parent Portal User') || user?.guardian_id) return 'guardian';
  return 'teacher';
}

function normalizeEmail(value) {
  return value ? String(value).trim().toLowerCase() : '';
}

function normalizeId(value) {
  return value ? String(value).trim() : '';
}

function participantKey(user) {
  return String(user?._id || '');
}

function normalizeClassType(scope) {
  return String(scope?.classType || scope?.class_type || '').trim().toLowerCase();
}

function isRegularScope(scope) {
  return normalizeClassType(scope) === 'regular';
}

function matchesGuardianUser(user, guardian) {
  const userEmail = normalizeEmail(user?.email);
  const userGuardianId = normalizeId(user?.guardian_id);
  const guardianKeys = [
    guardian?.guardian_id,
    guardian?.name,
    guardian?.email,
    guardian?.portalEmail,
    ...(guardian?.matchKeys || []),
  ].map((value) => normalizeEmail(value));

  return Boolean(
    (userEmail && guardianKeys.includes(userEmail)) ||
    (userGuardianId && guardianKeys.includes(normalizeEmail(userGuardianId)))
  );
}

function scopeSummary(scope) {
  return {
    classId: scope.classId,
    className: scope.className || scope.classTitle || scope.classId,
    schoolYearId: scope.schoolYearId,
    schoolYearName: scope.schoolYearName || scope.schoolYearTitle || scope.schoolYearId,
    classType: normalizeClassType(scope),
    studentId: scope.studentId,
    studentName: scope.studentName,
  };
}

function buildFallbackGuardianScope(scope, user) {
  const student = {
    student_id: scope.studentId,
    student_name: scope.studentName,
  };
  const guardian = {
    name: user?.guardian_id || user?.email,
    guardian_id: user?.guardian_id,
    guardian_name: userDisplayName(user),
    email: user?.email,
    portalEmail: user?.email,
    guardian_image: userAvatar(user),
    students: scope.studentId ? [student] : [],
    matchKeys: [user?.email, user?.guardian_id].filter(Boolean).map((value) => String(value).toLowerCase()),
  };

  return {
    classId: scope.classId,
    className: scope.className || scope.classTitle || scope.classId,
    schoolYearId: scope.schoolYearId,
    schoolYearName: scope.schoolYearName || scope.schoolYearTitle || scope.schoolYearId,
    classType: normalizeClassType(scope),
    isActive: scope.isActive !== false,
    students: scope.studentId ? [student] : [],
    guardians: user ? [guardian] : [],
    teachers: [],
  };
}

async function attachMongoUsers({ teachers, guardians }) {
  const teacherEmails = teachers.map((teacher) => normalizeEmail(teacher.email)).filter(Boolean);
  const guardianEmails = guardians
    .flatMap((guardian) => [guardian.email, guardian.portalEmail])
    .map(normalizeEmail)
    .filter(Boolean);
  const guardianIds = guardians.map((guardian) => normalizeId(guardian.guardian_id)).filter(Boolean);

  const users = await User.find({
    $or: [
      ...(teacherEmails.length ? [{ email: { $in: teacherEmails } }] : []),
      ...(guardianEmails.length ? [{ email: { $in: guardianEmails } }] : []),
      ...(guardianIds.length ? [{ guardian_id: { $in: guardianIds } }] : []),
    ],
  }).select(USER_SELECT);

  const byEmail = new Map(users.map((user) => [normalizeEmail(user.email), user]));
  const byGuardianId = new Map(users.filter((user) => user.guardian_id).map((user) => [normalizeId(user.guardian_id), user]));

  return { byEmail, byGuardianId };
}

function buildCurrentTeacherParticipant(user) {
  if (!user || userRole(user) !== 'teacher') return null;
  return {
    user: user._id,
    email: normalizeEmail(user.email),
    name: userDisplayName(user),
    role: 'teacher',
    avatarUrl: userAvatar(user),
  };
}

function buildCurrentGuardianSnapshot(user, trustedScope) {
  if (!user || userRole(user) !== 'guardian') return null;
  const studentId = trustedScope?.studentId;
  return {
    name: user.guardian_id || user.email,
    guardian_id: user.guardian_id,
    guardian_name: userDisplayName(user),
    email: normalizeEmail(user.email),
    portalEmail: normalizeEmail(user.email),
    guardian_image: userAvatar(user),
    students: studentId
      ? [{
        student_id: studentId,
        student_name: trustedScope?.studentName,
      }]
      : [],
    matchKeys: [user.email, user.guardian_id]
      .filter(Boolean)
      .map((value) => normalizeEmail(value)),
  };
}

function getStudentId(student) {
  return student?.student_id || student?.studentId || student?.name;
}

function getStudentName(student) {
  return student?.student_name || student?.studentName || student?.name || getStudentId(student);
}

function studentConversationType(studentId) {
  return `student_guardians:${studentId}`;
}

async function buildConversationPayload(scope, type, requestUser, targetStudent) {
  const targetStudentId = getStudentId(targetStudent);
  const guardians = targetStudentId
    ? (scope.guardians || []).filter((guardian) => (
      (guardian.students || []).some((student) => getStudentId(student) === targetStudentId)
    ))
    : scope.guardians || [];
  const teachers = scope.teachers || [];
  const { byEmail, byGuardianId } = await attachMongoUsers({ teachers, guardians });

  const teacherSnapshots = teachers.map((teacher) => ({
    email: normalizeEmail(teacher.email),
    name: teacher.name || teacher.email || teacher.teacherId,
    teacherId: teacher.teacherId,
    avatarUrl: teacher.avatarUrl || '',
  }));

  const guardianSnapshots = guardians.map((guardian) => ({
    email: normalizeEmail(guardian.email || guardian.portalEmail),
    name: guardian.guardian_name || guardian.name || guardian.email || guardian.portalEmail,
    guardianId: guardian.guardian_id || guardian.name,
    studentIds: targetStudentId
      ? [targetStudentId]
      : (guardian.students || []).map((student) => getStudentId(student)).filter(Boolean),
    avatarUrl: guardian.guardian_image || '',
  }));

  const teacherParticipants = teacherSnapshots.map((teacher) => {
    const user = byEmail.get(normalizeEmail(teacher.email));
    return {
      user: user?._id,
      email: teacher.email,
      name: teacher.name,
      role: 'teacher',
      teacherId: teacher.teacherId,
      avatarUrl: teacher.avatarUrl || userAvatar(user),
    };
  });
  const currentTeacherParticipant = buildCurrentTeacherParticipant(requestUser);
  if (currentTeacherParticipant) {
    const hasCurrentTeacher = teacherParticipants.some((participant) => (
      (participant.user && String(participant.user) === String(currentTeacherParticipant.user)) ||
      (participant.email && participant.email === currentTeacherParticipant.email)
    ));
    if (!hasCurrentTeacher) {
      teacherParticipants.push(currentTeacherParticipant);
      teacherSnapshots.push({
        email: currentTeacherParticipant.email,
        name: currentTeacherParticipant.name,
        avatarUrl: currentTeacherParticipant.avatarUrl,
      });
    }
  }

  const guardianParticipants = guardianSnapshots.map((guardian) => {
    const user = byEmail.get(normalizeEmail(guardian.email)) || byGuardianId.get(normalizeId(guardian.guardianId));
    return {
      user: user?._id,
      email: guardian.email || normalizeEmail(user?.email),
      name: guardian.name,
      role: 'guardian',
      guardianId: guardian.guardianId,
      studentIds: guardian.studentIds,
      avatarUrl: guardian.avatarUrl || userAvatar(user),
    };
  });

  const className = scope.className || scope.classTitle || scope.classId;
  const schoolYearName = scope.schoolYearName || scope.schoolYearTitle || scope.schoolYearId;
  const title = type === 'class_general'
    ? `${className} - ${schoolYearName}`
    : `GVCN ${getStudentName(targetStudent)} - ${className}`;

  return {
    type,
    title,
    classId: scope.classId,
    className,
    schoolYearId: scope.schoolYearId,
    schoolYearName,
    status: scope.isActive === false ? 'locked' : 'active',
    lockedReason: scope.isActive === false ? 'Lớp/năm học cũ chỉ cho xem lại lịch sử' : undefined,
    participants: [...teacherParticipants, ...guardianParticipants],
    studentIds: targetStudentId
      ? [targetStudentId]
      : (scope.students || []).map((student) => getStudentId(student)).filter(Boolean),
    guardians: guardianSnapshots,
    teachers: teacherSnapshots,
  };
}

async function ensureClassConversations({ classId, schoolYearId, token, trustedScope, user }) {
  // Với guardian, token Parent Portal chỉ dùng để lấy scope hợp lệ trước đó.
  // Sau khi đã verify scope, đọc metadata lớp bằng service key để tránh Frappe Resource API trả 403.
  let scope;
  try {
    scope = await frappeService.getClassChatScope(classId, schoolYearId, trustedScope ? null : token);
  } catch (error) {
    if (!trustedScope) throw error;
    console.warn('[Chat] Không đọc được metadata lớp bằng service key, dùng scope guardian fallback:', {
      classId,
      schoolYearId,
      status: error?.response?.status,
      message: error.message,
    });
    scope = buildFallbackGuardianScope(trustedScope, user);
  }
  if (!scope?.classId || !scope?.schoolYearId) {
    const err = new Error('Không tìm thấy lớp/năm học để tạo nhóm chat');
    err.statusCode = 404;
    throw err;
  }
  if (!isRegularScope(scope)) {
    return [];
  }

  if (trustedScope) {
    scope.className = trustedScope.className || scope.className;
    scope.schoolYearName = trustedScope.schoolYearName || scope.schoolYearName;
  }

  if (trustedScope?.studentId && userRole(user) === 'guardian') {
    const hasTrustedStudent = (scope.students || []).some((student) => getStudentId(student) === trustedScope.studentId);
    if (!hasTrustedStudent) {
      scope.students = [
        ...(scope.students || []),
        {
          student_id: trustedScope.studentId,
          student_name: trustedScope.studentName,
        },
      ];
    }

    const hasCurrentGuardian = (scope.guardians || []).some((guardian) => matchesGuardianUser(user, guardian));
    if (!hasCurrentGuardian) {
      const currentGuardian = buildCurrentGuardianSnapshot(user, trustedScope);
      if (currentGuardian) {
        scope.guardians = [...(scope.guardians || []), currentGuardian];
      }
    }
  }

  const scopedStudents = trustedScope?.studentId && userRole(user) === 'guardian'
    ? (scope.students || []).filter((student) => getStudentId(student) === trustedScope.studentId)
    : (scope.students || []);
  const conversationSpecs = [
    { type: 'class_general' },
    ...scopedStudents
      .map((student) => ({ type: studentConversationType(getStudentId(student)), student }))
      .filter((spec) => spec.type !== 'student_guardians:undefined'),
  ];

  const conversations = [];
  for (const spec of conversationSpecs) {
    const payload = await buildConversationPayload(scope, spec.type, user, spec.student);
    const conversation = await ChatConversation.findOneAndUpdate(
      { classId: payload.classId, schoolYearId: payload.schoolYearId, type: payload.type },
      {
        $set: {
          title: payload.title,
          className: payload.className,
          schoolYearName: payload.schoolYearName,
          status: payload.status,
          lockedReason: payload.lockedReason,
          participants: payload.participants,
          studentIds: payload.studentIds,
          guardians: payload.guardians,
          teachers: payload.teachers,
        },
        $setOnInsert: {
          classId: payload.classId,
          schoolYearId: payload.schoolYearId,
          type: payload.type,
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    conversations.push(conversation);
  }

  return conversations;
}

function canAccessConversation(conversation, user) {
  const userId = String(user?._id || '');
  const userEmail = normalizeEmail(user?.email);
  const userGuardianId = normalizeId(user?.guardian_id);

  return (conversation.participants || []).some((participant) => {
    if (participant.user && String(participant.user) === userId) return true;
    if (participant.email && normalizeEmail(participant.email) === userEmail) return true;
    if (participant.guardianId && normalizeId(participant.guardianId) === userGuardianId) return true;
    return false;
  });
}

async function getConversationForUser(conversationId, user) {
  const conversation = await ChatConversation.findById(conversationId);
  if (!conversation || !canAccessConversation(conversation, user)) {
    const err = new Error('Bạn không có quyền truy cập nhóm chat này');
    err.statusCode = 403;
    throw err;
  }
  return conversation;
}

function serializeConversation(conversation, user) {
  const plain = conversation.toObject ? conversation.toObject() : conversation;
  const key = participantKey(user);
  const unreadCounts = plain.unreadCounts || {};
  const unreadCount = unreadCounts instanceof Map
    ? unreadCounts.get(key) || 0
    : unreadCounts[key] || 0;
  return {
    ...plain,
    unreadCount,
  };
}

async function emitToConversation(conversation, event, payload) {
  if (!global.io) return;
  const rooms = getChatBroadcastRooms(conversation);
  // Union nhiều room: dùng chuỗi .to() — ổn định với @socket.io/redis-adapter hơn io.to([...]).
  ioEmitToRoomsUnion(global.io, rooms, event, payload);
}

exports.listConversations = async (req, res) => {
  try {
    const token = getBearerToken(req);
    const { classId, schoolYearId } = req.query;
    let conversations = [];

    if (classId) {
      conversations = await ensureClassConversations({ classId, schoolYearId, token, user: req.user });
    } else {
      const scopes = await frappeService.getGuardianChatScopes(token);
      const uniqueScopes = new Map();
      scopes
        .filter(isRegularScope)
        .forEach((scope) => {
          if (!scope.classId || !scope.schoolYearId) return;
          uniqueScopes.set(`${scope.studentId || 'all'}:${scope.classId}:${scope.schoolYearId}`, scopeSummary(scope));
        });

      for (const scope of uniqueScopes.values()) {
        const ensured = await ensureClassConversations({
          classId: scope.classId,
          schoolYearId: scope.schoolYearId,
          token: null,
          trustedScope: scope,
          user: req.user,
        });
        conversations.push(...ensured);
      }
    }

    const uniqueConversations = Array.from(new Map(
      conversations.map((conversation) => [String(conversation._id), conversation])
    ).values());

    const visible = uniqueConversations
      .filter((conversation) => canAccessConversation(conversation, req.user))
      .sort((a, b) => new Date(b.lastMessage?.createdAt || b.updatedAt) - new Date(a.lastMessage?.createdAt || a.updatedAt));

    res.json({ success: true, data: visible.map((conversation) => serializeConversation(conversation, req.user)) });
  } catch (error) {
    console.error('[Chat] listConversations error:', error);
    res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Không thể tải nhóm chat' });
  }
};

exports.getMessages = async (req, res) => {
  try {
    const conversation = await getConversationForUser(req.params.conversationId, req.user);
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '30', 10), 1), 100);
    const skip = (page - 1) * limit;

    const [messages, total] = await Promise.all([
      ChatMessage.find({ conversation: conversation._id, isDeleted: false })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('sender', USER_SELECT),
      ChatMessage.countDocuments({ conversation: conversation._id, isDeleted: false }),
    ]);

    res.json({
      success: true,
      data: {
        messages: messages.reverse(),
        pagination: {
          currentPage: page,
          totalPages: Math.ceil(total / limit),
          totalMessages: total,
          hasNext: page < Math.ceil(total / limit),
        },
        conversation: serializeConversation(conversation, req.user),
      },
    });
  } catch (error) {
    console.error('[Chat] getMessages error:', error);
    res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Không thể tải tin nhắn' });
  }
};

exports.sendMessage = async (req, res) => {
  try {
    const conversation = await getConversationForUser(req.params.conversationId, req.user);
    if (conversation.status === 'locked') {
      return res.status(423).json({ success: false, message: 'Nhóm chat năm học cũ chỉ cho xem lại lịch sử' });
    }

    const content = String(req.body.content || '').trim();
    if (!content) {
      return res.status(400).json({ success: false, message: 'Nội dung tin nhắn không được để trống' });
    }

    let replyTo;
    if (req.body.replyTo) {
      const replyMessage = await ChatMessage.findOne({
        _id: req.body.replyTo,
        conversation: conversation._id,
        isDeleted: false,
      });
      if (replyMessage) {
        replyTo = {
          messageId: replyMessage._id,
          content: replyMessage.content,
          senderName: replyMessage.senderSnapshot?.name,
        };
      }
    }

    const message = await ChatMessage.create({
      conversation: conversation._id,
      sender: req.user._id,
      senderSnapshot: {
        name: userDisplayName(req.user),
        email: req.user.email,
        role: userRole(req.user),
        avatarUrl: userAvatar(req.user),
      },
      content,
      replyTo,
      readBy: [{ user: req.user._id, readAt: new Date() }],
    });

    const unreadCounts = conversation.unreadCounts || new Map();
    (conversation.participants || []).forEach((participant) => {
      if (!participant.user) return;
      const key = String(participant.user);
      if (key === String(req.user._id)) {
        unreadCounts.set(key, 0);
      } else {
        unreadCounts.set(key, (unreadCounts.get(key) || 0) + 1);
      }
    });

    conversation.lastMessage = {
      messageId: message._id,
      content: message.content,
      senderName: message.senderSnapshot.name,
      senderId: req.user._id,
      createdAt: message.createdAt,
    };
    conversation.unreadCounts = unreadCounts;
    await conversation.save();

    const populated = await ChatMessage.findById(message._id).populate('sender', USER_SELECT);
    await emitToConversation(conversation, 'chat:message', {
      conversation: serializeConversation(conversation, req.user),
      message: populated,
    });

    res.status(201).json({ success: true, data: { message: populated, conversation: serializeConversation(conversation, req.user) } });
  } catch (error) {
    console.error('[Chat] sendMessage error:', error);
    res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Không thể gửi tin nhắn' });
  }
};

exports.markRead = async (req, res) => {
  try {
    const conversation = await getConversationForUser(req.params.conversationId, req.user);
    const key = participantKey(req.user);
    conversation.unreadCounts = conversation.unreadCounts || new Map();
    conversation.unreadCounts.set(key, 0);
    await conversation.save();

    await ChatMessage.updateMany(
      {
        conversation: conversation._id,
        'readBy.user': { $ne: req.user._id },
      },
      { $push: { readBy: { user: req.user._id, readAt: new Date() } } }
    );

    await emitToConversation(conversation, 'chat:read', {
      conversationId: String(conversation._id),
      userId: String(req.user._id),
    });

    res.json({ success: true, data: serializeConversation(conversation, req.user) });
  } catch (error) {
    console.error('[Chat] markRead error:', error);
    res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Không thể đánh dấu đã đọc' });
  }
};

exports.canAccessConversation = canAccessConversation;
