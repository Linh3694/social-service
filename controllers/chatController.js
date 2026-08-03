const mongoose = require('mongoose');
const ChatConversation = require('../models/ChatConversation');
const ChatMessage = require('../models/ChatMessage');
const User = require('../models/User');
const frappeService = require('../services/frappeService');
const cdn = require('../services/cdn');
const { describeError } = require('../utils/errorLog');
const {
  getChatBroadcastRooms,
  ioEmitToEachRoom,
  participantRooms,
} = require('../utils/chatBroadcastRooms');
const {
  cacheGetJSON,
  cacheSetJSON,
  cacheDel,
  cacheDelByPattern,
  TTL_CHAT_LIST_SEC,
  TTL_MSG_COUNT_SEC,
} = require('../utils/cache');
const { normalizeUploadFilename } = require('../utils/uploadFilename');
const { truncatePreview } = require('../utils/textPreview');

const USER_SELECT = 'fullname fullName email avatarUrl user_image sis_photo guardian_image guardian_id roles role';

/**
 * Trần độ dài đoạn xem trước gửi kèm sự kiện notify (body push dựng từ đây).
 * Cắt theo ranh giới từ + "…" để thông báo không đứt giữa chữ (xem utils/textPreview).
 */
const NOTIFY_PREVIEW_MAX = 100;

/**
 * Chuẩn hoá tin trả API/socket: không populate User — client dùng senderSnapshot (+ _id sender).
 * `viewer` = null nghĩa là payload BROADCAST (một payload cho mọi người xem) ⇒ poll bị lược
 * `myVote` và chỉ kèm `voters` khi bình chọn không ẩn danh. Xem pollPayloadForViewer.
 */
function messagePayloadForApi(doc, viewer) {
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
  if (m.poll) m.poll = pollPayloadForViewer(m.poll, viewer);
  else delete m.poll;
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
  // Nhận diện PHHS CHỈ qua danh tính parent portal (guardian_id, hoặc email
  // `{guardian_id}@parent.wellspring.edu.vn`) — KHÔNG suy diễn từ tên role.
  // Hàng chục GV của trường đồng thời là PHHS, nhưng luôn ở HAI account riêng biệt: ERP tạo
  // account PH bằng email tổng hợp (erp/api/parent_portal/otp_auth.py) và gán role
  // 'Parent'/'Guardian' cho account đó. Nếu suy diễn theo tên role, một GV lỡ mang role
  // Guardian sẽ bị hạ thành PH: mất quyền nhắn ở nhóm mình dạy (writeMode 'teachers_only')
  // và bị xếp sai participants. `Parent Portal User` thì an toàn — role này chỉ do
  // frappeService.authenticateParentGuardian tự sinh, không bao giờ có trên account GV.
  if (roles.includes('Parent Portal User')) return 'guardian';
  if (effectiveGuardianId(user)) return 'guardian';
  return 'teacher';
}

/**
 * Quan sát viên chat: đọc mọi hội thoại theo ROLE, không bao giờ nằm trong participants,
 * không được ghi (send/markRead/reaction/pin...).
 *
 * Ngoài BOD (Ban giám hiệu/HĐQT) còn có Sales Care — bộ phận chăm sóc PH cần theo dõi
 * trao đổi GV↔PH, quyền y hệt BOD (chỉ-xem, silent observer, có audit log).
 */
const CHAT_OBSERVER_ROLES = [
  'SIS BOD',
  'Mobile BOD',
  'SIS Sales Care',
  'SIS Sales Care Admin',
];

function isBodUser(user) {
  const roles = user?.roles || [];
  return CHAT_OBSERVER_ROLES.some((role) => roles.includes(role));
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

/** Đuôi email tài khoản PHHS đăng nhập parent portal. */
const PARENT_PORTAL_EMAIL_SUFFIX = '@parent.wellspring.edu.vn';

function parentPortalEmailFromGuardianId(guardianId) {
  const normalized = normalizeId(guardianId).toLowerCase();
  return normalized ? `${normalized}${PARENT_PORTAL_EMAIL_SUFFIX}` : '';
}

function portalGuardianIdFromEmail(email) {
  const normalized = normalizeEmail(email);
  return normalized.endsWith(PARENT_PORTAL_EMAIL_SUFFIX)
    ? normalized.slice(0, -PARENT_PORTAL_EMAIL_SUFFIX.length)
    : '';
}

/**
 * guardian_id dùng được của user: ưu tiên field trong Mongo, thiếu thì suy ra từ email portal
 * (cùng một value space — ERP tạo email PH là `{guardian_id}@parent.wellspring.edu.vn`).
 * Cần fallback vì doc Mongo của PH do luồng sync user ghi thường KHÔNG mang guardian_id.
 */
function effectiveGuardianId(user) {
  return normalizeId(user?.guardian_id).toLowerCase() || portalGuardianIdFromEmail(user?.email);
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
  const userGuardianId = effectiveGuardianId(user);
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

/** SĐT thành viên từ scope Frappe (guardian.phone_number / teacher.phone_number). */
function guardianPhoneFromScope(guardian) {
  return String(guardian?.phone_number || guardian?.phoneNumber || '').trim();
}

/**
 * Email LIÊN LẠC của PH từ scope Frappe — `contact_email` (bảng con `CRM Guardian Email`).
 * KHÔNG fallback sang `guardian.email`: field đó là email định danh, PH tạo từ CRM Lead
 * không khai email sẽ mang địa chỉ sinh tự động (`no-id-crm-lead-…@parent.wellspring.edu.vn`).
 */
function guardianContactEmailFromScope(guardian) {
  return normalizeEmail(guardian?.contact_email || guardian?.contactEmail || '');
}

/**
 * Liên kết HS↔PH từ scope Frappe: quan hệ + cờ PH chính gắn theo TỪNG học sinh.
 * `onlyStudentId` (chat 1-1 theo HS) ⇒ chỉ giữ liên kết của HS đó.
 */
function studentLinksFromScopeGuardian(guardian, onlyStudentId) {
  const students = guardian?.students || [];
  const out = [];
  const seen = new Set();
  for (const st of students) {
    const sid = String(getStudentId(st) || '').trim();
    if (onlyStudentId && String(onlyStudentId) !== sid) continue;
    const key = sid || String(getStudentName(st) || '').trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      studentId: sid,
      studentName: String(getStudentName(st) || '').trim(),
      relationship: String(st?.relationship_type || st?.relationship || '').trim(),
      keyPerson: Boolean(st?.key_person),
    });
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

/** Vai trò chủ nhiệm hợp lệ từ scope Frappe (`homeroom_role`); giá trị lạ ⇒ rỗng. */
function normalizeHomeroomRole(value) {
  const raw = String(value || '').trim();
  return raw === 'homeroom' || raw === 'vice_homeroom' ? raw : '';
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
    // Frappe trả `homeroom_role`; nhánh fallback frappeService dựng sẵn `homeroomRole`.
    homeroomRole: normalizeHomeroomRole(t.homeroom_role || t.homeroomRole),
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
      phoneNumber: guardianPhoneFromScope(teacher),
      homeroomRole: norm.homeroomRole,
      subjects: compactSubjectSnapshots(norm.subjects || teacher.subjects),
    };
  });

  const guardianSnapshots = guardians.map((guardian) => ({
    email: normalizeEmail(guardian.email || guardian.portalEmail),
    contactEmail: guardianContactEmailFromScope(guardian),
    name: guardian.guardian_name || guardian.name || guardian.email || guardian.portalEmail,
    guardianId: guardian.guardian_id || guardian.name,
    studentIds: (guardian.students || []).map((student) => getStudentId(student)).filter(Boolean),
    studentNames: studentNamesFromScopeGuardian(guardian),
    studentLinks: studentLinksFromScopeGuardian(guardian),
    phoneNumber: guardianPhoneFromScope(guardian),
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
      phoneNumber: guardianPhoneFromScope(teacher),
      homeroomRole: norm.homeroomRole,
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
      contactEmail: guardianContactEmailFromScope(guardian),
      name: guardian.guardian_name || guardian.name || guardian.email || guardian.portalEmail,
      guardianId: guardian.guardian_id || guardian.name,
      studentIds: studentIdsResolved,
      studentNames: studentNamesResolved,
      studentLinks: studentLinksFromScopeGuardian(guardian, targetStudentId),
      phoneNumber: guardianPhoneFromScope(guardian),
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
  // Nhóm lớp: GVBM KHÔNG auto-join — chỉ force-add caller khi là GVCN/phó GVCN của lớp
  // (GVBM chỉ vào nhóm khi được GVCN/phó add thủ công qua API members).
  const callerTid = resolveCallerTeacherIdFromScope(requestUser, scope);
  const callerEmailNorm = normalizeEmail(requestUser?.email);
  const callerIsHomeroom = (scope.teachers || []).some((t) => (
    (callerTid && normalizeId(t.teacherId || t.name) === callerTid)
    || (callerEmailNorm && normalizeEmail(t.email) === callerEmailNorm)
  ));
  const currentTeacherParticipant = callerIsHomeroom
    ? buildCurrentTeacherParticipant(requestUser)
    : null;
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
    // Roster đầy đủ (chỉ get_class_chat_scope_for_sync set `scopeComplete`) ⇒ merge được
    // phép xoá field hiển thị. Không persist — không nằm trong $set của upsert.
    authoritative: scope.scopeComplete === true,
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
 * Union 2 array theo key. Entry trùng key được merge bằng `mergeFn(oldEntry, newEntry, opts)` —
 * mặc định: incoming ghi đè field truthy, fallback giữ field cũ; KHÔNG xoá entry cũ.
 * `opts` chuyển thẳng xuống mergeFn (dùng cho cờ `authoritative`).
 */
function unionByKey(existing, incoming, getKey, mergeFn, opts) {
  const map = new Map();
  for (const item of existing || []) {
    const key = getKey(item);
    if (key) map.set(key, item);
  }
  for (const item of incoming || []) {
    const key = getKey(item);
    if (!key) continue;
    const prev = map.get(key);
    map.set(key, prev ? mergeFn(prev, item, opts) : item);
  }
  return Array.from(map.values());
}

/** Merge field-by-field cho participant (giữ user._id cũ nếu incoming thiếu). */
function mergeParticipantFields(oldP, newP, opts) {
  const authoritative = opts?.authoritative === true;
  // Read-path (không scopeComplete) KHÔNG được gỡ soft-remove do sync/cron — tránh undo
  // revoke khi PH mở lại danh sách chat sau khi bị tắt cờ "Xem thông tin".
  const wasRevokedBySync = Boolean(oldP?.removedAt) && oldP?.removedReason === 'roster_sync';
  const shouldReactivate = authoritative || !wasRevokedBySync;
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
    removedAt: shouldReactivate ? null : oldP.removedAt,
    removedReason: shouldReactivate ? undefined : oldP.removedReason,
  };
}

/**
 * Merge field-by-field cho snapshot teacher/guardian.
 *
 * `opts.authoritative` = payload dựng từ scope ĐẦY ĐỦ (`scopeComplete`, chỉ có ở
 * `get_class_chat_scope_for_sync`). Khi đó các field CHỈ-HIỂN-THỊ được phép ghi đè bằng
 * chuỗi rỗng — nếu không, xoá SĐT/email/ảnh PH bên Frappe sẽ không bao giờ xoá được trong
 * chat vì `newS.X || oldS.X` luôn rơi về giá trị cũ.
 *
 * Scope KHÔNG authoritative (read-path, fallback Resource-API) giữ nguyên hành vi `||`:
 * fallback đó dựng snapshot nghèo hơn hẳn (không có contactEmail, teacher không có
 * phoneNumber — xem frappeService.js:675-680), cho nó xoá là mất dữ liệu thật.
 *
 * Field ĐỊNH DANH (`email`, `guardianId`, `teacherId`, `name`) luôn giữ `||` kể cả khi
 * authoritative — mất là hỏng matching participant.
 */
function mergeSnapshotFields(oldS, newS, opts) {
  const authoritative = opts?.authoritative === true;
  /** Field hiển thị: authoritative ⇒ lấy giá trị mới kể cả rỗng; ngược lại fallback bản cũ. */
  const displayField = (nextValue, prevValue) => (
    authoritative ? String(nextValue || '').trim() : String(nextValue || prevValue || '').trim()
  );
  const mergedSubjects = (() => {
    const next = compactSubjectSnapshots(newS?.subjects);
    if (next.length) return next;
    return compactSubjectSnapshots(oldS?.subjects);
  })();
  return {
    ...oldS,
    ...newS,
    email: normalizeEmail(newS.email) || normalizeEmail(oldS.email),
    contactEmail: normalizeEmail(displayField(newS.contactEmail, oldS.contactEmail)),
    name: newS.name || oldS.name,
    teacherId: newS.teacherId || oldS.teacherId,
    guardianId: newS.guardianId || oldS.guardianId,
    // Vai trò CN/phó giữ `||` kể cả khi authoritative — KHÔNG dùng displayField. Scope
    // read-path/fallback không luôn trả field này, để nó ghi rỗng thì Phó GVCN tụt lại
    // thành "GVCN" đúng như bug ban đầu. GV rời hẳn vai trò thì sync soft-remove cả
    // participant nên không sợ giữ giá trị cũ.
    homeroomRole: normalizeHomeroomRole(newS.homeroomRole) || normalizeHomeroomRole(oldS.homeroomRole),
    avatarUrl: displayField(newS.avatarUrl, oldS.avatarUrl),
    studentIds: Array.from(new Set([
      ...((oldS.studentIds || []).map(String)),
      ...((newS.studentIds || []).map(String)),
    ])).filter(Boolean),
    studentNames: Array.from(new Set([
      ...((oldS.studentNames || []).map(String)),
      ...((newS.studentNames || []).map(String)),
    ])).map((s) => String(s).trim()).filter(Boolean),
    phoneNumber: displayField(newS.phoneNumber, oldS.phoneNumber),
    // Liên kết HS↔PH thay thế nguyên khối theo scope mới (quan hệ/PH chính có thể đổi);
    // scope không trả gì thì giữ bản cũ.
    studentLinks: (newS.studentLinks || []).length ? newS.studentLinks : (oldS.studentLinks || []),
    subjects: mergedSubjects,
    removedAt: (() => {
      const wasRevokedBySync = Boolean(oldS?.removedAt) && oldS?.removedReason === 'roster_sync';
      const shouldReactivate = authoritative || !wasRevokedBySync;
      return shouldReactivate ? null : oldS.removedAt;
    })(),
    removedReason: (() => {
      const wasRevokedBySync = Boolean(oldS?.removedAt) && oldS?.removedReason === 'roster_sync';
      const shouldReactivate = authoritative || !wasRevokedBySync;
      return shouldReactivate ? undefined : oldS.removedReason;
    })(),
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

  const snapshotMergeOpts = { authoritative: payload.authoritative === true };
  const mergedParticipants = unionByKey(
    existing?.participants,
    payload.participants,
    participantIdentityKey,
    mergeParticipantFields,
    snapshotMergeOpts,
  );
  const mergedTeachers = unionByKey(
    existing?.teachers,
    payload.teachers,
    teacherSnapshotKey,
    mergeSnapshotFields,
    snapshotMergeOpts,
  );
  const mergedGuardians = unionByKey(
    existing?.guardians,
    payload.guardians,
    guardianSnapshotKey,
    mergeSnapshotFields,
    snapshotMergeOpts,
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

    // KHÔNG inject PH hiện tại khi scope (access_only) thiếu họ: đó là trường hợp bị thu hồi
    // cờ "Xem thông tin", không phải lỗi scope. Inject ở đây từng undo revoke của sync/cron.
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
  const userGuardianId = effectiveGuardianId(user);
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

const TEACHERS_ONLY_MESSAGE = 'Nhóm đang khóa — chỉ giáo viên được nhắn';
const CONVERSATION_WRITE_MODES = new Set(['all', 'teachers_only']);

/**
 * Năm học nhỏ nhất còn hiện trong danh sách chat, tính theo NĂM BẮT ĐẦU
 * (2026 = năm học "2026-2027"). Hội thoại năm cũ hơn bị ẩn khỏi list —
 * dữ liệu vẫn nguyên trong Mongo, chỉ không liệt kê nữa.
 * Đổi mốc không cần sửa code: đặt env `CHAT_MIN_SCHOOL_YEAR`.
 */
const CHAT_MIN_SCHOOL_YEAR = Number(process.env.CHAT_MIN_SCHOOL_YEAR || 2026);

/** Năm bắt đầu từ tên năm học ("2026-2027", "Năm học 2026-2027") — null nếu không đọc được. */
function schoolYearStartFromName(name) {
  const m = String(name || '').match(/(20\d{2})/);
  return m ? Number(m[1]) : null;
}

/**
 * Hội thoại có thuộc năm học còn hiển thị không.
 * Không đọc được tên năm ⇒ GIỮ LẠI (thà hiện thừa còn hơn giấu nhầm chat đang dùng).
 */
function isVisibleSchoolYear(conversation) {
  const start = schoolYearStartFromName(conversation?.schoolYearName);
  if (start === null) return true;
  return start >= CHAT_MIN_SCHOOL_YEAR;
}

/** Năm học còn hiển thị đổi cỡ một lần mỗi năm ⇒ cache dài hơn TTL danh sách chat. */
const VISIBLE_SCHOOL_YEARS_CACHE_KEY = 'chat:visible-school-years';
const TTL_VISIBLE_SCHOOL_YEARS_SEC = 300;

/**
 * Tên năm học còn hiển thị, để lọc NGAY TRONG QUERY thay vì lọc sau khi đã limit.
 *
 * Không dựng regex năm học trong Mongo vì `CHAT_MIN_SCHOOL_YEAR` cấu hình được bằng env và
 * luật "lấy số 20xx ĐẦU TIÊN" rất dễ viết sai ("2025-2026" phải bị ẩn dù có chứa 2026).
 * Số năm học phân biệt chỉ vài giá trị nên `distinct` rẻ, và lọc lại bằng chính
 * `isVisibleSchoolYear` giữ được MỘT nguồn sự thật cho luật hiển thị.
 *
 * `null` luôn có trong danh sách để khớp doc thiếu `schoolYearName` (Mongo `$in: [null]` khớp
 * cả null lẫn field vắng mặt) — đúng ngữ nghĩa "không đọc được tên năm ⇒ GIỮ LẠI".
 */
async function visibleSchoolYearNames() {
  const cached = await cacheGetJSON(VISIBLE_SCHOOL_YEARS_CACHE_KEY);
  if (Array.isArray(cached?.names)) return cached.names;

  const all = await ChatConversation.distinct('schoolYearName');
  const names = all.filter((name) => isVisibleSchoolYear({ schoolYearName: name }));
  if (!names.includes(null)) names.push(null);
  cacheSetJSON(
    VISIBLE_SCHOOL_YEARS_CACHE_KEY,
    { names },
    TTL_VISIBLE_SCHOOL_YEARS_SEC,
  ).catch(() => {});
  return names;
}

/**
 * Nhóm ký tự tiếng Việt cùng gốc — dựng regex tìm kiếm BỎ DẤU ngay trên Mongo.
 * Mongo không áp collation cho `$regex` và collection chưa có field chuẩn hoá sẵn, nên cách rẻ
 * nhất là nở từng chữ cái của từ khoá thành lớp ký tự có dấu tương ứng. Từ khoá được bỏ dấu
 * trước khi nở nên khớp hai chiều: gõ "lop 5a6" ra "Lớp 5A6", gõ "Lớp 5A6" cũng ra "Lop 5A6".
 */
const ACCENT_CHAR_CLASSES = {
  a: 'aàáảãạăằắẳẵặâầấẩẫậ',
  d: 'dđ',
  e: 'eèéẻẽẹêềếểễệ',
  i: 'iìíỉĩị',
  o: 'oòóỏõọôồốổỗộơờớởỡợ',
  u: 'uùúủũụưừứửữự',
  y: 'yỳýỷỹỵ',
};

/** Bỏ dấu + hạ chữ thường (khớp `normalizeForSearch` phía client). */
function stripAccents(value) {
  return String(value || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** RegExp bỏ dấu cho từ khoá tự do; `null` nếu từ khoá rỗng. Dùng chung cho cả Mongo lẫn in-memory. */
function buildAccentInsensitiveRegex(raw) {
  const needle = stripAccents(raw).trim();
  if (!needle) return null;
  const pattern = [...needle]
    .map((ch) => {
      const cls = ACCENT_CHAR_CLASSES[ch];
      if (cls) return `[${cls}${cls.toUpperCase()}]`;
      return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  return new RegExp(pattern, 'i');
}

/**
 * Giá trị chuẩn của pill lọc danh sách.
 * `parent` (SIS web / workspace-mobile) và `teacher` (parent-portal) cùng trỏ chat 1-1 — chỉ khác
 * góc nhìn của người dùng — nên nhận cả hai làm alias để client khỏi phải đổi nhãn nội bộ.
 */
const CONVERSATION_FILTERS = new Set(['all', 'group', 'direct', 'unread']);

function normalizeConversationFilter(value) {
  const raw = String(value || 'all').trim().toLowerCase();
  if (raw === 'parent' || raw === 'teacher') return 'direct';
  return CONVERSATION_FILTERS.has(raw) ? raw : 'all';
}

const CONVERSATION_PAGE_SIZE_DEFAULT = 50;
const CONVERSATION_PAGE_SIZE_MAX = 200;

/**
 * Đọc tham số phân trang/tìm kiếm của `listConversations`.
 * `paginated = false` (client không gửi `page` lẫn `limit`) ⇒ GIỮ hành vi cũ: trả full list.
 * Bốn client đang chạy đều gọi kiểu này nên không cái nào vỡ khi service lên bản mới.
 */
function parseConversationListQuery(query) {
  const rawPage = query?.page;
  const rawLimit = query?.limit;
  return {
    paginated: rawPage !== undefined || rawLimit !== undefined,
    page: Math.max(1, parseInt(rawPage, 10) || 1),
    limit: Math.min(
      CONVERSATION_PAGE_SIZE_MAX,
      Math.max(1, parseInt(rawLimit, 10) || CONVERSATION_PAGE_SIZE_DEFAULT),
    ),
    countOnly: ['1', 'true', 'yes'].includes(String(query?.countOnly || '').toLowerCase()),
    q: String(query?.q || '').trim(),
    filter: normalizeConversationFilter(query?.filter),
    /** `?fields=list` ⇒ payload rút gọn (xem `serializeConversationForList`). */
    slim: String(query?.fields || '').trim().toLowerCase() === 'list',
    /**
     * `?scope=member` ⇒ CHỈ hội thoại người gọi là thành viên, kể cả khi họ là BOD.
     * Dùng cho màn "chat riêng với PH": danh sách ứng viên dựng từ nhóm lớp mà chính GV tham gia,
     * nên quyền xem-toàn-trường của BOD chỉ tổ tải về hàng nghìn nhóm rồi loại sạch ở client.
     */
    memberScope: String(query?.scope || '').trim().toLowerCase() === 'member',
  };
}

/** Điều kiện Mongo cho từ khoá: tên nhóm/lớp + tên PH/GV (đúng như placeholder "Tìm đoạn chat, tên PH…"). */
function conversationSearchCondition(regex) {
  if (!regex) return null;
  return {
    $or: [
      { title: regex },
      { className: regex },
      { 'guardians.name': regex },
      { 'teachers.name': regex },
    ],
  };
}

/** Bản in-memory của `conversationSearchCondition` — dùng chung RegExp nên hai nhánh cùng ngữ nghĩa. */
function conversationMatchesSearch(payload, regex) {
  if (!regex) return true;
  if (regex.test(payload?.title || '') || regex.test(payload?.className || '')) return true;
  return [...(payload?.guardians || []), ...(payload?.teachers || [])]
    .some((member) => regex.test(member?.name || ''));
}

/** Bản in-memory của map pill lọc → `type` / unread. */
function conversationMatchesFilter(payload, filter) {
  const type = String(payload?.type || '');
  if (filter === 'group') return type === 'class_general';
  if (filter === 'direct') return type.startsWith('teacher_guardian:');
  if (filter === 'unread') return Number(payload?.unreadCount || 0) > 0;
  return true;
}

/** Điều kiện unread theo user (Map `unreadCounts` khoá bằng Mongo `_id`); null nếu không xác định được user. */
function conversationUnreadCondition(user) {
  const key = participantKey(user);
  if (!key) return null;
  return { [`unreadCounts.${key}`]: { $gt: 0 } };
}

/**
 * So sánh giống hệt sort Mongo `{lastMessage.createdAt: -1, updatedAt: -1, _id: -1}`.
 * Thiếu `lastMessage.createdAt` (nhóm chưa có tin) ⇒ xuống cuối, khớp thứ tự BSON của Mongo.
 */
function compareConversationRecency(a, b) {
  const at = a?.lastMessage?.createdAt ? new Date(a.lastMessage.createdAt).getTime() : -Infinity;
  const bt = b?.lastMessage?.createdAt ? new Date(b.lastMessage.createdAt).getTime() : -Infinity;
  if (at !== bt) return bt - at;
  const au = a?.updatedAt ? new Date(a.updatedAt).getTime() : -Infinity;
  const bu = b?.updatedAt ? new Date(b.updatedAt).getTime() : -Infinity;
  if (au !== bu) return bu - au;
  return String(b?._id || '').localeCompare(String(a?._id || ''));
}

/**
 * Trả danh sách hội thoại ĐÃ serialize theo hợp đồng phân trang, áp `q`/`filter` trong bộ nhớ.
 * Dùng cho nhánh non-BOD (danh sách của GV/PH nhỏ, lại còn đi qua cache Redis nên lọc tại chỗ là rẻ nhất).
 *
 * `data` LUÔN là mảng phẳng, thông tin trang nằm ở `meta` bên cạnh — nhờ vậy 4 client cũ
 * (không gửi `page`) đọc `body.data` như trước mà không phải sửa gì.
 */
function respondWithConversationPage(res, payloads, opts) {
  const regex = buildAccentInsensitiveRegex(opts.q);
  const matched = payloads.filter(
    (p) => conversationMatchesFilter(p, opts.filter) && conversationMatchesSearch(p, regex),
  );
  const total = matched.length;
  // Rút gọn ở BƯỚC CUỐI: cache Redis giữ payload đầy đủ nên `?fields=list` của client này
  // không làm hỏng dữ liệu client khác đọc từ cùng khoá cache.
  const shrink = (rows) => (opts.slim ? rows.map(toListPayload) : rows);

  if (opts.countOnly) {
    return res.json({ success: true, data: [], meta: { page: 1, limit: 0, hasMore: false, total } });
  }
  if (!opts.paginated) {
    return res.json({
      success: true,
      data: shrink(matched),
      meta: { page: 1, limit: total, hasMore: false, total },
    });
  }

  const start = (opts.page - 1) * opts.limit;
  const items = matched.slice(start, start + opts.limit);
  return res.json({
    success: true,
    data: shrink(items),
    meta: { page: opts.page, limit: opts.limit, hasMore: start + items.length < total, total },
  });
}

/**
 * Nhóm đang ở chế độ "chỉ GV được nhắn" VÀ người dùng là PH ⇒ chặn mọi thao tác GHI.
 * Khác `status === 'locked'` (khóa cứng cả GV cho lớp/năm học cũ): GV vẫn ghi bình thường.
 */
function isTeachersOnlyBlocked(conversation, user) {
  return conversation.writeMode === 'teachers_only' && userRole(user) === 'guardian';
}

/** Bản trả-response của `isTeachersOnlyBlocked` (khuôn `rejectObserverWrite`). Trả true nếu đã chặn. */
function rejectGuardianWriteWhenTeachersOnly(conversation, req, res) {
  if (!isTeachersOnlyBlocked(conversation, req.user)) return false;
  res.status(423).json({ success: false, code: 'TEACHERS_ONLY', message: TEACHERS_ONLY_MESSAGE });
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
  // `unreadCounts` là map một khoá cho MỖI thành viên (nhóm lớp ~65 khoá) và chỉ tồn tại để tính
  // ra đúng số `unreadCount` ngay trên — không client nào đọc map thô.
  // `participants` thì GIỮ: web GV còn dùng để biết viewer là thành viên hay chỉ-xem (BOD).
  delete base.unreadCounts;
  return base;
}

/**
 * Field của member snapshot mà DANH SÁCH hội thoại thực sự đọc: cụm avatar (`name`/`avatarUrl`),
 * tiêu đề chat 1-1 (`name`/`email`), lối tắt "chat riêng với PH" (`guardianId`/`teacherId`/
 * `studentNames`) và pane phụ huynh (`studentIds`). Phần còn lại — `studentLinks`, `phoneNumber`,
 * `contactEmail`, `subjects` — chỉ dùng ở panel thành viên trong thread, nạp sau bằng
 * `GET /conversations/:id` nên không cần nhân với 50 dòng danh sách.
 */
const LIST_MEMBER_FIELDS = [
  'email', 'name', 'guardianId', 'teacherId', 'studentIds', 'studentNames',
  'avatarUrl', 'removedAt', 'manualAdd', 'homeroomRole',
];

function pickListMember(member) {
  const out = {};
  for (const field of LIST_MEMBER_FIELDS) {
    if (member?.[field] !== undefined) out[field] = member[field];
  }
  return out;
}

/**
 * Payload RÚT GỌN cho danh sách hội thoại (`?fields=list`) — cắt phần roster chi tiết.
 *
 * Danh sách của BOD gồm toàn nhóm lớp, mỗi nhóm kèm roster ~40–65 người, nên bản đầy đủ
 * khiến một trang 50 dòng nặng vài MB. Client nào cần bản đầy đủ (panel thành viên) thì gọi
 * `GET /conversations/:id` cho ĐÚNG hội thoại đang mở.
 *
 * Nhận payload ĐÃ serialize (không phải Document) để dùng được cho cả nhánh đọc cache Redis.
 * `listPayload: true` để client biết object đang thiếu roster chi tiết mà tự nạp lại.
 */
function toListPayload(payload) {
  const slim = {
    ...payload,
    listPayload: true,
    guardians: (payload.guardians || []).map(pickListMember),
    teachers: (payload.teachers || []).map(pickListMember),
  };
  // `participants` chỉ để xét viewer là thành viên hay chỉ-xem, mà việc đó chỉ hỏi ở hội thoại
  // ĐANG MỞ — không đáng nhân với 50 dòng danh sách. Client suy từ `teachers`/`guardians` trong
  // lúc chờ, rồi nạp bản đầy đủ bằng `GET /conversations/:id`.
  delete slim.participants;
  return slim;
}

/** Serialize một Document theo hợp đồng danh sách, rút gọn khi client hỏi `?fields=list`. */
function serializeConversationForList(conversation, user, opts) {
  const payload = serializeConversation(conversation, user);
  return opts?.slim ? toListPayload(payload) : payload;
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
// 'angry' (phẫn nộ) đã gỡ khỏi bộ reaction chat — không nhận thả mới nữa.
// Reaction cũ đã lưu trong DB vẫn giữ nguyên và client vẫn render được (map hiển thị chưa bỏ mã này).
const CHAT_REACTION_EMOJIS = new Set(['like', 'love', 'haha', 'wow', 'sad']);

function attachmentKindFromMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  return 'file';
}

/**
 * Dựng danh sách đính kèm từ file multer — dùng chung cho cả hai endpoint upload.
 *
 * Bật CDN: đẩy lên MinIO, trả về khoá `cdn://social-chat/…`. Middleware
 * cdnSignResponse sẽ ký khoá này thành URL đầy đủ trước khi tới client.
 * Tắt CDN: giữ nguyên hành vi cũ (đường dẫn /uploads/chat/).
 *
 * Tên file LUÔN phải đi qua normalizeUploadFilename: multer trả `originalname` đã bị
 * decode sai thành latin1 nên tên tiếng Việt vào DB thành ký tự lỗi (SIS-169).
 */
async function buildChatAttachments(files) {
  if (!cdn.config.enabled) {
    return files.map((file) => ({
      kind: attachmentKindFromMime(file.mimetype),
      url: `/uploads/chat/${file.filename}`,
      name: normalizeUploadFilename(file.originalname || file.filename || 'file').slice(0, 220),
      mimeType: file.mimetype || '',
      size: file.size || 0,
    }));
  }

  try {
    // Trần đồng thời (KHÔNG dùng Promise.all): mười file cùng lúc, mỗi file đọc
    // trọn vào RAM rồi chạy sharp/ffmpeg, đủ để PM2 giết tiến trình ở mốc 1GB —
    // xem ghi chú đầy đủ ở `storeUploads`. Thứ tự đầu ra được giữ nguyên nên
    // `files[i].originalname` bên dưới vẫn khớp đúng file.
    const results = await cdn.storeUploads(files, { kind: 'chat' });
    return results.map((r, i) => ({
      kind: r.kind,
      url: r.stored,
      name: normalizeUploadFilename(files[i].originalname || 'file').slice(0, 220),
      mimeType: r.contentType,
      size: r.size,
      width: r.width,
      height: r.height,
    }));
  } finally {
    await cdn.cleanupTempFiles(files);
  }
}

/**
 * Chuẩn hoá URL đính kèm do client gửi lên về giá trị lưu DB.
 *
 * Client upload xong nhận về URL ĐÃ KÝ (middleware cdnSignResponse ký response
 * của uploadAttachments), rồi echo đúng URL đó khi gửi tin. Vì vậy ở đây phải
 * chấp nhận cả dạng đã ký và quy về `cdn://social-chat/…` — nếu không, mọi tin
 * nhắn có đính kèm sẽ bị loại sạch.
 *
 * Chữ ký trong URL echo về không cần kiểm: nó chỉ là thứ ta vừa tự phát ra.
 * Điều thực sự chặn URL tuỳ ý là ràng buộc tiền tố dưới đây.
 *
 * @returns {string|null} giá trị lưu DB, hoặc null nếu không hợp lệ
 */
function normalizeAttachmentUrl(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!url) return null;

  // Dữ liệu cũ / khi CDN tắt — giữ nguyên
  if (url.startsWith('/uploads/chat/')) return url;

  // Khoá CDN thô
  if (url.startsWith(`${cdn.CDN_SCHEME}social-chat/`)) return url.split('?')[0];

  // URL đã ký mà chính ta phát ra
  const base = cdn.config.publicUrl;
  if (base && url.startsWith(`${base}/social-chat/`)) {
    const objectPath = url.slice(base.length).split('?')[0];
    // Chặn path traversal trước khi đưa vào khoá lưu DB
    if (objectPath.includes('..')) return null;
    return `${cdn.CDN_SCHEME}${objectPath.replace(/^\/+/, '')}`;
  }

  return null;
}

/** Chỉ chấp nhận đính kèm do chính service này phát ra (chống URL tùy ý). */
/**
 * Trần số đính kèm mỗi tin nhắn.
 *
 * PHẢI KHỚP ba nơi, thiếu một chỗ là hỏng NGẦM:
 *   • `chatUpload.array('files', N)` — routes/chatRoutes.js
 *   • vòng cắt ngay dưới đây
 *   • trần chọn file ở client
 *
 * Nguy hiểm nhất là chỗ này: nó CẮT IM LẶNG. Client gửi 30 ảnh, upload xong cả
 * 30, nhưng tin nhắn chỉ lưu N cái đầu và KHÔNG có lỗi nào — người dùng tưởng
 * mất ảnh còn log thì sạch trơn.
 */
const CHAT_MAX_ATTACHMENTS = 30;

function sanitizeIncomingAttachments(raw) {
  if (!Array.isArray(raw) || !raw.length) return [];
  const out = [];
  for (const a of raw.slice(0, CHAT_MAX_ATTACHMENTS)) {
    const url = normalizeAttachmentUrl(a.url);
    if (!url) continue;
    let kind = a.kind;
    if (kind !== 'image' && kind !== 'file' && kind !== 'video') {
      kind = attachmentKindFromMime(a.mimeType);
    }
    out.push({
      kind,
      url,
      name: (normalizeUploadFilename(a.name) || 'file').slice(0, 220),
      mimeType: String(a.mimeType || '').trim().slice(0, 120),
      size: Math.max(0, Math.min(Number(a.size) || 0, 200 * 1024 * 1024)),
      width: Number.isFinite(Number(a.width)) ? Number(a.width) : undefined,
      height: Number.isFinite(Number(a.height)) ? Number(a.height) : undefined,
      // Poster suy từ chính khoá video (SIS-174). Suy ở ĐÂY vì đây là chỗ duy nhất
      // mọi đính kèm chat đi qua — cả đường multipart lẫn đường upload trực tiếp
      // (client echo lại mảng attachments) — nên không phải sửa client nào cả.
      // KHÔNG tin `a.posterUrl` do client gửi: giá trị này phải do server suy ra.
      posterUrl: kind === 'video' ? (cdn.posterKeyFor(url) || '') : '',
      // Bản 480px cho ô thumbnail — pipeline đã sinh sẵn nhưng client chưa từng
      // dùng, nên vẫn đang tải ảnh 2048px vào ô 134px. `thumbKeyFor` trả null khi
      // không chắc biến thể tồn tại (ảnh gốc ≤480px, hoặc ảnh giữ nguyên bản gốc)
      // ⇒ để rỗng và client tự dùng ảnh đầy đủ.
      thumbUrl: kind === 'image'
        ? (cdn.thumbKeyFor(url, Number(a.width)) || '')
        : '',
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

// ===== Bình chọn (poll) =====

const POLL_MIN_OPTIONS = 2;
const POLL_MAX_OPTIONS = 10;
const POLL_MAX_DEADLINE_DAYS = 90;
/** Trần cho "nhắc trước N phút" — 7 ngày, đủ rộng mà không cho đặt vô lý. */
const POLL_MAX_REMIND_MINUTES = 7 * 24 * 60;
/** Tiền tố giữ trong `content` để client cũ / preview / push vẫn đọc được tin bình chọn. */
const POLL_CONTENT_PREFIX = '[Bình chọn]';

/** Thời điểm đóng thực tế: đóng tay, hoặc đã quá hạn (tính lười — không cron). */
function pollEffectiveClosedAt(poll) {
  if (!poll) return null;
  if (poll.closedAt) return new Date(poll.closedAt);
  if (poll.closesAt && Date.now() >= new Date(poll.closesAt).getTime()) return new Date(poll.closesAt);
  return null;
}

/** Ẩn danh chỉ ẩn với PHỤ HUYNH — giáo viên (và BOD, vốn userRole='teacher') luôn thấy danh tính. */
function canSeePollVoters(poll, viewer) {
  if (!poll?.anonymous) return true;
  return userRole(viewer) === 'teacher';
}

function serializePollVoter(v) {
  return {
    userId: v.user ? String(v.user) : '',
    name: v.name || '',
    email: v.email || '',
    avatarUrl: v.avatarUrl || '',
    role: v.role || 'guardian',
    votedAt: (v.votedAt ? new Date(v.votedAt) : new Date()).toISOString(),
  };
}

/** Số NGƯỜI đã bỏ phiếu (không phải số phiếu) — mẫu số cho % khi cho chọn nhiều. */
function pollDistinctVoterCount(poll) {
  return new Set((poll?.votes || []).map((v) => String(v.user))).size;
}

/** Danh sách người bầu theo từng phương án — chỉ dùng cho payload được phép lộ danh tính. */
function pollVotersByOption(poll) {
  return (poll?.options || []).map((o) => ({
    id: o.id,
    voters: (poll.votes || []).filter((v) => v.optionId === o.id).map(serializePollVoter),
  }));
}

/**
 * Serialize poll theo người xem.
 * `viewer = null` ⇒ payload BROADCAST: KHÔNG kèm `myVote` (một payload cho mọi người xem) và
 * chỉ kèm `voters` khi bình chọn không ẩn danh.
 */
function pollPayloadForViewer(poll, viewer) {
  const plain = poll?.toObject ? poll.toObject() : poll;
  if (!plain) return null;
  const votes = plain.votes || [];
  const showVoters = viewer ? canSeePollVoters(plain, viewer) : !plain.anonymous;
  const closedAt = plain.closedAt ? new Date(plain.closedAt) : null;

  const options = (plain.options || []).map((o) => {
    const optionVotes = votes.filter((v) => v.optionId === o.id);
    const row = { id: o.id, text: o.text, voteCount: optionVotes.length };
    if (showVoters) row.voters = optionVotes.map(serializePollVoter);
    return row;
  });

  const payload = {
    question: plain.question,
    options,
    allowMultiple: Boolean(plain.allowMultiple),
    anonymous: Boolean(plain.anonymous),
    closesAt: plain.closesAt ? new Date(plain.closesAt).toISOString() : null,
    closedAt: closedAt ? closedAt.toISOString() : null,
    isClosed: Boolean(pollEffectiveClosedAt(plain)),
    totalVoters: pollDistinctVoterCount(plain),
    canSeeVoters: showVoters,
    /**
     * false = payload BROADCAST, đã lược các trường phụ thuộc người xem (`myVote`, và `voters` +
     * `canSeeVoters` khi poll ẩn danh). Client PHẢI giữ lại các trường đó từ trạng thái cũ thay vì
     * ghi đè — xem applyPollUpdate. Thiếu cờ này thì GV mất nút "Xem người bình chọn" ngay khi có
     * người bỏ phiếu trên poll ẩn danh.
     */
    viewerScoped: Boolean(viewer),
    rev: plain.rev || 0,
  };

  if (viewer) {
    const uid = String(viewer._id);
    payload.myVote = votes.filter((v) => String(v.user) === uid).map((v) => v.optionId);
  }
  return payload;
}

/**
 * Room của GIÁO VIÊN trong hội thoại — dùng cho payload lộ danh tính của poll ẩn danh.
 * TUYỆT ĐỐI không gồm `chat_<id>` (PH và BOD cùng ở room đó) và cố tình KHÔNG dùng
 * participantRooms() vì hàm đó tự thêm room `guardian_*`/email portal.
 */
function pollTeacherOnlyRooms(conversation) {
  const rooms = new Set();
  for (const p of conversation?.participants || []) {
    if (!isActiveParticipant(p)) continue;
    if (p.role !== 'teacher') continue;
    if (p.guardianId) continue;
    const email = normalizeEmail(p.email);
    if (email.endsWith(PARENT_PORTAL_EMAIL_SUFFIX)) continue;
    if (p.user) rooms.add(`user_${String(p.user)}`);
    if (email) rooms.add(`email_${email}`);
  }
  return [...rooms];
}

/** Email thành viên active CHƯA bỏ phiếu — dùng cho nhắc trước hạn. */
function pollPendingVoterEmails(conversation, poll) {
  const voted = new Set((poll?.votes || []).map((v) => String(v.user)));
  const seen = new Set();
  const emails = [];
  for (const p of conversation?.participants || []) {
    if (!isActiveParticipant(p)) continue;
    if (p.user && voted.has(String(p.user))) continue;
    const raw = p.email;
    if (!raw) continue;
    const n = normalizeEmail(raw);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    emails.push(String(raw).trim());
  }
  return emails;
}

/**
 * Gửi notify vòng đời bình chọn (nhắc trước hạn / đã kết thúc) qua đúng đường của new_message
 * ⇒ được cả in-app (ERP Notification + realtime) lẫn push.
 * Không có "người gửi": tiêu đề/nội dung dựng từ câu hỏi ở phía consumer.
 */
function firePollLifecycleNotify(eventType, conversation, message, { recipientEmails }) {
  const emails = (recipientEmails || []).filter(Boolean);
  if (!emails.length) return;
  fireChatToFrappe(eventType, {
    conversationId: String(conversation._id),
    conversationType: conversation.type,
    messageId: String(message._id),
    senderEmail: '',
    senderName: '',
    recipientEmails: emails,
    messagePreview: truncatePreview(message.poll?.question, NOTIFY_PREVIEW_MAX),
    hasAttachment: false,
    messageKind: 'poll',
    timestamp: new Date().toISOString(),
  });
}

/** Phát cập nhật poll: aggregate cho tất cả, danh tính cho riêng GV khi poll ẩn danh. */
async function broadcastPollUpdate(conversation, message) {
  const poll = message.poll;
  if (!poll) return;
  await emitToConversation(conversation, 'chat:message:poll', {
    conversationId: String(conversation._id),
    messageId: String(message._id),
    poll: pollPayloadForViewer(poll, null),
  });
  if (!poll.anonymous || !global.io) return;
  ioEmitToEachRoom(global.io, pollTeacherOnlyRooms(conversation), 'chat:message:poll:voters', {
    conversationId: String(conversation._id),
    messageId: String(message._id),
    rev: poll.rev || 0,
    totalVoters: pollDistinctVoterCount(poll),
    options: pollVotersByOption(poll),
  });
}

/**
 * Gate chung cho mọi thao tác ghi trên poll. Trả { message, conversation } hoặc null (đã trả lỗi).
 *
 * CỐ Ý KHÔNG chặn theo `writeMode === 'teachers_only'`: bỏ phiếu là tương tác của thành viên,
 * không phải gửi tin — khóa nhóm "chỉ GV được nhắn" vẫn cho PH bình chọn (giống toggleReaction).
 * `status === 'locked'` (nhóm năm học cũ) thì vẫn chặn tất cả, kể cả GV.
 */
async function loadPollForWrite(req, res) {
  const { message, conversation } = await loadMessageWithAccess(req.params.messageId, req.user);
  if (rejectObserverWrite(conversation, req, res)) return null;
  if (!message.poll) {
    res.status(400).json({ success: false, message: 'Tin nhắn không phải bình chọn' });
    return null;
  }
  if (message.recalledAt) {
    res.status(400).json({ success: false, message: 'Tin nhắn đã thu hồi' });
    return null;
  }
  if (conversation.status === 'locked') {
    res.status(423).json({ success: false, message: 'Nhóm chat chỉ cho xem lại lịch sử' });
    return null;
  }
  return { message, conversation };
}

/** Chuẩn hoá + kiểm tra body tạo bình chọn. Ném Error kèm statusCode khi sai. */
function buildPollFromRequestBody(body) {
  const question = String(body?.question || '').trim();
  if (!question) {
    const err = new Error('Câu hỏi bình chọn là bắt buộc');
    err.statusCode = 400;
    throw err;
  }
  if (question.length > 500) {
    const err = new Error('Câu hỏi tối đa 500 ký tự');
    err.statusCode = 400;
    throw err;
  }

  const seen = new Set();
  const texts = [];
  for (const raw of Array.isArray(body?.options) ? body.options : []) {
    const text = String(raw || '').trim().slice(0, 200);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    texts.push(text);
  }
  if (texts.length < POLL_MIN_OPTIONS || texts.length > POLL_MAX_OPTIONS) {
    const err = new Error(`Bình chọn cần ${POLL_MIN_OPTIONS}–${POLL_MAX_OPTIONS} phương án khác nhau`);
    err.statusCode = 400;
    throw err;
  }

  const remindRaw = body?.remindBeforeMinutes;
  const remindBeforeMinutes = remindRaw == null || remindRaw === '' ? null : Number(remindRaw);
  if (remindBeforeMinutes != null
    && (!Number.isFinite(remindBeforeMinutes) || remindBeforeMinutes <= 0 || remindBeforeMinutes > POLL_MAX_REMIND_MINUTES)) {
    const err = new Error(`Thời điểm nhắc phải trong khoảng 1–${POLL_MAX_REMIND_MINUTES} phút trước hạn`);
    err.statusCode = 400;
    throw err;
  }
  if (remindBeforeMinutes != null && !body?.closesAt) {
    const err = new Error('Muốn nhắc trước thì phải đặt thời hạn cho bình chọn');
    err.statusCode = 400;
    throw err;
  }

  let closesAt = null;
  if (body?.closesAt) {
    const at = new Date(body.closesAt);
    if (Number.isNaN(at.getTime())) {
      const err = new Error('Thời hạn không hợp lệ');
      err.statusCode = 400;
      throw err;
    }
    const maxAt = Date.now() + POLL_MAX_DEADLINE_DAYS * 24 * 60 * 60 * 1000;
    if (at.getTime() <= Date.now()) {
      const err = new Error('Thời hạn phải ở tương lai');
      err.statusCode = 400;
      throw err;
    }
    if (at.getTime() > maxAt) {
      const err = new Error(`Thời hạn tối đa ${POLL_MAX_DEADLINE_DAYS} ngày`);
      err.statusCode = 400;
      throw err;
    }
    closesAt = at;
  }

  // Mốc nhắc tính sẵn để scheduler quét bằng index. Nếu mốc đã ở quá khứ (hạn quá gần) thì
  // bỏ nhắc luôn thay vì bắn ngay lập tức — bắn cùng lúc tạo poll chỉ gây nhiễu.
  let remindAt = null;
  if (remindBeforeMinutes != null && closesAt) {
    const at = new Date(closesAt.getTime() - remindBeforeMinutes * 60 * 1000);
    if (at.getTime() > Date.now()) remindAt = at;
  }

  return {
    question,
    options: texts.map((text, i) => ({ id: `o${i + 1}`, text })),
    allowMultiple: Boolean(body?.allowMultiple),
    anonymous: Boolean(body?.anonymous),
    closesAt,
    closedAt: null,
    closedBy: null,
    remindBeforeMinutes: remindAt ? remindBeforeMinutes : null,
    remindAt,
    remindedAt: null,
    closeNotifiedAt: null,
    votes: [],
    rev: 0,
  };
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
  poll = null,
}) {
  if (conversation.status === 'locked') {
    const err = new Error('Nhóm chat năm học cũ chỉ cho xem lại lịch sử');
    err.statusCode = 423;
    throw err;
  }
  if (isTeachersOnlyBlocked(conversation, req.user)) {
    const err = new Error(TEACHERS_ONLY_MESSAGE);
    err.statusCode = 423;
    err.code = 'TEACHERS_ONLY';
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
    poll: poll || null,
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

  // Hai payload khác nhau: broadcast KHÔNG được mang gì gắn với người xem (myVote/voters ẩn danh).
  const payloadMsg = messagePayloadForApi(message, req.user);
  await emitToConversation(conversation, 'chat:message', {
    conversation: serializeConversation(conversation, req.user),
    message: messagePayloadForApi(message, null),
  });

  fireChatToFrappe('new_message', {
    conversationId: String(conversation._id),
    conversationType: conversation.type,
    messageId: String(message._id),
    senderEmail: req.user.email,
    senderName: message.senderSnapshot.name,
    senderRole: message.senderSnapshot.role,
    recipientEmails: chatRecipientEmails(conversation, req.user.email),
    messagePreview: truncatePreview(lastPreview || c || '', NOTIFY_PREVIEW_MAX),
    hasAttachment: att.length > 0,
    messageKind: poll ? 'poll' : 'text',
    timestamp: new Date().toISOString(),
  });

  return { message: payloadMsg, conversation: serializeConversation(conversation, req.user) };
}

/** Trần an toàn cho nhánh BOD khi client CHƯA gửi `page` — chỉ để chặn truy vấn hỏng. */
const BOD_FULL_LIST_GROUP_CAP = 2000;
const BOD_FULL_LIST_DIRECT_CAP = 500;

/**
 * Danh sách hội thoại cho BOD — query thẳng Mongo trên TOÀN BỘ collection, không ensure/scope,
 * không match participant, không cache Redis (ít user, query lại có tìm kiếm).
 *
 * Bản cũ `find(...).limit(200)` rồi mới lọc năm học / 1-1 rỗng bằng JS. Hai hệ quả: doc bị loại
 * vẫn ăn slot của 200, và nhóm lớp CHƯA CÓ TIN NHẮN (thiếu `lastMessage.createdAt` ⇒ BSON xếp
 * cuối ở chiều desc) rơi qua mốc là biến mất — client lại lọc tìm kiếm trên mảng đã tải nên
 * không cách nào tìm lại được (SIS-166). Vì vậy MỌI điều kiện lọc phải nằm trong query.
 */
async function listConversationsForBod(req, res, opts) {
  const { classId, schoolYearId } = req.query;

  const groupArm = { type: 'class_general' };
  // 1-1 chưa có tin thì không liệt kê (giống list thường) — điều kiện nằm TRONG query.
  const directArm = {
    type: { $regex: /^teacher_guardian:/ },
    'lastMessage.messageId': { $exists: true, $ne: null },
  };

  const baseConditions = [{ schoolYearName: { $in: await visibleSchoolYearNames() } }];
  if (classId) baseConditions.push({ classId: String(classId).trim() });
  if (schoolYearId) baseConditions.push({ schoolYearId: String(schoolYearId).trim() });

  const search = conversationSearchCondition(buildAccentInsensitiveRegex(opts.q));
  if (search) baseConditions.push(search);

  if (opts.filter === 'unread') {
    // BOD thuần không bao giờ là participant nên không có khoá trong `unreadCounts`; user lai
    // BOD + SIS Teacher thì CÓ ở lớp mình dạy, nên vẫn query bình thường thay vì trả rỗng.
    const unread = conversationUnreadCondition(req.user);
    if (!unread) {
      return res.json({
        success: true,
        data: [],
        meta: { page: opts.page, limit: opts.paginated ? opts.limit : 0, hasMore: false, total: 0 },
      });
    }
    baseConditions.push(unread);
  }

  const typeArm = opts.filter === 'group'
    ? groupArm
    : opts.filter === 'direct'
      ? directArm
      : { $or: [groupArm, directArm] };

  const filter = { $and: [typeArm, ...baseConditions] };

  if (opts.countOnly) {
    const total = await ChatConversation.countDocuments(filter);
    return res.json({ success: true, data: [], meta: { page: 1, limit: 0, hasMore: false, total } });
  }

  // `_id` làm tie-break để hai trang liên tiếp không trả trùng/sót dòng.
  const sort = { 'lastMessage.createdAt': -1, updatedAt: -1, _id: -1 };
  // Nhánh này chỉ đọc rồi trả JSON: `lean()` bỏ bước hydrate Document (đắt với mảng
  // participants/guardians hàng chục phần tử), projection bỏ luôn field sẽ bị cắt ở serializer —
  // `participants` chỉ bỏ khi client hỏi `fields=list`, để hợp đồng cũ không đổi.
  const projection = opts.slim
    ? { participants: 0, hiddenFromListAtByUserId: 0 }
    : { hiddenFromListAtByUserId: 0 };

  if (opts.paginated) {
    const rows = await ChatConversation.find(filter, projection)
      .sort(sort)
      .skip((opts.page - 1) * opts.limit)
      .limit(opts.limit + 1)
      .lean();
    const hasMore = rows.length > opts.limit;
    const pageRows = hasMore ? rows.slice(0, opts.limit) : rows;
    return res.json({
      success: true,
      data: pageRows.map((c) => serializeConversationForList(c, req.user, opts)),
      // `total` chỉ trả khi client hỏi `countOnly`: không màn nào hiển thị tổng số, mà đếm thì
      // phải quét lại đúng tập vừa tìm — với BOD (tìm kiếm regex không index) là một COLLSCAN
      // thừa cho MỖI lần gõ. Phân trang chỉ cần `hasMore`, đã có sẵn từ `limit + 1`.
      meta: { page: opts.page, limit: opts.limit, hasMore, total: null },
    });
  }

  // Client chưa hỗ trợ phân trang: trả full list như hợp đồng cũ. Tách HAI truy vấn để trần của
  // chat 1-1 không bao giờ cắt vào nhóm lớp — đúng thứ đã hỏng ở bản trước.
  const [groups, directs] = await Promise.all([
    opts.filter === 'direct'
      ? []
      : ChatConversation.find({ $and: [groupArm, ...baseConditions] }, projection)
        .sort(sort).limit(BOD_FULL_LIST_GROUP_CAP).lean(),
    opts.filter === 'group'
      ? []
      : ChatConversation.find({ $and: [directArm, ...baseConditions] }, projection)
        .sort(sort).limit(BOD_FULL_LIST_DIRECT_CAP).lean(),
  ]);
  if (groups.length >= BOD_FULL_LIST_GROUP_CAP || directs.length >= BOD_FULL_LIST_DIRECT_CAP) {
    console.warn(
      `[Chat] listConversations BOD chạm trần full-list (groups=${groups.length}, directs=${directs.length})`
      + ' — client cần chuyển sang phân trang (?page=1&limit=50).',
    );
  }
  const rows = [...groups, ...directs].sort(compareConversationRecency);
  return res.json({
    success: true,
    data: rows.map((c) => serializeConversationForList(c, req.user, opts)),
    meta: { page: 1, limit: rows.length, hasMore: false, total: rows.length },
  });
}

/**
 * Một hội thoại theo id — cần từ khi danh sách chuyển sang phân trang: mở link `?c=<id>` trỏ tới
 * hội thoại nằm ngoài trang đầu thì client không còn tự tìm thấy trong mảng đã tải.
 * ACL dùng chung `getConversationForUser` (participant, hoặc BOD xem toàn bộ).
 */
exports.getConversation = async (req, res) => {
  try {
    const { conversationId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(String(conversationId || ''))) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy nhóm chat' });
    }
    const conversation = await getConversationForUser(conversationId, req.user);
    res.json({ success: true, data: serializeConversation(conversation, req.user) });
  } catch (error) {
    console.error('[Chat] getConversation error:', describeError(error));
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Không thể tải nhóm chat',
    });
  }
};

exports.listConversations = async (req, res) => {
  try {
    const token = getBearerToken(req);
    const { classId, schoolYearId } = req.query;
    const opts = parseConversationListQuery(req.query);

    // Quyền NHẮN vẫn xét theo thành viên từng hội thoại (rejectObserverWrite) — user lai
    // GV+BOD nhắn được ở lớp mình, chỉ-xem ở hội thoại khác.
    // `?scope=member` bỏ qua đặc quyền xem-toàn-trường: người gọi chỉ muốn hội thoại của CHÍNH
    // mình (xem `memberScope`), nhánh dưới đã lọc bằng `buildParticipantMatchOr`.
    if (isBodUser(req.user) && !opts.memberScope) {
      return await listConversationsForBod(req, res, opts);
    }

    // Cache giữ FULL list (khoá không kèm q/filter/page) — `q`/`filter`/phân trang áp sau khi đọc
    // cache, nên đổi từ khoá hay lật pill không làm hỏng cache lẫn nhau.
    const listCacheKey = chatConversationListCacheKey(req.user._id, classId, schoolYearId);
    const cachedList = await cacheGetJSON(listCacheKey);
    if (cachedList?.payloads) {
      return respondWithConversationPage(res, cachedList.payloads, opts);
    }

    let conversations = [];

    if (classId) {
      conversations = await ensureClassConversations({ classId, schoolYearId, token, user: req.user });
    } else if (userRole(req.user) === 'guardian') {
      // Chỉ PH mới quét scope qua parent portal. Trước đây nhánh này chạy cho MỌI role: token
      // Bearer của GV bị gửi vào endpoint parent-portal-only qua header X-Parent-Portal-Token,
      // dẫn tới 403 (hoặc trả rỗng) và cả handler 500 khi SIS lỗi. GV không mất gì khi bỏ qua:
      // endpoint đó resolve theo `sub` của token nên account GV luôn không có guardian record,
      // scope trả về rỗng — hội thoại của GV lấy từ buildParticipantMatchOr bên dưới.
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
        // Ẩn hội thoại của năm học cũ (trước CHAT_MIN_SCHOOL_YEAR).
        if (!isVisibleSchoolYear(c)) return false;
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

    respondWithConversationPage(res, payloads, opts);
  } catch (error) {
    console.error('[Chat] listConversations error:', describeError(error));
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
    console.error('[Chat] ensureTeacherGuardianConversation error:', describeError(error));
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
    console.error('[Chat] sendTeacherGuardianMessage error:', describeError(error));
    res.status(error.statusCode || 500).json({
      success: false,
      code: error.code,
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
    const attachments = await buildChatAttachments(files);
    res.json({ success: true, data: { attachments } });
  } catch (error) {
    console.error('[Chat] uploadTeacherGuardianAttachments error:', describeError(error));
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
    let page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '30', 10), 1), 100);

    const baseQuery = { conversation: conversation._id, isDeleted: false };
    const ck = messageCountRedisKey(conversation._id);

    /**
     * `around=<messageId>` — nạp liền một mạch từ tin MỚI NHẤT xuống hết trang chứa tin đó.
     * Dùng khi mở hội thoại từ thông báo: client cần cuộn thẳng tới tin được nhắc tới, kể cả
     * khi tin đã cũ nằm ngoài trang đầu (SIS-180). Không truyền `around` ⇒ hành vi cũ y nguyên.
     *
     * Vì sao trả liền mạch chứ không trả riêng trang chứa tin: danh sách chat phía client là
     * FlatList inverted, chỉ có đường tải THÊM TIN CŨ (`onEndReached`), không có đường tải tin
     * mới hơn. Trả mỗi trang giữa sẽ để lại khoảng trống không bao giờ lấp được.
     *
     * `currentPage` vẫn trả về trang chứa tin đích nên client tải tiếp trang kế là liền mạch.
     * Tin không tồn tại / đã xoá / quá xa (> AROUND_MAX_MESSAGES) ⇒ `aroundResolved: false`
     * và rơi về trang được yêu cầu, KHÔNG lỗi — thông báo cũ vẫn phải mở được hội thoại.
     */
    const AROUND_MAX_MESSAGES = 300;
    const around = String(req.query.around || '').trim();
    let aroundResolved = false;
    let aroundTake = 0;
    if (around) {
      const target = mongoose.Types.ObjectId.isValid(around)
        ? await ChatMessage.findOne({ ...baseQuery, _id: around }).select('createdAt').lean()
        : null;
      if (target) {
        // Vị trí tin trong danh sách sort createdAt DESC = số tin mới hơn nó.
        // Các tin trùng khít createdAt có thể lệch vài bậc, không đủ để văng khỏi trang.
        const newerCount = await ChatMessage.countDocuments({
          ...baseQuery,
          createdAt: { $gt: target.createdAt },
        });
        if (newerCount < AROUND_MAX_MESSAGES) {
          page = Math.floor(newerCount / limit) + 1;
          aroundTake = page * limit;
          aroundResolved = true;
        }
      }
    }

    const skip = aroundResolved ? 0 : (page - 1) * limit;
    const pageSize = aroundResolved ? aroundTake : limit;

    const loadRows = async (take) => ChatMessage.find(baseQuery)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(take)
      .lean();

    let messages;
    let total;
    let hasNext;

    if (skip === 0) {
      const rawRows = await loadRows(pageSize + 1);
      hasNext = rawRows.length > pageSize;
      messages = rawRows.slice(0, pageSize);

      const hit = await cacheGetJSON(ck);
      if (hit && typeof hit.total === 'number') {
        total = hit.total;
      } else {
        total = await ChatMessage.countDocuments(baseQuery);
        cacheSetJSON(ck, { total }, TTL_MSG_COUNT_SEC).catch(() => {});
      }
    } else {
      messages = await loadRows(pageSize + 1);
      hasNext = messages.length > pageSize;
      messages = messages.slice(0, pageSize);

      total = await ChatMessage.countDocuments(baseQuery);
    }

    res.json({
      success: true,
      data: {
        messages: messages.reverse().map((m) => messagePayloadForApi(m, req.user)),
        pagination: {
          currentPage: page,
          totalPages: Math.ceil(total / limit),
          totalMessages: total,
          hasNext,
          ...(around ? { aroundResolved } : {}),
        },
        conversation: serializeConversation(conversation, req.user),
      },
    });
  } catch (error) {
    console.error('[Chat] getMessages error:', describeError(error));
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
    if (rejectGuardianWriteWhenTeachersOnly(conversation, req, res)) return;
    const files = req.files || [];
    if (!files.length) {
      return res.status(400).json({ success: false, message: 'Không có tệp tải lên' });
    }
    const attachments = await buildChatAttachments(files);
    res.json({ success: true, data: { attachments } });
  } catch (error) {
    console.error('[Chat] uploadAttachments error:', describeError(error));
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
    console.error('[Chat] sendMessage error:', describeError(error));
    res.status(error.statusCode || 500).json({
      success: false,
      code: error.code,
      message: error.message || 'Không thể gửi tin nhắn',
    });
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
    console.error('[Chat] markRead error:', describeError(error));
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
    console.error('[Chat] hideConversationFromList error:', describeError(error));
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
    // CỐ Ý không chặn theo `writeMode === 'teachers_only'`: thả cảm xúc là tương tác của thành
    // viên, không phải gửi tin — khóa nhóm "chỉ GV được nhắn" vẫn cho PH react (giống bình chọn).

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
    console.error('[Chat] toggleReaction error:', describeError(error));
    res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Không thể cập nhật reaction' });
  }
};

/**
 * POST /conversations/:conversationId/polls — tạo bình chọn.
 * Chỉ GVCN/Phó GVCN, chỉ nhóm lớp. Đi qua appendMessageToConversation để thừa hưởng
 * unread / lastMessage / cache / socket chat:message / push.
 */
exports.createPoll = async (req, res) => {
  try {
    const conversation = await getConversationForUser(req.params.conversationId, req.user);
    if (rejectObserverWrite(conversation, req, res)) return;
    if (conversation.type !== 'class_general') {
      return res.status(400).json({ success: false, message: 'Chỉ tạo bình chọn trong nhóm lớp' });
    }
    await requireHomeroomCaller(conversation, req);

    const poll = buildPollFromRequestBody(req.body);
    const data = await appendMessageToConversation(conversation, req, {
      // Giữ nguyên tiền tố trong `content`: mọi chỗ preview (lastMessage, reply quote, ghim,
      // body push) và client bản cũ chưa biết `poll` đều dựa vào chuỗi này. Đừng đổi thành ''.
      content: `${POLL_CONTENT_PREFIX} ${poll.question}`,
      attachments: [],
      poll,
    });

    res.status(201).json({ success: true, data });
  } catch (error) {
    console.error('[Chat] createPoll error:', describeError(error));
    res.status(error.statusCode || 500).json({
      success: false,
      code: error.code,
      message: error.message || 'Không thể tạo bình chọn',
    });
  }
};

/**
 * POST /messages/:messageId/poll/vote — bỏ/đổi/rút phiếu. `optionIds: []` = rút phiếu.
 * KHÔNG đụng unreadCounts / lastMessage / notify (tránh spam push mỗi lần bấm).
 */
exports.votePoll = async (req, res) => {
  try {
    const loaded = await loadPollForWrite(req, res);
    if (!loaded) return;
    const { message, conversation } = loaded;

    if (pollEffectiveClosedAt(message.poll)) {
      return res.status(423).json({
        success: false,
        code: 'POLL_CLOSED',
        message: 'Bình chọn đã kết thúc',
        data: { messageId: String(message._id), poll: pollPayloadForViewer(message.poll, req.user) },
      });
    }

    if (!Array.isArray(req.body?.optionIds)) {
      return res.status(400).json({ success: false, message: 'optionIds là bắt buộc' });
    }
    const validIds = new Set((message.poll.options || []).map((o) => o.id));
    const requested = [];
    for (const raw of req.body.optionIds) {
      const id = String(raw || '').trim();
      if (!validIds.has(id) || requested.includes(id)) continue;
      requested.push(id);
    }
    if (requested.length > 1 && !message.poll.allowMultiple) {
      return res.status(400).json({ success: false, message: 'Bình chọn này chỉ được chọn một phương án' });
    }

    const votedAt = new Date();
    const newVotes = requested.map((optionId) => ({
      optionId,
      user: req.user._id,
      email: normalizeEmail(req.user.email),
      name: userDisplayName(req.user),
      role: userRole(req.user),
      avatarUrl: userAvatar(req.user),
      votedAt,
    }));

    // Hai bước vì Mongo cấm $pull và $push xung đột cùng path trong một update.
    // Chỉ $inc một lần ở bước sau ⇒ rev tăng đúng 1 cho mỗi lượt bỏ phiếu.
    await ChatMessage.updateOne(
      { _id: message._id },
      { $pull: { 'poll.votes': { user: req.user._id } } },
    );
    const updated = await ChatMessage.findOneAndUpdate(
      { _id: message._id },
      {
        ...(newVotes.length ? { $push: { 'poll.votes': { $each: newVotes } } } : {}),
        $inc: { 'poll.rev': 1 },
      },
      { new: true },
    );
    if (!updated?.poll) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy bình chọn' });
    }

    await broadcastPollUpdate(conversation, updated);

    res.json({
      success: true,
      data: { messageId: String(updated._id), poll: pollPayloadForViewer(updated.poll, req.user) },
    });
  } catch (error) {
    console.error('[Chat] votePoll error:', describeError(error));
    res.status(error.statusCode || 500).json({
      success: false,
      code: error.code,
      message: error.message || 'Không thể bỏ phiếu',
    });
  }
};

/** POST /messages/:messageId/poll/close — kết thúc sớm; người tạo hoặc GVCN/Phó. */
exports.closePoll = async (req, res) => {
  try {
    const loaded = await loadPollForWrite(req, res);
    if (!loaded) return;
    const { message, conversation } = loaded;

    if (String(message.sender) !== String(req.user._id)) {
      await requireHomeroomCaller(conversation, req);
    }
    if (pollEffectiveClosedAt(message.poll)) {
      return res.status(400).json({ success: false, message: 'Bình chọn đã kết thúc' });
    }

    const now = new Date();
    const updated = await ChatMessage.findOneAndUpdate(
      { _id: message._id },
      {
        // closeNotifiedAt set ngay tại đây để scheduler không bắn thêm lần nữa khi tới hạn.
        $set: {
          'poll.closedAt': now,
          'poll.closedBy': req.user._id,
          'poll.closeNotifiedAt': now,
        },
        $inc: { 'poll.rev': 1 },
      },
      { new: true },
    );
    if (!updated?.poll) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy bình chọn' });
    }

    await broadcastPollUpdate(conversation, updated);
    firePollLifecycleNotify('poll_closed', conversation, updated, {
      // Người vừa bấm kết thúc thì khỏi tự nhận thông báo.
      recipientEmails: chatRecipientEmails(conversation, req.user.email),
    });

    res.json({
      success: true,
      data: { messageId: String(updated._id), poll: pollPayloadForViewer(updated.poll, req.user) },
    });
  } catch (error) {
    console.error('[Chat] closePoll error:', describeError(error));
    res.status(error.statusCode || 500).json({
      success: false,
      code: error.code,
      message: error.message || 'Không thể kết thúc bình chọn',
    });
  }
};

/** GET /messages/:messageId/poll/voters — danh sách người bầu; 403 với PH khi bình chọn ẩn danh. */
exports.getPollVoters = async (req, res) => {
  try {
    const { message } = await loadMessageWithAccess(req.params.messageId, req.user);
    if (!message.poll) {
      return res.status(400).json({ success: false, message: 'Tin nhắn không phải bình chọn' });
    }
    if (!canSeePollVoters(message.poll, req.user)) {
      return res.status(403).json({
        success: false,
        code: 'POLL_ANONYMOUS',
        message: 'Bình chọn ẩn danh — không xem được danh sách người bầu',
      });
    }

    res.json({
      success: true,
      data: {
        messageId: String(message._id),
        rev: message.poll.rev || 0,
        totalVoters: pollDistinctVoterCount(message.poll),
        options: pollVotersByOption(message.poll),
      },
    });
  } catch (error) {
    console.error('[Chat] getPollVoters error:', describeError(error));
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Không thể tải danh sách người bình chọn',
    });
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
    if (rejectGuardianWriteWhenTeachersOnly(conversation, req, res)) return;
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
    console.error('[Chat] pinMessage error:', describeError(error));
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
    if (rejectGuardianWriteWhenTeachersOnly(conversation, req, res)) return;
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
    console.error('[Chat] unpinMessage error:', describeError(error));
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
    if (rejectGuardianWriteWhenTeachersOnly(conversation, req, res)) return;
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
    console.error('[Chat] recallMessage error:', describeError(error));
    res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Không thể thu hồi tin nhắn' });
  }
};

// ===== Quản lý GVBM trong nhóm lớp (GVCN/phó add/gỡ; GVBM không auto-join) =====

/** Match participant GV với (email chuẩn hoá, teacherId lowercase). */
function teacherParticipantMatches(participant, { email, teacherId }) {
  const pEmail = normalizeEmail(participant.email);
  const pTid = normalizeId(participant.teacherId).toLowerCase();
  return Boolean((email && pEmail === email) || (teacherId && pTid === teacherId));
}

/**
 * Caller phải là GVCN/Phó GVCN của lớp (theo scope Frappe qua token caller) — điều kiện
 * quản lý GVBM trong nhóm. Trả scope; throw 403 nếu không phải.
 */
async function requireHomeroomCaller(conversation, req) {
  const token = getBearerToken(req);
  const scope = await frappeService.getClassChatScope(
    conversation.classId,
    conversation.schoolYearId,
    token,
  );
  if (!scope) {
    const err = new Error('Không tải được thông tin lớp');
    err.statusCode = 502;
    throw err;
  }
  const callerTid = resolveCallerTeacherIdFromScope(req.user, scope);
  const callerEmail = normalizeEmail(req.user?.email);
  const isHomeroom = (scope.teachers || []).some((t) => (
    (callerTid && normalizeId(t.teacherId || t.name) === callerTid)
    || (callerEmail && normalizeEmail(t.email) === callerEmail)
  ));
  if (!isHomeroom) {
    const err = new Error('Chỉ GVCN/Phó GVCN được quản lý GV bộ môn trong nhóm');
    err.statusCode = 403;
    throw err;
  }
  return scope;
}

/** GET /conversations/:conversationId/members/addable — GVBM của lớp chưa trong nhóm. */
exports.listAddableTeachers = async (req, res) => {
  try {
    const conversation = await getConversationForUser(req.params.conversationId, req.user);
    if (conversation.type !== 'class_general') {
      return res.status(400).json({ success: false, message: 'Chỉ áp dụng cho nhóm lớp' });
    }
    const scope = await requireHomeroomCaller(conversation, req);

    const active = (conversation.participants || []).filter(isActiveParticipant);
    const addable = (scope.subject_teachers || [])
      .map((t) => normalizeTeacherSnapshot(t))
      .filter(Boolean)
      .filter((t) => {
        const email = normalizeEmail(t.email);
        const tid = normalizeId(t.teacherId).toLowerCase();
        return !active.some((p) => p.role === 'teacher' && teacherParticipantMatches(p, { email, teacherId: tid }));
      })
      .map((t) => ({
        teacherId: t.teacherId,
        name: t.name,
        email: t.email,
        avatarUrl: t.avatarUrl || '',
        subjects: compactSubjectSnapshots(t.subjects),
      }));

    res.json({ success: true, data: addable });
  } catch (error) {
    console.error('[Chat] listAddableTeachers error:', describeError(error));
    res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Không thể tải danh sách GV bộ môn' });
  }
};

/** POST /conversations/:conversationId/members { teacherId } — GVCN/phó add GVBM vào nhóm. */
exports.addConversationTeacher = async (req, res) => {
  try {
    const conversation = await getConversationForUser(req.params.conversationId, req.user);
    if (conversation.type !== 'class_general') {
      return res.status(400).json({ success: false, message: 'Chỉ áp dụng cho nhóm lớp' });
    }
    const scope = await requireHomeroomCaller(conversation, req);

    const teacherId = normalizeId(req.body.teacherId);
    if (!teacherId) {
      return res.status(400).json({ success: false, message: 'Thiếu teacherId' });
    }
    const target = (scope.subject_teachers || []).find(
      (t) => normalizeId(t.teacherId || t.name) === teacherId,
    );
    if (!target) {
      return res.status(400).json({
        success: false,
        message: 'Chỉ thêm được GV bộ môn đang có phân công giảng dạy với lớp',
      });
    }

    const snap = normalizeTeacherSnapshot(target);
    const email = normalizeEmail(snap.email);
    const tidLower = normalizeId(snap.teacherId).toLowerCase();
    const { byEmail } = await attachMongoUsers({ teachers: [target], guardians: [] });
    const mongoUser = email ? byEmail.get(email) : undefined;
    const addedBy = normalizeEmail(req.user.email);

    const existing = (conversation.participants || []).find(
      (p) => p.role === 'teacher' && teacherParticipantMatches(p, { email, teacherId: tidLower }),
    );
    if (existing) {
      existing.removedAt = null;
      existing.removedReason = undefined;
      existing.manualAdd = true;
      existing.addedBy = addedBy;
      if (!existing.user && mongoUser) existing.user = mongoUser._id;
    } else {
      conversation.participants.push({
        user: mongoUser?._id,
        email,
        name: snap.name,
        role: 'teacher',
        teacherId: snap.teacherId,
        avatarUrl: snap.avatarUrl || userAvatar(mongoUser),
        manualAdd: true,
        addedBy,
      });
    }

    const existSnap = (conversation.teachers || []).find((s) => (
      (email && normalizeEmail(s.email) === email)
      || (s.teacherId && normalizeId(s.teacherId).toLowerCase() === tidLower)
    ));
    const subjects = compactSubjectSnapshots(target.subjects);
    if (existSnap) {
      existSnap.removedAt = null;
      existSnap.manualAdd = true;
      if (subjects.length) existSnap.subjects = subjects;
    } else {
      conversation.teachers.push({
        email,
        name: snap.name,
        teacherId: snap.teacherId,
        avatarUrl: snap.avatarUrl || '',
        subjects,
        manualAdd: true,
      });
    }

    conversation.markModified('participants');
    conversation.markModified('teachers');
    await conversation.save();

    invalidateConversationParticipantsListCaches(conversation).catch(() => {});
    if (mongoUser) cacheDelByPattern(`chat:conv:${String(mongoUser._id)}:*`).catch(() => {});

    console.info('[Chat] GVBM added to class group', {
      conversationId: String(conversation._id),
      teacherId: snap.teacherId,
      email,
      by: addedBy,
    });

    res.json({ success: true, data: serializeConversation(conversation, req.user) });
  } catch (error) {
    console.error('[Chat] addConversationTeacher error:', describeError(error));
    res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Không thể thêm GV bộ môn' });
  }
};

/** DELETE /conversations/:conversationId/members/:teacherId — GVCN/phó gỡ GVBM khỏi nhóm. */
exports.removeConversationTeacher = async (req, res) => {
  try {
    const conversation = await getConversationForUser(req.params.conversationId, req.user);
    if (conversation.type !== 'class_general') {
      return res.status(400).json({ success: false, message: 'Chỉ áp dụng cho nhóm lớp' });
    }
    const scope = await requireHomeroomCaller(conversation, req);

    const key = normalizeId(req.params.teacherId).toLowerCase();
    const target = (conversation.participants || []).find((p) => (
      p.role === 'teacher'
      && !p.removedAt
      && teacherParticipantMatches(p, { email: normalizeEmail(key), teacherId: key })
    ));
    if (!target) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy GV trong nhóm' });
    }

    // Không gỡ GVCN/phó — họ thuộc nhóm theo roster.
    const targetIsHomeroom = (scope.teachers || []).some((t) => teacherParticipantMatches(target, {
      email: normalizeEmail(t.email),
      teacherId: normalizeId(t.teacherId || t.name).toLowerCase(),
    }));
    if (targetIsHomeroom) {
      return res.status(400).json({ success: false, message: 'Không thể gỡ GVCN/Phó GVCN khỏi nhóm' });
    }

    const now = new Date();
    target.removedAt = now;
    target.removedReason = 'manual';
    if (target.user) {
      const uid = String(target.user);
      if (conversation.unreadCounts instanceof Map && conversation.unreadCounts.has(uid)) {
        conversation.unreadCounts.delete(uid);
        conversation.markModified('unreadCounts');
      }
      if (conversation.hiddenFromListAtByUserId instanceof Map && conversation.hiddenFromListAtByUserId.has(uid)) {
        conversation.hiddenFromListAtByUserId.delete(uid);
        conversation.markModified('hiddenFromListAtByUserId');
      }
    }
    for (const snapItem of conversation.teachers || []) {
      if (!snapItem.removedAt && teacherParticipantMatches(
        { email: snapItem.email, teacherId: snapItem.teacherId },
        { email: normalizeEmail(target.email), teacherId: normalizeId(target.teacherId).toLowerCase() },
      )) {
        snapItem.removedAt = now;
      }
    }
    conversation.markModified('participants');
    conversation.markModified('teachers');
    await conversation.save();

    invalidateConversationParticipantsListCaches(conversation).catch(() => {});
    if (target.user) cacheDelByPattern(`chat:conv:${String(target.user)}:*`).catch(() => {});
    if (global.io) {
      const rooms = participantRooms(target);
      if (rooms.length) {
        global.io.to(rooms).emit('chat:conversation_removed', {
          conversationId: String(conversation._id),
        });
        for (const room of rooms) {
          global.io.in(room).socketsLeave(`chat_${String(conversation._id)}`);
        }
      }
    }

    console.info('[Chat] GVBM removed from class group', {
      conversationId: String(conversation._id),
      teacherId: target.teacherId || '',
      email: target.email || '',
      by: normalizeEmail(req.user.email),
    });

    res.json({ success: true, data: serializeConversation(conversation, req.user) });
  } catch (error) {
    console.error('[Chat] removeConversationTeacher error:', describeError(error));
    res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Không thể gỡ GV bộ môn' });
  }
};

// ===== Chế độ ghi của nhóm lớp (GVCN/phó bật "chỉ GV được nhắn") =====

/**
 * PATCH /conversations/:conversationId/write-mode { writeMode }
 * Chỉ GVCN/Phó GVCN của lớp (cùng khuôn quyền với quản lý GVBM) và chỉ với nhóm lớp.
 */
exports.setConversationWriteMode = async (req, res) => {
  try {
    const writeMode = String((req.body || {}).writeMode || '').trim();
    if (!CONVERSATION_WRITE_MODES.has(writeMode)) {
      return res.status(400).json({ success: false, message: 'writeMode không hợp lệ' });
    }
    // Chặn sớm PH: `requireHomeroomCaller` cũng loại, nhưng tránh gọi Frappe bằng token PH.
    if (userRole(req.user) !== 'teacher') {
      return res.status(403).json({ success: false, message: 'Chỉ GVCN/Phó GVCN được khóa nhóm' });
    }
    const conversation = await getConversationForUser(req.params.conversationId, req.user);
    if (conversation.type !== 'class_general') {
      return res.status(400).json({ success: false, message: 'Chỉ áp dụng cho nhóm lớp' });
    }
    // Nhóm lớp/năm học cũ đã khóa cứng cả GV — đổi chế độ ghi không còn ý nghĩa.
    if (conversation.status === 'locked') {
      return res.status(423).json({ success: false, message: 'Nhóm chat năm học cũ chỉ cho xem lại lịch sử' });
    }
    await requireHomeroomCaller(conversation, req);

    const by = normalizeEmail(req.user.email);
    const changedAt = new Date();
    conversation.writeMode = writeMode;
    conversation.writeModeBy = by;
    conversation.writeModeAt = changedAt;
    await conversation.save();

    invalidateConversationParticipantsListCaches(conversation).catch(() => {});

    await emitToConversation(conversation, 'chat:conversation:write_mode', {
      conversationId: String(conversation._id),
      writeMode,
      writeModeBy: by,
      writeModeAt: changedAt.toISOString(),
    });

    console.info('[Chat] conversation writeMode changed', {
      conversationId: String(conversation._id),
      writeMode,
      by,
    });

    res.json({ success: true, data: serializeConversation(conversation, req.user) });
  } catch (error) {
    console.error('[Chat] setConversationWriteMode error:', describeError(error));
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Không thể đổi chế độ nhắn tin của nhóm',
    });
  }
};

exports.canAccessConversation = canAccessConversation;
exports.isConversationParticipant = isConversationParticipant;
exports.buildParticipantMatchOr = buildParticipantMatchOr;
exports.isBodUser = isBodUser;
exports.isActiveParticipant = isActiveParticipant;
// Dùng bởi utils/chatSocket.js (chặn typing của PH khi nhóm ở chế độ "chỉ GV được nhắn").
exports.isTeachersOnlyBlocked = isTeachersOnlyBlocked;
exports.isVisibleSchoolYear = isVisibleSchoolYear;
// Dùng bởi services/chatMembershipSync.js (flow sync/revoke membership theo roster).
exports.collectScopeTeachers = collectScopeTeachers;
exports.buildConversationPayload = buildConversationPayload;
exports.upsertMergedConversationFromPayload = upsertMergedConversationFromPayload;
exports.invalidateConversationParticipantsListCaches = invalidateConversationParticipantsListCaches;
exports.participantIdentityKey = participantIdentityKey;
exports.teacherSnapshotKey = teacherSnapshotKey;
exports.guardianSnapshotKey = guardianSnapshotKey;
exports.mergeSnapshotFields = mergeSnapshotFields;
exports.unionByKey = unionByKey;
exports.parentPortalEmailFromGuardianId = parentPortalEmailFromGuardianId;
exports.portalGuardianIdFromEmail = portalGuardianIdFromEmail;
// Bình chọn — export để kiểm thử quy tắc ẩn danh (room GV không được lẫn PH) và serialize theo người xem.
exports.pollTeacherOnlyRooms = pollTeacherOnlyRooms;
exports.pollPayloadForViewer = pollPayloadForViewer;
// Dùng bởi services/pollScheduler.js (nhắc trước hạn + báo hết hạn).
exports.pollPendingVoterEmails = pollPendingVoterEmails;
exports.firePollLifecycleNotify = firePollLifecycleNotify;
exports.broadcastPollUpdate = broadcastPollUpdate;
exports.chatRecipientEmails = chatRecipientEmails;
exports.canSeePollVoters = canSeePollVoters;
exports.pollEffectiveClosedAt = pollEffectiveClosedAt;
exports.buildPollFromRequestBody = buildPollFromRequestBody;
/** Trần đính kèm mỗi tin — routes/chatRoutes.js dùng lại để multer khớp cùng số. */
exports.CHAT_MAX_ATTACHMENTS = CHAT_MAX_ATTACHMENTS;
