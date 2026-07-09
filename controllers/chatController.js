const mongoose = require('mongoose');
const ChatConversation = require('../models/ChatConversation');
const ChatMessage = require('../models/ChatMessage');
const User = require('../models/User');
const frappeService = require('../services/frappeService');
const {
  getChatBroadcastRooms,
  ioEmitToEachRoom,
} = require('../utils/chatBroadcastRooms');
const {
  cacheGetJSON,
  cacheSetJSON,
  cacheDel,
  cacheDelByPattern,
  TTL_CHAT_LIST_SEC,
  TTL_MSG_COUNT_SEC,
} = require('../utils/cache');

const USER_SELECT = 'fullname fullName email avatarUrl user_image sis_photo guardian_image guardian_id roles role';

/** Chuẩn hoá tin trả API/socket: không populate User — client dùng senderSnapshot (+ _id sender). */
function messagePayloadForApi(doc) {
  const m = doc?.toObject ? doc.toObject() : { ...doc };
  const uid = m.sender;
  const snap = m.senderSnapshot || {};
  m.sender = {
    _id: uid,
    fullname: snap.name,
    fullName: snap.name,
    email: snap.email || '',
    avatarUrl: snap.avatarUrl || '',
  };
  return m;
}

/** Khoá Redis đếm tin (TTL ngắn, invalidate khi gửi/thu hồi xoá…) */
function messageCountRedisKey(conversationId) {
  return `chat:msgcount:${String(conversationId)}`;
}

function chatConversationListCacheKey(userId, classId, schoolYearId) {
  const u = String(userId || '');
  const c = classId ? String(classId).trim() : '_';
  const y = schoolYearId ? String(schoolYearId).trim() : '_';
  return `chat:conv:${u}:${encodeURIComponent(c)}:${encodeURIComponent(y)}`;
}

async function invalidateConversationParticipantsListCaches(conversation) {
  const parts = conversation?.participants || [];
  const uniq = new Set(parts.filter((p) => p.user).map((p) => String(p.user)));
  await Promise.all([...uniq].map((uid) => cacheDelByPattern(`chat:conv:${String(uid)}:*`)));
}


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

/**
 * BOD (Ban giám hiệu/HĐQT) — quan sát viên: đọc mọi hội thoại theo ROLE,
 * không bao giờ nằm trong participants, không được ghi (send/markRead/reaction/pin...).
 */
function isBodUser(user) {
  const roles = user?.roles || [];
  return roles.includes('SIS BOD') || roles.includes('Mobile BOD');
}

/** Participant đang active (chưa bị soft-remove bởi sync roster). */
function isActiveParticipant(p) {
  return Boolean(p) && !p.removedAt;
}

function normalizeEmail(value) {
  return value ? String(value).trim().toLowerCase() : '';
}

/** Email người nhận từ participants, loại người gửi — gửi push qua notification-service. */
function chatRecipientEmails(conversation, senderEmail) {
  const senderNorm = normalizeEmail(senderEmail);
  const seen = new Set();
  const emails = [];
  for (const p of conversation.participants || []) {
    if (!isActiveParticipant(p)) continue;
    const raw = p.email;
    if (!raw) continue;
    const n = normalizeEmail(raw);
    if (!n || n === senderNorm) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    emails.push(String(raw).trim());
  }
  return emails;
}

/** Gửi notify chat qua notification-service — fire-and-forget. */
function fireChatToFrappe(eventType, payload) {
  frappeService.sendChatNotification(eventType, payload).catch(() => {});
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

/**
 * Tạo mảng điều kiện $or Mongo để tìm hội thoại mà user là participant
 * (khớp hướng canAccessConversation: user._id, email, guardianId, portal email).
 */
function buildParticipantMatchOr(user) {
  const or = [];
  const rawId = user?._id;
  if (rawId && mongoose.Types.ObjectId.isValid(String(rawId))) {
    const oid = new mongoose.Types.ObjectId(String(rawId));
    or.push({ 'participants.user': oid });
  }
  const userEmail = normalizeEmail(user?.email);
  const userGuardianId =
    normalizeId(user?.guardian_id).toLowerCase() || portalGuardianIdFromEmail(userEmail);
  const emails = new Set();
  if (userEmail) emails.add(userEmail);
  const portalEmailNorm = userGuardianId
    ? normalizeEmail(parentPortalEmailFromGuardianId(userGuardianId))
    : '';
  if (portalEmailNorm) emails.add(portalEmailNorm);
  if (emails.size) {
    or.push({ 'participants.email': { $in: [...emails] } });
  }
  const guardianIds = new Set();
  if (userGuardianId) guardianIds.add(userGuardianId);
  const rawGid = normalizeId(user?.guardian_id);
  if (rawGid) guardianIds.add(rawGid.toLowerCase());
  if (guardianIds.size) {
    or.push({ 'participants.guardianId': { $in: [...guardianIds] } });
  }
  return or.length ? or : [{ _id: null }];
}

function participantKey(user) {
  return String(user?._id || '');
}

/** Soft ẩn danh sách: lấy ngày user (participantKey Mongo _id) đã ẩn hội thoại này. */
function conversationHiddenFromListAt(conversation, userKey) {
  const raw = conversation.hiddenFromListAtByUserId;
  if (!raw || !userKey || !mongoose.Types.ObjectId.isValid(userKey)) return null;
  if (raw instanceof Map) {
    const hit = raw.get(userKey);
    return hit ? new Date(hit) : null;
  }
  const v = raw[userKey];
  return v ? new Date(v) : null;
}

function isConversationHiddenFromCurrentUserList(conversation, user) {
  const pk = participantKey(user);
  return Boolean(conversationHiddenFromListAt(conversation, pk));
}

/** Tin xuất hiện — gỡ ẩn danh sách cho mọi người tham gia khác người gửi tin. */
function pruneHiddenFromListForRecipients(conversation, senderMongoUserIdStr) {
  const raw = conversation.hiddenFromListAtByUserId;
  if (!raw || !(conversation.participants || []).some((p) => p.user)) return;
  let map = raw instanceof Map ? new Map(raw) : new Map(Object.entries(raw));
  const senderNorm = String(senderMongoUserIdStr || '');
  for (const p of conversation.participants || []) {
    if (!p?.user) continue;
    const k = String(p.user);
    if (!k || k === senderNorm) continue;
    map.delete(k);
  }
  conversation.hiddenFromListAtByUserId = map;
  conversation.markModified('hiddenFromListAtByUserId');
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

/** Chuẩn hóa mảng môn dạy lưu snapshot Mongo. */
function compactSubjectSnapshots(subjects) {
  if (!Array.isArray(subjects)) return [];
  return subjects
    .map((s) => ({
      id: String(s?.id || '').trim(),
      title: String(s?.title || s?.name || '').trim(),
    }))
    .filter((s) => s.title);
}

/** Tên HS (không trùng, giữ thứ tự) từ mảng students của guardian trong scope Frappe. */
function studentNamesFromScopeGuardian(guardian) {
  const students = guardian?.students || [];
  const out = [];
  const seen = new Set();
  for (const st of students) {
    const n = String(getStudentName(st) || '').trim();
    if (!n) continue;
    const k = n.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(n);
  }
  return out;
}

function studentConversationType(studentId) {
  return `student_guardians:${studentId}`;
}

/** Gộp GVCN + phó + GVBM từ scope Frappe (journal trả `subject_teachers`). */
function collectScopeTeachers(scope) {
  const raw = [...(scope.teachers || []), ...(scope.subject_teachers || [])];
  const byId = new Map();
  for (const t of raw) {
    const id = normalizeId(t.teacherId || t.name);
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, t);
  }
  return Array.from(byId.values());
}

function teacherIdAllowedInScope(scope, teacherId) {
  return collectScopeTeachers(scope).some((t) => normalizeId(t.teacherId) === normalizeId(teacherId));
}

function normalizeTeacherSnapshot(t) {
  if (!t) return null;
  return {
    teacherId: normalizeId(t.teacherId || t.name),
    email: normalizeEmail(t.email),
    name: t.name || t.teacherId || '',
    avatarUrl: t.avatarUrl || '',
    userId: t.userId || '',
    userName: t.userName || '',
    subjects: Array.isArray(t.subjects) ? t.subjects : [],
  };
}

function findTeacherSnapshotInScope(scope, teacherId) {
  const t = collectScopeTeachers(scope).find((x) => normalizeId(x.teacherId) === normalizeId(teacherId));
  return normalizeTeacherSnapshot(t);
}

/** Map user đăng nhập → teacherId trong scope lớp.
 *
 * Ưu tiên dùng `callerTeacherId` mà Frappe đã resolve sẵn (nếu có).
 * Nếu không có, lần lượt thử match theo email → userId → userName để chống lệch
 * khi `User.email` ≠ giá trị `SIS Teacher.user_id`.
 */
function resolveCallerTeacherIdFromScope(user, scope) {
  const callerTid = normalizeId(scope?.callerTeacherId);
  if (callerTid) return callerTid;

  const userEmail = normalizeEmail(user?.email);
  const userIdLower = String(user?.email || '').trim().toLowerCase();
  for (const t of collectScopeTeachers(scope)) {
    if (userEmail && normalizeEmail(t.email) === userEmail) return normalizeId(t.teacherId);
  }
  for (const t of collectScopeTeachers(scope)) {
    const tUserId = String(t.userId || '').trim().toLowerCase();
    const tUserName = String(t.userName || '').trim().toLowerCase();
    if (userIdLower && (tUserId === userIdLower || tUserName === userIdLower)) {
      return normalizeId(t.teacherId);
    }
  }
  return '';
}

/** Payload nhóm chat 1 GV + tập guardian chọn trước (1-1 hoặc cha mẹ + nhiều PH). */
async function buildSubsetConversationPayload(scope, type, requestUser, {
  teachers,
  guardians,
  title,
  studentIds = [],
}) {
  const { byEmail, byGuardianId } = await attachMongoUsers({ teachers, guardians });

  const teacherSnapshots = teachers.map((teacher) => {
    const norm = normalizeTeacherSnapshot(teacher) || {};
    return {
      email: normalizeEmail(norm.email || teacher.email),
      name: norm.name || teacher.name || teacher.email || teacher.teacherId,
      teacherId: norm.teacherId || normalizeId(teacher.teacherId || teacher.name),
      avatarUrl: norm.avatarUrl || teacher.avatarUrl || '',
      subjects: compactSubjectSnapshots(norm.subjects || teacher.subjects),
    };
  });

  const guardianSnapshots = guardians.map((guardian) => ({
    email: normalizeEmail(guardian.email || guardian.portalEmail),
    name: guardian.guardian_name || guardian.name || guardian.email || guardian.portalEmail,
    guardianId: guardian.guardian_id || guardian.name,
    studentIds: (guardian.students || []).map((student) => getStudentId(student)).filter(Boolean),
    studentNames: studentNamesFromScopeGuardian(guardian),
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
      const tid = resolveCallerTeacherIdFromScope(requestUser, scope);
      teacherSnapshots.push({
        email: currentTeacherParticipant.email,
        name: currentTeacherParticipant.name,
        teacherId: tid || normalizeId(teachers[0]?.teacherId),
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
    const mongoUser = matchedRequestGuardian
      ? requestUser
      : byEmail.get(normalizeEmail(guardian.email)) || byGuardianId.get(normalizeId(guardian.guardianId));
    return {
      user: mongoUser?._id,
      email: normalizeEmail(mongoUser?.email) || guardian.email,
      name: guardian.name,
      role: 'guardian',
      guardianId: guardian.guardianId || mongoUser?.guardian_id || portalGuardianIdFromEmail(mongoUser?.email),
      studentIds: guardian.studentIds,
      avatarUrl: guardian.avatarUrl || userAvatar(mongoUser),
    };
  });

  const className = scope.className || scope.classTitle || scope.classId;
  const schoolYearName = scope.schoolYearName || scope.schoolYearTitle || scope.schoolYearId;

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
    studentIds: [...studentIds].map(String).filter(Boolean),
    guardians: guardianSnapshots,
    teachers: teacherSnapshots,
  };
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

  const teacherSnapshots = teachers.map((teacher) => {
    const norm = normalizeTeacherSnapshot(teacher) || {};
    return {
      email: normalizeEmail(norm.email || teacher.email),
      name: norm.name || teacher.name || teacher.email || teacher.teacherId,
      teacherId: norm.teacherId || normalizeId(teacher.teacherId || teacher.name),
      avatarUrl: norm.avatarUrl || teacher.avatarUrl || '',
      subjects: compactSubjectSnapshots(norm.subjects || teacher.subjects),
    };
  });

  const guardianSnapshots = guardians.map((guardian) => {
    const studentIdsResolved = targetStudentId
      ? [targetStudentId]
      : (guardian.students || []).map((student) => getStudentId(student)).filter(Boolean);
    let studentNamesResolved = studentNamesFromScopeGuardian(guardian);
    if (targetStudentId) {
      const st = (guardian.students || []).find(
        (x) => String(getStudentId(x)) === String(targetStudentId),
      );
      const one = st ? String(getStudentName(st) || '').trim() : '';
      studentNamesResolved = one ? [one] : [];
    }
    return {
      email: normalizeEmail(guardian.email || guardian.portalEmail),
      name: guardian.guardian_name || guardian.name || guardian.email || guardian.portalEmail,
      guardianId: guardian.guardian_id || guardian.name,
      studentIds: studentIdsResolved,
      studentNames: studentNamesResolved,
      avatarUrl: guardian.guardian_image || '',
    };
  });

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
    // Xuất hiện lại trong scope (mọi scope đều roster-derived) ⇒ tự khôi phục quyền.
    removedAt: null,
    removedReason: undefined,
  };
}

/** Merge field-by-field cho snapshot teacher/guardian. */
function mergeSnapshotFields(oldS, newS) {
  const mergedSubjects = (() => {
    const next = compactSubjectSnapshots(newS?.subjects);
    if (next.length) return next;
    return compactSubjectSnapshots(oldS?.subjects);
  })();
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
    studentNames: Array.from(new Set([
      ...((oldS.studentNames || []).map(String)),
      ...((newS.studentNames || []).map(String)),
    ])).map((s) => String(s).trim()).filter(Boolean),
    subjects: mergedSubjects,
    removedAt: null,
  };
}

/** Đếm participants theo role (để log cảnh báo khi scope mới rớt teacher). */
function countParticipantsByRole(participants, role) {
  return (participants || []).filter((p) => p?.role === role).length;
}

/**
 * Upsert conversation theo payload — UNION membership với bản ghi Mongo hiện có.
 */
async function upsertMergedConversationFromPayload(payload) {
  const existing = await ChatConversation.findOne({
    classId: payload.classId,
    schoolYearId: payload.schoolYearId,
    type: payload.type,
  }).lean();

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

  return ChatConversation.findOneAndUpdate(
    { classId: payload.classId, schoolYearId: payload.schoolYearId, type: payload.type },
    {
      $set: {
        title: payload.title,
        className: payload.className,
        schoolYearName: payload.schoolYearName,
        status: payload.status,
        lockedReason: payload.lockedReason,
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
    { new: true, upsert: true, setDefaultsOnInsert: true, timestamps: !existing },
  );
}

function findScopeGuardianById(scope, guardianId) {
  const gid = normalizeId(guardianId);
  return (scope.guardians || []).find((g) => {
    const gGid = normalizeId(g.guardian_id);
    if (gGid && gGid === gid) return true;
    const gEmail = normalizeEmail(g.email || g.portalEmail);
    if (gEmail && gEmail === normalizeEmail(parentPortalEmailFromGuardianId(gid))) return true;
    return false;
  });
}

async function ensureClassConversations({ classId, schoolYearId, token, trustedScope, user }) {
  const isGuardian = userRole(user) === 'guardian';
  let scope;

  try {
    if (isGuardian && token) {
      // Parent Portal JWT không phải Bearer Frappe: gửi qua X-Parent-Portal-Token + API key để đọc roster lớp.
      try {
        scope = await frappeService.getClassChatScope(classId, schoolYearId, { parentPortalToken: token }, { bypassCache: true });
      } catch (portalErr) {
        console.debug('[Chat] getClassChatScope với Parent Portal token thất bại — thử service key', {
          classId,
          schoolYearId,
          status: portalErr?.response?.status,
          message: portalErr.message,
        });
        scope = await frappeService.getClassChatScope(classId, schoolYearId, null, { bypassCache: true });
      }
    } else {
      // Giáo viên: Bearer Frappe. PH không token (hiếm): chỉ service key.
      const auth = trustedScope && isGuardian ? null : token;
      scope = await frappeService.getClassChatScope(classId, schoolYearId, auth, { bypassCache: true });
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

  // Chỉ tạo / duy trì nhóm chung lớp; nhóm GVCN–PH theo từng HS (student_guardians:) đã bỏ — dùng endpoint on-demand.
  const conversationSpecs = [{ type: 'class_general' }];

  const conversations = [];
  for (const spec of conversationSpecs) {
    const payload = await buildConversationPayload(scope, spec.type, user, spec.student);
    const conversation = await upsertMergedConversationFromPayload(payload);
    conversations.push(conversation);
  }

  // Gỡ cache Frappe lớp/năm sau khi đồng bộ Mongo — request sau lấy roster mới nhất.
  frappeService.invalidateCachesForClassChat(scope.classId, scope.schoolYearId).catch(() => {});

  for (const c of conversations) {
    invalidateConversationParticipantsListCaches(c).catch(() => {});
  }

  return conversations;
}

/**
 * User có phải THÀNH VIÊN active của hội thoại không — điều kiện cho mọi thao tác GHI
 * (send/markRead/reaction/pin/typing). Khác canAccessConversation: BOD KHÔNG bypass —
 * user lai GV+BOD vẫn nhắn được ở lớp mình dạy, nhưng chỉ-xem ở hội thoại khác.
 */
function isConversationParticipant(conversation, user) {
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

  return (conversation.participants || []).filter(isActiveParticipant).some((participant) => {
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

/** Quyền ĐỌC hội thoại: thành viên active, hoặc BOD (silent observer — đọc theo role). */
function canAccessConversation(conversation, user) {
  if (isBodUser(user)) return true;
  return isConversationParticipant(conversation, user);
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

/**
 * Chặn thao tác GHI khi user KHÔNG phải thành viên (chỉ BOD observer mới lọt tới đây,
 * vì non-BOD không phải thành viên đã bị 403 ở getConversationForUser). Trả true nếu đã chặn.
 */
function rejectObserverWrite(conversation, req, res) {
  if (isConversationParticipant(conversation, req.user)) return false;
  res.status(403).json({ success: false, message: 'Tài khoản chỉ có quyền xem' });
  return true;
}

/** Chuẩn hóa pinnedMessage cho JSON + socket (ObjectId → string, date → ISO). */
function serializePinnedMessage(raw) {
  if (!raw || !raw.messageId) return null;
  const plain = raw.toObject ? raw.toObject() : raw;
  return {
    messageId: String(plain.messageId),
    contentPreview: String(plain.contentPreview || '').slice(0, 500),
    attachmentsCount: Math.max(0, Number(plain.attachmentsCount) || 0),
    senderName: plain.senderName || '',
    senderEmail: plain.senderEmail || '',
    avatarUrl: plain.avatarUrl || '',
    pinnedBy: plain.pinnedBy || '',
    pinnedAt: plain.pinnedAt ? new Date(plain.pinnedAt).toISOString() : new Date().toISOString(),
  };
}

function serializeConversation(conversation, user) {
  const plain = conversation.toObject ? conversation.toObject() : conversation;
  const key = participantKey(user);
  const unreadCounts = plain.unreadCounts || {};
  const unreadCount = unreadCounts instanceof Map
    ? unreadCounts.get(key) || 0
    : unreadCounts[key] || 0;
  const base = {
    ...plain,
    unreadCount,
    pinnedMessage: plain.pinnedMessage
      ? serializePinnedMessage(plain.pinnedMessage)
      : null,
  };
  delete base.hiddenFromListAtByUserId;
  return base;
}

/** Tách teacherId + guardianId từ `type` dạng `teacher_guardian:<tid>:<gid>`. */
function parseTeacherGuardianTypeSegments(convType) {
  const raw = String(convType || '');
  const prefix = 'teacher_guardian:';
  if (!raw.startsWith(prefix)) {
    return { teacherId: '', guardianId: '' };
  }
  const rest = raw.slice(prefix.length);
  const i = rest.indexOf(':');
  if (i < 0) return { teacherId: rest, guardianId: '' };
  return { teacherId: rest.slice(0, i), guardianId: rest.slice(i + 1) };
}

/**
 * Hội thoại GV–PH chưa ghi Mongo — client mở composer; tin đầu gọi `sendTeacherGuardianMessage`.
 */
function serializeDraftTeacherGuardianConversation(payload, user) {
  const { teacherId, guardianId } = parseTeacherGuardianTypeSegments(payload.type);
  const nowIso = new Date().toISOString();
  const participants = (payload.participants || []).map((p) => ({
    ...p,
    user: p.user ? String(p.user) : undefined,
  }));
  const draft = {
    classId: payload.classId,
    schoolYearId: payload.schoolYearId,
    teacherId,
    guardianId,
  };
  const plain = {
    _id: '',
    isDraft: true,
    draft,
    type: payload.type,
    title: payload.title,
    classId: payload.classId,
    className: payload.className,
    schoolYearId: payload.schoolYearId,
    schoolYearName: payload.schoolYearName,
    studentIds: payload.studentIds,
    status: payload.status,
    lockedReason: payload.lockedReason,
    participants,
    guardians: payload.guardians,
    teachers: payload.teachers,
    unreadCount: 0,
    pinnedMessage: null,
    lastMessage: undefined,
    updatedAt: nowIso,
  };
  return serializeConversation(plain, user);
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

/** Emoji reaction cố định — đồng bộ journal Wislife (parent-portal) / class feed. */
const CHAT_REACTION_EMOJIS = new Set(['like', 'love', 'haha', 'wow', 'sad', 'angry']);

function attachmentKindFromMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  return 'file';
}

/** Chỉ chấp nhận URL đã upload qua /uploads/chat/ (chống URL tùy ý). */
function sanitizeIncomingAttachments(raw) {
  if (!Array.isArray(raw) || !raw.length) return [];
  const out = [];
  for (const a of raw.slice(0, 10)) {
    const url = String(a.url || '').trim();
    if (!url.startsWith('/uploads/chat/')) continue;
    let kind = a.kind;
    if (kind !== 'image' && kind !== 'file' && kind !== 'video') {
      kind = attachmentKindFromMime(a.mimeType);
    }
    out.push({
      kind,
      url,
      name: String(a.name || 'file').trim().slice(0, 220),
      mimeType: String(a.mimeType || '').trim().slice(0, 120),
      size: Math.max(0, Math.min(Number(a.size) || 0, 200 * 1024 * 1024)),
      width: Number.isFinite(Number(a.width)) ? Number(a.width) : undefined,
      height: Number.isFinite(Number(a.height)) ? Number(a.height) : undefined,
    });
  }
  return out;
}

/** Nội dung hiển thị trong lastMessage / reply quote khi tin không có text. */
function lastMessageContentPreview(content, attachments) {
  const c = String(content || '').trim();
  if (c) {
    // Sticker Wislife — ẩn chuỗi wire {:wislife:…:}
    if (/^\{:wislife:[a-z0-9_]+:\}$/i.test(c)) return '[Emoji]';
    return c;
  }
  const atts = attachments || [];
  if (!atts.length) return '';
  const hasImage = atts.some((x) => x.kind === 'image');
  const hasVideo = atts.some((x) => x.kind === 'video');
  if (hasImage) return '[Hình ảnh]';
  if (hasVideo) return '[Video]';
  return '[Tệp đính kèm]';
}

function messageSnippetForReply(msg) {
  const plain = msg?.toObject ? msg.toObject() : msg;
  const c = String(plain.content || '').trim();
  if (c) {
    if (/^\{:wislife:[a-z0-9_]+:\}$/i.test(c)) return '[Emoji]';
    return c.slice(0, 500);
  }
  if (plain.attachments?.length) return lastMessageContentPreview('', plain.attachments);
  return '';
}

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

/**
 * Chuẩn bị payload hội thoại GV↔PH (kiểm quyền + scope). Lỗi ném Error kèm `statusCode`.
 */
async function buildTeacherGuardianPayloadFromRequest(req) {
  const token = getBearerToken(req);
  const body = req.body || {};
  const classId = body.classId;
  const schoolYearId = body.schoolYearId;
  const teacherIdRaw = body.teacherId;
  const guardianIdBody = body.guardianId;

  if (!classId || !schoolYearId || !teacherIdRaw) {
    const err = new Error('Thiếu classId, schoolYearId hoặc teacherId');
    err.statusCode = 400;
    throw err;
  }

  const isGuardian = userRole(req.user) === 'guardian';
  const isTeacher = userRole(req.user) === 'teacher';
  if (!isGuardian && !isTeacher) {
    const err = new Error('Không được phép');
    err.statusCode = 403;
    throw err;
  }

  let scope;
  if (isGuardian && token) {
    try {
      scope = await frappeService.getClassChatScope(classId, schoolYearId, { parentPortalToken: token }, { bypassCache: true });
    } catch (portalErr) {
      scope = await frappeService.getClassChatScope(classId, schoolYearId, null, { bypassCache: true });
    }
  } else {
    scope = await frappeService.getClassChatScope(classId, schoolYearId, token, { bypassCache: true });
  }

  if (!scope?.classId || !scope?.schoolYearId) {
    const err = new Error('Không tìm thấy lớp/năm học');
    err.statusCode = 404;
    throw err;
  }
  if (!isRegularScope(scope)) {
    const err = new Error('Lớp không hỗ trợ chat nhóm');
    err.statusCode = 400;
    throw err;
  }

  const teacherId = normalizeId(teacherIdRaw);
  if (!teacherIdAllowedInScope(scope, teacherId)) {
    const err = new Error('Giáo viên không thuộc lớp này');
    err.statusCode = 403;
    throw err;
  }

  const teacherSnap = findTeacherSnapshotInScope(scope, teacherId);
  if (!teacherSnap || !teacherSnap.teacherId) {
    const err = new Error('Không tìm thấy thông tin giáo viên');
    err.statusCode = 404;
    throw err;
  }

  let resolvedGuardianId = '';
  if (isGuardian) {
    const selfGid = normalizeId(req.user.guardian_id) || portalGuardianIdFromEmail(req.user.email);
    if (guardianIdBody && normalizeId(guardianIdBody) !== selfGid) {
      const err = new Error('guardianId không khớp tài khoản');
      err.statusCode = 403;
      throw err;
    }
    resolvedGuardianId = selfGid;
  } else {
    if (!guardianIdBody) {
      const err = new Error('Thiếu guardianId');
      err.statusCode = 400;
      throw err;
    }
    resolvedGuardianId = normalizeId(guardianIdBody);
    const callerTid = resolveCallerTeacherIdFromScope(req.user, scope);
    if (!callerTid || normalizeId(callerTid) !== normalizeId(teacherId)) {
      const err = new Error('teacherId không khớp tài khoản giáo viên');
      err.statusCode = 403;
      throw err;
    }
  }

  if (!resolvedGuardianId) {
    const err = new Error('Không xác định được phụ huynh');
    err.statusCode = 400;
    throw err;
  }

  const guardianRow = findScopeGuardianById(scope, resolvedGuardianId);
  if (!guardianRow) {
    const err = new Error('Phụ huynh không thuộc roster lớp');
    err.statusCode = 403;
    throw err;
  }

  if (isGuardian && !matchesGuardianUser(req.user, guardianRow)) {
    const err = new Error('Chỉ được mở chat với tài khoản của bạn');
    err.statusCode = 403;
    throw err;
  }

  const convType = `teacher_guardian:${teacherId}:${resolvedGuardianId}`;
  const gLabel = guardianRow.guardian_name || guardianRow.name || resolvedGuardianId;
  const title = `${teacherSnap.name} — ${gLabel}`;

  const payload = await buildSubsetConversationPayload(scope, convType, req.user, {
    teachers: [teacherSnap],
    guardians: [guardianRow],
    title,
    studentIds: [],
  });

  return { payload, classId: String(classId), schoolYearId: String(schoolYearId) };
}

/** Tạo tin, cập nhật lastMessage/unread, socket + webhook — dùng chung sendMessage và sendTeacherGuardianMessage. */
async function appendMessageToConversation(conversation, req, {
  content,
  attachments = [],
  replyToId,
}) {
  if (conversation.status === 'locked') {
    const err = new Error('Nhóm chat năm học cũ chỉ cho xem lại lịch sử');
    err.statusCode = 423;
    throw err;
  }

  const att = sanitizeIncomingAttachments(attachments);
  const c = String(content || '').trim();
  if (!c && !att.length) {
    const err = new Error('Nội dung hoặc tệp đính kèm là bắt buộc');
    err.statusCode = 400;
    throw err;
  }

  let replyTo;
  if (replyToId) {
    const replyMessage = await ChatMessage.findOne({
      _id: replyToId,
      conversation: conversation._id,
      isDeleted: false,
    });
    if (replyMessage) {
      replyTo = {
        messageId: replyMessage._id,
        content: messageSnippetForReply(replyMessage),
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
    content: c || '',
    attachments: att,
    replyTo,
    readBy: [{ user: req.user._id, readAt: new Date() }],
  });

  const unreadCounts = conversation.unreadCounts || new Map();
  (conversation.participants || []).forEach((participant) => {
    if (!isActiveParticipant(participant)) return;
    if (!participant.user) return;
    const key = String(participant.user);
    if (key === String(req.user._id)) {
      unreadCounts.set(key, 0);
    } else {
      unreadCounts.set(key, (unreadCounts.get(key) || 0) + 1);
    }
  });

  const lastPreview = lastMessageContentPreview(message.content, message.attachments);
  conversation.lastMessage = {
    messageId: message._id,
    content: lastPreview,
    senderName: message.senderSnapshot.name,
    senderEmail: normalizeEmail(message.senderSnapshot.email),
    senderId: req.user._id,
    createdAt: message.createdAt,
  };
  conversation.unreadCounts = unreadCounts;
  pruneHiddenFromListForRecipients(conversation, String(req.user._id));
  await conversation.save();

  cacheDel(messageCountRedisKey(conversation._id)).catch(() => {});
  invalidateConversationParticipantsListCaches(conversation).catch(() => {});

  const payloadMsg = messagePayloadForApi(message);
  await emitToConversation(conversation, 'chat:message', {
    conversation: serializeConversation(conversation, req.user),
    message: payloadMsg,
  });

  fireChatToFrappe('new_message', {
    conversationId: String(conversation._id),
    conversationType: conversation.type,
    messageId: String(message._id),
    senderEmail: req.user.email,
    senderName: message.senderSnapshot.name,
    senderRole: message.senderSnapshot.role,
    recipientEmails: chatRecipientEmails(conversation, req.user.email),
    messagePreview: (lastPreview || c || '').slice(0, 100),
    hasAttachment: att.length > 0,
    timestamp: new Date().toISOString(),
  });

  return { message: payloadMsg, conversation: serializeConversation(conversation, req.user) };
}

exports.listConversations = async (req, res) => {
  try {
    const token = getBearerToken(req);
    const { classId, schoolYearId } = req.query;

    // BOD observer: xem TOÀN BỘ hội thoại (nhóm lớp + 1-1) theo role — không ensure/scope,
    // không match participant, không cache Redis (ít user, query có tham số search).
    // CHỈ kích hoạt khi client yêu cầu rõ (?observer=1, trang /bod/messages) — user lai
    // GV+BOD mở "Nhắn tin" thường vẫn thấy inbox cá nhân bình thường.
    if (isBodUser(req.user) && String(req.query.observer || '') === '1') {
      const q = String(req.query.q || '').trim();
      const filter = {
        $or: [
          { type: 'class_general' },
          { type: { $regex: /^teacher_guardian:/ } },
        ],
      };
      if (classId) filter.classId = String(classId).trim();
      if (schoolYearId) filter.schoolYearId = String(schoolYearId).trim();
      if (q) {
        const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        filter.$and = [{
          $or: [
            { title: { $regex: safe, $options: 'i' } },
            { className: { $regex: safe, $options: 'i' } },
          ],
        }];
      }
      const rows = await ChatConversation.find(filter)
        .sort({ 'lastMessage.createdAt': -1, updatedAt: -1 })
        .limit(200);
      const visibleForBod = rows.filter((c) => {
        // 1-1 chưa có tin thì bỏ (như list thường) — BOD chỉ cần chat có nội dung.
        if (String(c.type || '').startsWith('teacher_guardian:')) {
          return Boolean(c.lastMessage && c.lastMessage.messageId);
        }
        return true;
      });
      return res.json({
        success: true,
        data: visibleForBod.map((c) => serializeConversation(c, req.user)),
      });
    }

    const listCacheKey = chatConversationListCacheKey(req.user._id, classId, schoolYearId);
    const cachedList = await cacheGetJSON(listCacheKey);
    if (cachedList?.payloads) {
      return res.json({ success: true, data: cachedList.payloads });
    }

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

    // Bổ sung các hội thoại user đã tham gia (vd. teacher_guardian:*) — ensureClassConversations chỉ tạo class_general.
    const participantOr = buildParticipantMatchOr(req.user);
    const userJoinedFilter = { $or: participantOr };
    if (classId) userJoinedFilter.classId = classId;
    if (schoolYearId) userJoinedFilter.schoolYearId = schoolYearId;
    const userJoinedConvs = await ChatConversation.find(userJoinedFilter)
      .sort({ updatedAt: -1 })
      .limit(200);
    conversations.push(...userJoinedConvs);

    const uniqueConversations = Array.from(new Map(
      conversations.map((conversation) => [String(conversation._id), conversation])
    ).values());

    const filtered = uniqueConversations
      .filter((conversation) => canAccessConversation(conversation, req.user))
      .filter((c) => {
        const t = String(c.type || '');
        // Ẩn legacy: nhóm tự sinh GVCN-PH cũ (`student_guardians:*`)
        // và nhóm GV+toàn bộ guardian theo HS (`teacher_student_guardians:*`) — đã thay bằng chat 1-1.
        if (t.startsWith('student_guardians:') || t.startsWith('teacher_student_guardians:')) {
          return false;
        }
        // Không hiển thị kênh GV↔PH chưa có tin (tránh "Chưa có tin nhắn" / bản ghi rỗng).
        if (t.startsWith('teacher_guardian:')) {
          const lm = c.lastMessage;
          if (!lm || !lm.messageId) return false;
        }
        if (isConversationHiddenFromCurrentUserList(c, req.user)) return false;
        return true;
      });

    // Thứ tự hoạt động cuối từ Mongo (P1.3 — lastMessage.updatedAt có index hỗ trợ sort).
    const idList = [...new Set(filtered.map((c) => String(c._id)))].filter((id) => mongoose.Types.ObjectId.isValid(id));
    let dbRank = new Map();
    if (idList.length) {
      const oids = idList.map((id) => new mongoose.Types.ObjectId(id));
      const sortedFromDb = await ChatConversation.find({ _id: { $in: oids } })
        .sort({ 'lastMessage.createdAt': -1, updatedAt: -1 })
        .select('_id')
        .lean();
      sortedFromDb.forEach((doc, idx) => {
        dbRank.set(String(doc._id), idx);
      });
    }

    const visible = filtered.sort((a, b) => {
      const ub = conversationUnreadCountForUser(b, req.user) > 0 ? 1 : 0;
      const ua = conversationUnreadCountForUser(a, req.user) > 0 ? 1 : 0;
      if (ub !== ua) return ub - ua;
      const ra = dbRank.get(String(a._id));
      const rb = dbRank.get(String(b._id));
      const fa = typeof ra === 'number' ? ra : Number.MAX_SAFE_INTEGER;
      const fb = typeof rb === 'number' ? rb : Number.MAX_SAFE_INTEGER;
      if (fa !== fb) return fa - fb;
      const dbAct = conversationActivityMillisForSort(b);
      const daAct = conversationActivityMillisForSort(a);
      if (dbAct !== daAct) return dbAct - daAct;
      return String(a._id).localeCompare(String(b._id));
    });

    const payloads = visible.map((conversation) => serializeConversation(conversation, req.user));
    cacheSetJSON(listCacheKey, { payloads }, TTL_CHAT_LIST_SEC).catch(() => {});

    res.json({ success: true, data: payloads });
  } catch (error) {
    console.error('[Chat] listConversations error:', error);
    res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Không thể tải nhóm chat' });
  }
};

/**
 * Tạo/lấy hội thoại 1-1: một GV + một PH (on-demand).
 * Chưa có hội thoại trong DB → trả bản nháp (không upsert); có rồi → merge snapshot như cũ.
 * Body: { classId, schoolYearId, teacherId, guardianId? } — PH không cần guardianId (suy từ token).
 */
exports.ensureTeacherGuardianConversation = async (req, res) => {
  try {
    // Không chặn theo role BOD: user lai GV+BOD vẫn tạo 1-1 ở lớp mình dạy;
    // BOD thuần không phải GV của lớp sẽ fail ở scope ACL trong buildTeacherGuardianPayloadFromRequest.
    const { payload, classId, schoolYearId } = await buildTeacherGuardianPayloadFromRequest(req);

    // Luôn persist hội thoại 1-1 (giống luồng nhóm) để trả về _id THẬT — mở/đọc tin không bị 404.
    // Trước đây khi chưa tồn tại thì trả draft _id:'' → FE gọi getMessages('') → URL `/conversations//messages`
    // → Express không match route → 404. Vẫn ẩn khỏi danh sách khi chưa có tin (filter listConversations
    // theo lastMessage.messageId) nên không làm rác list.
    const conversation = await upsertMergedConversationFromPayload(payload);
    frappeService.invalidateCachesForClassChat(classId, schoolYearId).catch(() => {});
    invalidateConversationParticipantsListCaches(conversation).catch(() => {});
    return res.json({ success: true, data: serializeConversation(conversation, req.user) });
  } catch (error) {
    console.error('[Chat] ensureTeacherGuardianConversation error:', error);
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Không thể tạo nhóm chat',
    });
  }
};

/**
 * Tin đầu (hoặc tiếp theo) trong kênh GV↔PH — upsert hội thoại rồi lưu tin.
 * Body giống ensure + { content, attachments?, replyTo? }.
 */
exports.sendTeacherGuardianMessage = async (req, res) => {
  try {
    // BOD thuần không phải GV/PH của lớp sẽ fail ở scope ACL bên trong; GV+BOD dùng bình thường.
    const { payload, classId, schoolYearId } = await buildTeacherGuardianPayloadFromRequest(req);

    let attachments = [];
    if (req.body.attachments != null) {
      if (typeof req.body.attachments === 'string') {
        try {
          attachments = JSON.parse(req.body.attachments);
        } catch (_) {
          attachments = [];
        }
      } else {
        attachments = req.body.attachments;
      }
    }

    const content = String(req.body.content || '').trim();
    const attSan = sanitizeIncomingAttachments(attachments);
    if (!content && !attSan.length) {
      return res.status(400).json({ success: false, message: 'Nội dung hoặc tệp đính kèm là bắt buộc' });
    }

    const conversation = await upsertMergedConversationFromPayload(payload);
    frappeService.invalidateCachesForClassChat(classId, schoolYearId).catch(() => {});
    invalidateConversationParticipantsListCaches(conversation).catch(() => {});

    const data = await appendMessageToConversation(conversation, req, {
      content,
      attachments: attSan,
      replyToId: req.body.replyTo,
    });

    res.status(201).json({ success: true, data });
  } catch (error) {
    console.error('[Chat] sendTeacherGuardianMessage error:', error);
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Không thể gửi tin nhắn',
    });
  }
};

/**
 * Upload đính kèm trước khi có conversationId — chỉ cho kênh GV↔PH (đã kiểm scope).
 */
exports.uploadTeacherGuardianAttachments = async (req, res) => {
  try {
    await buildTeacherGuardianPayloadFromRequest(req);
    const files = req.files || [];
    if (!files.length) {
      return res.status(400).json({ success: false, message: 'Không có tệp tải lên' });
    }
    const attachments = files.map((file) => ({
      kind: attachmentKindFromMime(file.mimetype),
      url: `/uploads/chat/${file.filename}`,
      name: String(file.originalname || file.filename || 'file').slice(0, 220),
      mimeType: file.mimetype || '',
      size: file.size || 0,
    }));
    res.json({ success: true, data: { attachments } });
  } catch (error) {
    console.error('[Chat] uploadTeacherGuardianAttachments error:', error);
    res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Không thể tải tệp' });
  }
};

// Đã loại bỏ: ensureTeacherStudentGuardiansConversation (GV + tất cả PH của 1 HS).
// Phía workspace giờ tạo chat 1-1 dùng chung endpoint `ensureTeacherGuardianConversation`.

exports.getMessages = async (req, res) => {
  try {
    const conversation = await getConversationForUser(req.params.conversationId, req.user);
    // Audit: BOD đọc hội thoại mình KHÔNG phải thành viên (observer) — ẩn với người dùng
    // nhưng tổ chức truy vết được. GV+BOD đọc nhóm của chính mình thì không log.
    if (isBodUser(req.user) && !isConversationParticipant(conversation, req.user)) {
      console.info('[Chat][BOD-AUDIT] read', {
        bodUserId: String(req.user._id),
        bodEmail: normalizeEmail(req.user.email),
        conversationId: String(conversation._id),
        conversationType: conversation.type,
        at: new Date().toISOString(),
      });
    }
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '30', 10), 1), 100);
    const skip = (page - 1) * limit;

    const baseQuery = { conversation: conversation._id, isDeleted: false };
    const ck = messageCountRedisKey(conversation._id);

    const loadRows = async (take) => ChatMessage.find(baseQuery)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(take)
      .lean();

    let messages;
    let total;
    let hasNext;

    if (page === 1) {
      const take = limit + 1;
      const rawRows = await loadRows(take);
      hasNext = rawRows.length > limit;
      messages = rawRows.slice(0, limit);

      const hit = await cacheGetJSON(ck);
      if (hit && typeof hit.total === 'number') {
        total = hit.total;
      } else {
        total = await ChatMessage.countDocuments(baseQuery);
        cacheSetJSON(ck, { total }, TTL_MSG_COUNT_SEC).catch(() => {});
      }
    } else {
      messages = await loadRows(limit + 1);
      hasNext = messages.length > limit;
      messages = messages.slice(0, limit);

      total = await ChatMessage.countDocuments(baseQuery);
    }

    res.json({
      success: true,
      data: {
        messages: messages.reverse().map((m) => messagePayloadForApi(m)),
        pagination: {
          currentPage: page,
          totalPages: Math.ceil(total / limit),
          totalMessages: total,
          hasNext,
        },
        conversation: serializeConversation(conversation, req.user),
      },
    });
  } catch (error) {
    console.error('[Chat] getMessages error:', error);
    res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Không thể tải tin nhắn' });
  }
};

exports.uploadAttachments = async (req, res) => {
  try {
    const conversation = await getConversationForUser(req.params.conversationId, req.user);
    if (rejectObserverWrite(conversation, req, res)) return;
    if (conversation.status === 'locked') {
      return res.status(423).json({ success: false, message: 'Nhóm chat năm học cũ chỉ cho xem lại lịch sử' });
    }
    const files = req.files || [];
    if (!files.length) {
      return res.status(400).json({ success: false, message: 'Không có tệp tải lên' });
    }
    const attachments = files.map((file) => ({
      kind: attachmentKindFromMime(file.mimetype),
      url: `/uploads/chat/${file.filename}`,
      name: String(file.originalname || file.filename || 'file').slice(0, 220),
      mimeType: file.mimetype || '',
      size: file.size || 0,
    }));
    res.json({ success: true, data: { attachments } });
  } catch (error) {
    console.error('[Chat] uploadAttachments error:', error);
    res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Không thể tải tệp' });
  }
};

exports.sendMessage = async (req, res) => {
  try {
    const conversation = await getConversationForUser(req.params.conversationId, req.user);
    if (rejectObserverWrite(conversation, req, res)) return;

    const content = String(req.body.content || '').trim();
    let attachments = [];
    if (req.body.attachments != null) {
      if (typeof req.body.attachments === 'string') {
        try {
          attachments = sanitizeIncomingAttachments(JSON.parse(req.body.attachments));
        } catch (_) {
          attachments = [];
        }
      } else {
        attachments = sanitizeIncomingAttachments(req.body.attachments);
      }
    }
    if (!content && !attachments.length) {
      return res.status(400).json({ success: false, message: 'Nội dung hoặc tệp đính kèm là bắt buộc' });
    }

    const data = await appendMessageToConversation(conversation, req, {
      content,
      attachments,
      replyToId: req.body.replyTo,
    });

    res.status(201).json({ success: true, data });
  } catch (error) {
    console.error('[Chat] sendMessage error:', error);
    res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Không thể gửi tin nhắn' });
  }
};

exports.markRead = async (req, res) => {
  try {
    const conversation = await getConversationForUser(req.params.conversationId, req.user);
    // Observer (BOD không phải thành viên) tuyệt đối không markRead:
    // readBy trả về mọi client + socket chat:read sẽ lộ việc BOD đang xem.
    if (rejectObserverWrite(conversation, req, res)) return;
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

    invalidateConversationParticipantsListCaches(conversation).catch(() => {});

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

/**
 * Ẩn hội thoại khỏi danh sách (soft — chỉ ghi nhận theo user, không xóa tin/group Mongo).
 */
exports.hideConversationFromList = async (req, res) => {
  try {
    const conversation = await getConversationForUser(req.params.conversationId, req.user);
    if (rejectObserverWrite(conversation, req, res)) return;
    const key = participantKey(req.user);
    if (!key || !mongoose.Types.ObjectId.isValid(key)) {
      return res.status(400).json({
        success: false,
        message: 'Không xác định được người dùng để ẩn nhóm chat',
      });
    }
    let hm = conversation.hiddenFromListAtByUserId;
    hm = hm instanceof Map ? new Map(hm) : new Map(Object.entries(hm || {}));
    hm.set(key, new Date());
    conversation.hiddenFromListAtByUserId = hm;
    conversation.markModified('hiddenFromListAtByUserId');
    await conversation.save();

    invalidateConversationParticipantsListCaches(conversation).catch(() => {});

    res.json({ success: true, message: 'Đã ẩn nhóm khỏi danh sách' });
  } catch (error) {
    console.error('[Chat] hideConversationFromList error:', error);
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Không thể ẩn nhóm chat',
    });
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
    if (rejectObserverWrite(conversation, req, res)) return;
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

    const isRemoval = prev && prev.emoji === emoji;
    if (!isRemoval) {
      fireChatToFrappe('message_reaction', {
        conversationId: String(conversation._id),
        conversationType: conversation.type,
        messageId: String(message._id),
        senderEmail: req.user.email,
        senderName: userDisplayName(req.user),
        senderRole: userRole(req.user),
        recipientEmails: chatRecipientEmails(conversation, req.user.email),
        messagePreview: '',
        hasAttachment: false,
        timestamp: new Date().toISOString(),
      });
    }

    res.json({ success: true, data: { messageId: String(message._id), reactions: serialized } });
  } catch (error) {
    console.error('[Chat] toggleReaction error:', error);
    res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Không thể cập nhật reaction' });
  }
};

/** Ghim 1 tin vào conversation (ghi đè ghim cũ). */
exports.pinMessage = async (req, res) => {
  try {
    const conversation = await getConversationForUser(req.params.conversationId, req.user);
    if (rejectObserverWrite(conversation, req, res)) return;
    if (conversation.status === 'locked') {
      return res.status(423).json({ success: false, message: 'Nhóm chat chỉ cho xem lại lịch sử' });
    }
    const messageId = String(req.body.messageId || '').trim();
    if (!mongoose.Types.ObjectId.isValid(messageId)) {
      return res.status(400).json({ success: false, message: 'Tin nhắn không hợp lệ' });
    }
    const message = await ChatMessage.findOne({
      _id: messageId,
      conversation: conversation._id,
      isDeleted: false,
    });
    if (!message) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy tin nhắn' });
    }
    if (message.recalledAt) {
      return res.status(400).json({ success: false, message: 'Không thể ghim tin đã thu hồi' });
    }

    conversation.pinnedMessage = {
      messageId: message._id,
      contentPreview: String(messageSnippetForReply(message) || '').slice(0, 140),
      attachmentsCount: Array.isArray(message.attachments) ? message.attachments.length : 0,
      senderName: message.senderSnapshot?.name || '',
      senderEmail: normalizeEmail(message.senderSnapshot?.email || ''),
      avatarUrl: String(message.senderSnapshot?.avatarUrl || '').slice(0, 500),
      pinnedBy: normalizeEmail(req.user.email),
      pinnedAt: new Date(),
    };
    conversation.markModified('pinnedMessage');
    await conversation.save();

    invalidateConversationParticipantsListCaches(conversation).catch(() => {});

    const pinned = serializePinnedMessage(conversation.pinnedMessage);
    await emitToConversation(conversation, 'chat:conversation:pinned', {
      conversationId: String(conversation._id),
      pinnedMessage: pinned,
      by: normalizeEmail(req.user.email),
    });

    res.json({
      success: true,
      data: {
        conversation: serializeConversation(conversation, req.user),
        pinnedMessage: pinned,
      },
    });
  } catch (error) {
    console.error('[Chat] pinMessage error:', error);
    res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Không thể ghim tin nhắn' });
  }
};

/** Bỏ ghim. */
exports.unpinMessage = async (req, res) => {
  try {
    const conversation = await getConversationForUser(req.params.conversationId, req.user);
    if (rejectObserverWrite(conversation, req, res)) return;
    if (conversation.status === 'locked') {
      return res.status(423).json({ success: false, message: 'Nhóm chat chỉ cho xem lại lịch sử' });
    }
    conversation.pinnedMessage = null;
    conversation.markModified('pinnedMessage');
    await conversation.save();

    invalidateConversationParticipantsListCaches(conversation).catch(() => {});

    await emitToConversation(conversation, 'chat:conversation:pinned', {
      conversationId: String(conversation._id),
      pinnedMessage: null,
      by: normalizeEmail(req.user.email),
    });

    res.json({
      success: true,
      data: {
        conversation: serializeConversation(conversation, req.user),
        pinnedMessage: null,
      },
    });
  } catch (error) {
    console.error('[Chat] unpinMessage error:', error);
    res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Không thể bỏ ghim' });
  }
};

/** Thu hồi tin: chỉ người gửi, trong RECALL_WINDOW_MS. */
exports.recallMessage = async (req, res) => {
  try {
    const { message, conversation } = await loadMessageWithAccess(req.params.messageId, req.user);
    if (rejectObserverWrite(conversation, req, res)) return;
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

    const unpinBecauseRecall = Boolean(
      conversation.pinnedMessage
      && conversation.pinnedMessage.messageId
      && String(conversation.pinnedMessage.messageId) === String(message._id),
    );

    let needConvSave = false;
    if (
      conversation.lastMessage
      && conversation.lastMessage.messageId
      && String(conversation.lastMessage.messageId) === String(message._id)
    ) {
      conversation.lastMessage.content = '';
      conversation.markModified('lastMessage');
      needConvSave = true;
    }
    if (unpinBecauseRecall) {
      conversation.pinnedMessage = null;
      conversation.markModified('pinnedMessage');
      needConvSave = true;
    }
    if (needConvSave) {
      await conversation.save();
    }

    invalidateConversationParticipantsListCaches(conversation).catch(() => {});

    await emitToConversation(conversation, 'chat:message:recalled', {
      conversationId: String(conversation._id),
      messageId: String(message._id),
      recalledAt: message.recalledAt.toISOString(),
      recalledBy: String(req.user._id),
    });

    if (unpinBecauseRecall) {
      await emitToConversation(conversation, 'chat:conversation:pinned', {
        conversationId: String(conversation._id),
        pinnedMessage: null,
        by: normalizeEmail(req.user.email),
      });
    }

    fireChatToFrappe('message_recalled', {
      conversationId: String(conversation._id),
      conversationType: conversation.type,
      messageId: String(message._id),
      senderEmail: req.user.email,
      senderName: userDisplayName(req.user),
      senderRole: userRole(req.user),
      recipientEmails: chatRecipientEmails(conversation, req.user.email),
      messagePreview: '',
      hasAttachment: false,
      timestamp: new Date().toISOString(),
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
exports.isConversationParticipant = isConversationParticipant;
exports.buildParticipantMatchOr = buildParticipantMatchOr;
exports.isBodUser = isBodUser;
exports.isActiveParticipant = isActiveParticipant;
// Dùng bởi services/chatMembershipSync.js (flow sync/revoke membership theo roster).
exports.collectScopeTeachers = collectScopeTeachers;
exports.buildConversationPayload = buildConversationPayload;
exports.upsertMergedConversationFromPayload = upsertMergedConversationFromPayload;
exports.invalidateConversationParticipantsListCaches = invalidateConversationParticipantsListCaches;
exports.participantIdentityKey = participantIdentityKey;
exports.teacherSnapshotKey = teacherSnapshotKey;
exports.guardianSnapshotKey = guardianSnapshotKey;
exports.parentPortalEmailFromGuardianId = parentPortalEmailFromGuardianId;
exports.portalGuardianIdFromEmail = portalGuardianIdFromEmail;
