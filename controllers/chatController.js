const mongoose = require('mongoose');
const ChatConversation = require('../models/ChatConversation');
const ChatMessage = require('../models/ChatMessage');
const User = require('../models/User');
const frappeService = require('../services/frappeService');
const {
  getChatBroadcastRooms,
  ioEmitToEachRoom,
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

function parentPortalEmailFromGuardianId(guardianId) {
  const normalized = normalizeId(guardianId).toLowerCase();
  return normalized ? `${normalized}@parent.wellspring.edu.vn` : '';
}

function portalGuardianIdFromEmail(email) {
  const normalized = normalizeEmail(email);
  const suffix = '@parent.wellspring.edu.vn';
  return normalized.endsWith(suffix) ? normalized.slice(0, -suffix.length) : '';
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

/**
 * Gom scope guardian cùng lớp + năm: một lần `ensureClassConversations` → một lần gọi Frappe + ít log PM2.
 */
function mergeTrustedScopesForSameClass(summaries) {
  if (!summaries?.length) return null;
  const mergedStudents = [];
  const seen = new Set();
  for (const s of summaries) {
    if (s.studentId && !seen.has(s.studentId)) {
      seen.add(s.studentId);
      mergedStudents.push({
        student_id: s.studentId,
        student_name: s.studentName || s.studentId,
      });
    }
  }
  return {
    ...summaries[0],
    _mergedStudents: mergedStudents,
  };
}

function buildFallbackGuardianScope(scope, user) {
  const students = scope._mergedStudents?.length
    ? scope._mergedStudents.map((x) => ({
      student_id: x.student_id,
      student_name: x.student_name,
    }))
    : (scope.studentId
      ? [{
        student_id: scope.studentId,
        student_name: scope.studentName,
      }]
      : []);
  const guardian = {
    name: user?.guardian_id || user?.email,
    guardian_id: user?.guardian_id,
    guardian_name: userDisplayName(user),
    email: user?.email,
    portalEmail: user?.email,
    guardian_image: userAvatar(user),
    students,
    matchKeys: [user?.email, user?.guardian_id].filter(Boolean).map((value) => String(value).toLowerCase()),
  };

  return {
    classId: scope.classId,
    className: scope.className || scope.classTitle || scope.classId,
    schoolYearId: scope.schoolYearId,
    schoolYearName: scope.schoolYearName || scope.schoolYearTitle || scope.schoolYearId,
    classType: normalizeClassType(scope),
    isActive: scope.isActive !== false,
    students,
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
  const guardianId = user.guardian_id || portalGuardianIdFromEmail(user.email);
  const students = trustedScope?._mergedStudents?.length
    ? trustedScope._mergedStudents.map((s) => ({
      student_id: s.student_id,
      student_name: s.student_name,
    }))
    : (trustedScope?.studentId
      ? [{
        student_id: trustedScope.studentId,
        student_name: trustedScope?.studentName,
      }]
      : []);
  return {
    name: guardianId || user.email,
    guardian_id: guardianId,
    guardian_name: userDisplayName(user),
    email: normalizeEmail(user.email),
    portalEmail: normalizeEmail(user.email),
    guardian_image: userAvatar(user),
    students,
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
    const matchedRequestGuardian = userRole(requestUser) === 'guardian' && matchesGuardianUser(requestUser, {
      guardian_id: guardian.guardianId,
      name: guardian.guardianId || guardian.name,
      email: guardian.email,
      portalEmail: parentPortalEmailFromGuardianId(guardian.guardianId),
    });
    const user = matchedRequestGuardian
      ? requestUser
      : byEmail.get(normalizeEmail(guardian.email)) || byGuardianId.get(normalizeId(guardian.guardianId));
    return {
      user: user?._id,
      email: normalizeEmail(user?.email) || guardian.email,
      name: guardian.name,
      role: 'guardian',
      guardianId: guardian.guardianId || user?.guardian_id || portalGuardianIdFromEmail(user?.email),
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

// ===== Helpers cho merge membership (tránh ghi đè participants/teachers/guardians khi scope thiếu) =====
//
// Lý do: ensureClassConversations đang gọi findOneAndUpdate với $set: { participants, teachers, guardians }
// trên scope của REQUESTER. Khi requester là parent (mobile/web portal) và scope.teachers rỗng
// (do fallback hoặc Frappe Resource API trả 403), participants bị ghi đè làm teacher đang chat
// MẤT QUYỀN truy cập conversation -> 403 "Bạn không có quyền truy cập nhóm chat này".
//
// Fix: chuyển từ REPLACE sang UNION cho membership (participants/teachers/guardians/studentIds).
// Việc revoke khỏi roster phải làm ở flow đồng bộ riêng (cron / webhook), không phải ở read-path.

/** Khóa định danh participant để dedup khi merge. Phân biệt theo role. */
function participantIdentityKey(p) {
  if (!p) return '';
  const role = p.role || '';
  if (p.user) return `${role}|user:${String(p.user).toLowerCase()}`;
  const email = normalizeEmail(p.email);
  if (email) return `${role}|email:${email}`;
  if (role === 'teacher' && p.teacherId) return `teacher|tid:${normalizeId(p.teacherId).toLowerCase()}`;
  if (role === 'guardian' && p.guardianId) return `guardian|gid:${normalizeId(p.guardianId).toLowerCase()}`;
  return `${role}|name:${normalizeId(p.name).toLowerCase()}`;
}

/** Khóa định danh snapshot teacher. */
function teacherSnapshotKey(t) {
  if (!t) return '';
  const email = normalizeEmail(t.email);
  if (email) return `email:${email}`;
  if (t.teacherId) return `tid:${normalizeId(t.teacherId).toLowerCase()}`;
  return `name:${normalizeId(t.name).toLowerCase()}`;
}

/** Khóa định danh snapshot guardian. */
function guardianSnapshotKey(g) {
  if (!g) return '';
  if (g.guardianId) return `gid:${normalizeId(g.guardianId).toLowerCase()}`;
  const email = normalizeEmail(g.email);
  if (email) return `email:${email}`;
  return `name:${normalizeId(g.name).toLowerCase()}`;
}

/**
 * Union 2 array theo key. Entry trùng key được merge bằng `mergeFn(oldEntry, newEntry)` —
 * mặc định: incoming ghi đè field truthy, fallback giữ field cũ; KHÔNG xoá entry cũ.
 */
function unionByKey(existing, incoming, getKey, mergeFn) {
  const map = new Map();
  for (const item of existing || []) {
    const key = getKey(item);
    if (key) map.set(key, item);
  }
  for (const item of incoming || []) {
    const key = getKey(item);
    if (!key) continue;
    const prev = map.get(key);
    map.set(key, prev ? mergeFn(prev, item) : item);
  }
  return Array.from(map.values());
}

/** Merge field-by-field cho participant (giữ user._id cũ nếu incoming thiếu). */
function mergeParticipantFields(oldP, newP) {
  return {
    ...oldP,
    ...newP,
    user: newP.user || oldP.user,
    email: normalizeEmail(newP.email) || normalizeEmail(oldP.email),
    name: newP.name || oldP.name,
    role: newP.role || oldP.role,
    teacherId: newP.teacherId || oldP.teacherId,
    guardianId: newP.guardianId || oldP.guardianId,
    avatarUrl: newP.avatarUrl || oldP.avatarUrl,
    studentIds: Array.from(new Set([
      ...((oldP.studentIds || []).map(String)),
      ...((newP.studentIds || []).map(String)),
    ])).filter(Boolean),
  };
}

/** Merge field-by-field cho snapshot teacher/guardian. */
function mergeSnapshotFields(oldS, newS) {
  return {
    ...oldS,
    ...newS,
    email: normalizeEmail(newS.email) || normalizeEmail(oldS.email),
    name: newS.name || oldS.name,
    teacherId: newS.teacherId || oldS.teacherId,
    guardianId: newS.guardianId || oldS.guardianId,
    avatarUrl: newS.avatarUrl || oldS.avatarUrl,
    studentIds: Array.from(new Set([
      ...((oldS.studentIds || []).map(String)),
      ...((newS.studentIds || []).map(String)),
    ])).filter(Boolean),
  };
}

/** Đếm participants theo role (để log cảnh báo khi scope mới rớt teacher). */
function countParticipantsByRole(participants, role) {
  return (participants || []).filter((p) => p?.role === role).length;
}

async function ensureClassConversations({ classId, schoolYearId, token, trustedScope, user }) {
  const isGuardian = userRole(user) === 'guardian';
  let scope;

  try {
    if (isGuardian && token) {
      // Parent Portal JWT không phải Bearer Frappe: gửi qua X-Parent-Portal-Token + API key để đọc roster lớp.
      try {
        scope = await frappeService.getClassChatScope(classId, schoolYearId, { parentPortalToken: token });
      } catch (portalErr) {
        console.debug('[Chat] getClassChatScope với Parent Portal token thất bại — thử service key', {
          classId,
          schoolYearId,
          status: portalErr?.response?.status,
          message: portalErr.message,
        });
        scope = await frappeService.getClassChatScope(classId, schoolYearId, null);
      }
    } else {
      // Giáo viên: Bearer Frappe. PH không token (hiếm): chỉ service key.
      const auth = trustedScope && isGuardian ? null : token;
      scope = await frappeService.getClassChatScope(classId, schoolYearId, auth);
    }
  } catch (error) {
    if (!trustedScope || !isGuardian) throw error;
    console.debug('[Chat] Không đọc được scope lớp từ Frappe — fallback PH tối thiểu', {
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

  if (trustedScope && userRole(user) === 'guardian') {
    const mergedIds = trustedScope._mergedStudents?.length
      ? trustedScope._mergedStudents.map((s) => s.student_id).filter(Boolean)
      : (trustedScope.studentId ? [trustedScope.studentId] : []);

    for (const studentId of mergedIds) {
      const hasTrustedStudent = (scope.students || []).some((student) => getStudentId(student) === studentId);
      if (!hasTrustedStudent) {
        const stMeta = trustedScope._mergedStudents?.find((x) => x.student_id === studentId);
        scope.students = [
          ...(scope.students || []),
          {
            student_id: studentId,
            student_name: stMeta?.student_name || trustedScope.studentName,
          },
        ];
      }
    }

    if (mergedIds.length > 0) {
      const hasCurrentGuardian = (scope.guardians || []).some((guardian) => matchesGuardianUser(user, guardian));
      if (!hasCurrentGuardian) {
        const currentGuardian = buildCurrentGuardianSnapshot(user, trustedScope);
        if (currentGuardian) {
          scope.guardians = [...(scope.guardians || []), currentGuardian];
        }
      }
    }
  }

  const scopedStudents = (() => {
    if (trustedScope?._mergedStudents?.length && userRole(user) === 'guardian') {
      const idSet = new Set(trustedScope._mergedStudents.map((s) => s.student_id));
      return (scope.students || []).filter((student) => idSet.has(getStudentId(student)));
    }
    if (trustedScope?.studentId && userRole(user) === 'guardian') {
      return (scope.students || []).filter((student) => getStudentId(student) === trustedScope.studentId);
    }
    return scope.students || [];
  })();
  const conversationSpecs = [
    { type: 'class_general' },
    ...scopedStudents
      .map((student) => ({ type: studentConversationType(getStudentId(student)), student }))
      .filter((spec) => spec.type !== 'student_guardians:undefined'),
  ];

  const conversations = [];
  for (const spec of conversationSpecs) {
    const payload = await buildConversationPayload(scope, spec.type, user, spec.student);

    // Đọc existing TRƯỚC để merge membership (UNION) thay vì REPLACE.
    // .lean() để không trả Mongoose Document — chỉ cần dữ liệu thuần.
    const existing = await ChatConversation.findOne({
      classId: payload.classId,
      schoolYearId: payload.schoolYearId,
      type: payload.type,
    }).lean();

    // Cảnh báo khi scope hiện tại rớt teacher mà existing đang có — đây là dấu hiệu
    // bug gốc ở getClassChatScope/fallback. Sau fix vẫn LOG để monitor tần suất.
    if (existing) {
      const existingTeacherCount = countParticipantsByRole(existing.participants, 'teacher');
      const newTeacherCount = countParticipantsByRole(payload.participants, 'teacher');
      if (existingTeacherCount > 0 && newTeacherCount === 0) {
        console.debug('[Chat] Scope mới không có teacher — preserve teachers từ existing', {
          conversationId: String(existing._id),
          classId: payload.classId,
          schoolYearId: payload.schoolYearId,
          type: payload.type,
          existingTeacherCount,
          requesterEmail: user?.email,
          requesterRole: userRole(user),
          usingFallback: !!trustedScope,
        });
      }
    }

    const mergedParticipants = unionByKey(
      existing?.participants,
      payload.participants,
      participantIdentityKey,
      mergeParticipantFields,
    );
    const mergedTeachers = unionByKey(
      existing?.teachers,
      payload.teachers,
      teacherSnapshotKey,
      mergeSnapshotFields,
    );
    const mergedGuardians = unionByKey(
      existing?.guardians,
      payload.guardians,
      guardianSnapshotKey,
      mergeSnapshotFields,
    );
    const mergedStudentIds = Array.from(new Set([
      ...((existing?.studentIds || []).map(String)),
      ...((payload.studentIds || []).map(String)),
    ])).filter(Boolean);

    const conversation = await ChatConversation.findOneAndUpdate(
      { classId: payload.classId, schoolYearId: payload.schoolYearId, type: payload.type },
      {
        $set: {
          // Metadata vẫn REPLACE (không phải membership)
          title: payload.title,
          className: payload.className,
          schoolYearName: payload.schoolYearName,
          status: payload.status,
          lockedReason: payload.lockedReason,
          // Membership: dùng kết quả đã UNION với existing (nếu có)
          participants: mergedParticipants,
          studentIds: mergedStudentIds,
          guardians: mergedGuardians,
          teachers: mergedTeachers,
        },
        $setOnInsert: {
          classId: payload.classId,
          schoolYearId: payload.schoolYearId,
          type: payload.type,
        },
      },
      // Chỉ bản ghi mới (upsert) mới auto timestamps; update membership không bump updatedAt
      // (nếu bump thì mọi nhóm "Chưa có tin" lên đầu vì updatedAt=now, thua lastMessage.createdAt cũ).
      { new: true, upsert: true, setDefaultsOnInsert: true, timestamps: !existing },
    );
    conversations.push(conversation);
  }

  return conversations;
}

function canAccessConversation(conversation, user) {
  const userId = String(user?._id || '');
  const userEmail = normalizeEmail(user?.email);
  // PHHS đăng nhập portal có email <guardianId>@parent.wellspring.edu.vn nhưng socket.user.guardian_id thường undefined.
  // Suy ra guardianId từ email để khớp với participants được lưu theo guardianId.
  const userGuardianId =
    normalizeId(user?.guardian_id).toLowerCase() || portalGuardianIdFromEmail(userEmail);
  // Email portal suy ra từ guardian_id (chiều ngược) cho user có guardian_id thật.
  const userPortalEmailFromGuardian = userGuardianId
    ? parentPortalEmailFromGuardianId(userGuardianId)
    : '';

  return (conversation.participants || []).some((participant) => {
    if (participant.user && String(participant.user) === userId) return true;

    const partEmail = normalizeEmail(participant.email);
    if (partEmail && partEmail === userEmail) return true;

    const partGuardianId = normalizeId(participant.guardianId).toLowerCase();
    if (partGuardianId && userGuardianId && partGuardianId === userGuardianId) return true;

    // Cross-match: participant lưu email portal, user có guardianId — và ngược lại.
    if (
      partEmail &&
      userGuardianId &&
      portalGuardianIdFromEmail(partEmail) === userGuardianId
    ) {
      return true;
    }
    if (
      partGuardianId &&
      userPortalEmailFromGuardian &&
      parentPortalEmailFromGuardianId(partGuardianId) === userPortalEmailFromGuardian
    ) {
      return true;
    }
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

/** Số tin chưa đọc của user (sort API trước khi serialize). */
function conversationUnreadCountForUser(conversation, user) {
  const plain = conversation.toObject ? conversation.toObject() : conversation;
  const key = participantKey(user);
  const unreadCounts = plain.unreadCounts || {};
  const raw = unreadCounts instanceof Map
    ? unreadCounts.get(key)
    : unreadCounts[key];
  return Math.max(0, Number(raw || 0));
}

/** Thời gian hoạt động để sort list: tin cuối rồi updatedAt; tránh NaN; bằng nhau sort _id ở caller. */
function conversationActivityMillisForSort(doc) {
  const lm = doc.lastMessage?.createdAt;
  if (lm) {
    const t = new Date(lm).getTime();
    if (Number.isFinite(t)) return t;
  }
  const u = doc.updatedAt;
  if (u) {
    const t = new Date(u).getTime();
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

async function emitToConversation(conversation, event, payload) {
  if (!global.io) return;
  const rooms = getChatBroadcastRooms(conversation);
  // Union: phát lần lượt mỗi room (ổn định với redis-adapter hơn một lần io.to([...])).
  ioEmitToEachRoom(global.io, rooms, event, payload);
}

/** Emoji reaction cố định (đồng bộ với mobile / web). */
const CHAT_REACTION_EMOJIS = new Set(['clap', 'joy', 'cry', 'surprised', 'party', 'sleepy']);

/** Cửa sổ thu hồi tin (ms) — chỉ người gửi, sau khi gửi. */
const RECALL_WINDOW_MS = 15 * 60 * 1000;

function serializeReactionsForApi(reactions) {
  if (!reactions?.length) return [];
  return reactions.map((r) => ({
    user: r.user ? String(r.user) : undefined,
    email: r.email || '',
    name: r.name || '',
    emoji: r.emoji,
    createdAt: (r.createdAt ? new Date(r.createdAt) : new Date()).toISOString(),
  }));
}

async function loadMessageWithAccess(messageId, user) {
  const id = String(messageId || '').trim();
  if (!mongoose.Types.ObjectId.isValid(id)) {
    const err = new Error('Tin nhắn không hợp lệ');
    err.statusCode = 400;
    throw err;
  }
  const message = await ChatMessage.findOne({ _id: id, isDeleted: false });
  if (!message) {
    const err = new Error('Không tìm thấy tin nhắn');
    err.statusCode = 404;
    throw err;
  }
  const conversation = await getConversationForUser(message.conversation, user);
  return { message, conversation };
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

      const byClassYear = new Map();
      for (const s of uniqueScopes.values()) {
        const k = `${s.classId}\0${s.schoolYearId}`;
        if (!byClassYear.has(k)) byClassYear.set(k, []);
        byClassYear.get(k).push(s);
      }

      for (const group of byClassYear.values()) {
        const mergedTrusted = mergeTrustedScopesForSameClass(group);
        const ensured = await ensureClassConversations({
          classId: mergedTrusted.classId,
          schoolYearId: mergedTrusted.schoolYearId,
          token,
          trustedScope: mergedTrusted,
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
      .sort((a, b) => {
        const rb = conversationUnreadCountForUser(b, req.user) > 0 ? 1 : 0;
        const ra = conversationUnreadCountForUser(a, req.user) > 0 ? 1 : 0;
        if (rb !== ra) return rb - ra;
        const db = conversationActivityMillisForSort(b);
        const da = conversationActivityMillisForSort(a);
        if (db !== da) return db - da;
        return String(a._id).localeCompare(String(b._id));
      });

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
      senderEmail: normalizeEmail(message.senderSnapshot.email),
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

/** Bật/tắt reaction emoji trên tin (1 user / 1 emoji; emoji lặp ⇒ gỡ). */
exports.toggleReaction = async (req, res) => {
  try {
    const emoji = String(req.body.emoji || '').trim();
    if (!CHAT_REACTION_EMOJIS.has(emoji)) {
      return res.status(400).json({ success: false, message: 'Emoji không hợp lệ' });
    }
    const { message, conversation } = await loadMessageWithAccess(req.params.messageId, req.user);
    if (message.recalledAt) {
      return res.status(400).json({ success: false, message: 'Tin nhắn đã thu hồi' });
    }
    if (conversation.status === 'locked') {
      return res.status(423).json({ success: false, message: 'Nhóm chat chỉ cho xem lại lịch sử' });
    }

    const uid = String(req.user._id);
    const others = (message.reactions || []).filter((r) => String(r.user) !== uid);
    const prev = (message.reactions || []).find((r) => String(r.user) === uid);

    let nextReactions;
    if (prev) {
      if (prev.emoji === emoji) {
        nextReactions = others;
      } else {
        nextReactions = [
          ...others,
          {
            user: req.user._id,
            email: normalizeEmail(req.user.email),
            name: userDisplayName(req.user),
            emoji,
            createdAt: new Date(),
          },
        ];
      }
    } else {
      nextReactions = [
        ...others,
        {
          user: req.user._id,
          email: normalizeEmail(req.user.email),
          name: userDisplayName(req.user),
          emoji,
          createdAt: new Date(),
        },
      ];
    }

    message.reactions = nextReactions;
    message.markModified('reactions');
    await message.save();

    const serialized = serializeReactionsForApi(message.reactions);
    await emitToConversation(conversation, 'chat:message:reaction', {
      conversationId: String(conversation._id),
      messageId: String(message._id),
      reactions: serialized,
    });

    res.json({ success: true, data: { messageId: String(message._id), reactions: serialized } });
  } catch (error) {
    console.error('[Chat] toggleReaction error:', error);
    res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Không thể cập nhật reaction' });
  }
};

/** Thu hồi tin: chỉ người gửi, trong RECALL_WINDOW_MS. */
exports.recallMessage = async (req, res) => {
  try {
    const { message, conversation } = await loadMessageWithAccess(req.params.messageId, req.user);
    if (message.recalledAt) {
      return res.status(400).json({ success: false, message: 'Tin nhắn đã được thu hồi trước đó' });
    }
    if (conversation.status === 'locked') {
      return res.status(423).json({ success: false, message: 'Nhóm chat chỉ cho xem lại lịch sử' });
    }
    if (String(message.sender) !== String(req.user._id)) {
      return res.status(403).json({ success: false, message: 'Chỉ người gửi mới thu hồi được tin nhắn' });
    }
    const age = Date.now() - new Date(message.createdAt).getTime();
    if (age > RECALL_WINDOW_MS) {
      return res.status(403).json({
        success: false,
        message: 'Tin nhắn đã quá thời gian thu hồi (15 phút)',
      });
    }

    message.recalledAt = new Date();
    message.recalledBy = req.user._id;
    await message.save();

    if (
      conversation.lastMessage
      && conversation.lastMessage.messageId
      && String(conversation.lastMessage.messageId) === String(message._id)
    ) {
      conversation.lastMessage.content = '';
      conversation.markModified('lastMessage');
      await conversation.save();
    }

    await emitToConversation(conversation, 'chat:message:recalled', {
      conversationId: String(conversation._id),
      messageId: String(message._id),
      recalledAt: message.recalledAt.toISOString(),
      recalledBy: String(req.user._id),
    });

    res.json({
      success: true,
      data: {
        messageId: String(message._id),
        recalledAt: message.recalledAt.toISOString(),
        recalledBy: String(req.user._id),
      },
    });
  } catch (error) {
    console.error('[Chat] recallMessage error:', error);
    res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Không thể thu hồi tin nhắn' });
  }
};

exports.canAccessConversation = canAccessConversation;
