/**
 * 🔄 Sync/revoke membership nhóm chat lớp theo roster Frappe.
 *
 * Read-path chỉ UNION membership (xem comment tại chatController — tránh bug scope thiếu
 * teachers làm GV mất quyền). File này là "flow đồng bộ riêng" được nhắc trong comment đó:
 * chạy từ cron/endpoint admin với scope AUTHORITATIVE (get_class_chat_scope_for_sync,
 * marker scopeComplete) — đủ điều kiện để soft-remove participant không còn trong roster.
 *
 * Nguyên tắc an toàn: bất kỳ guard nào fail ⇒ CHỈ ADD, KHÔNG revoke.
 * Chỉ áp dụng cho `class_general`; chat 1-1 `teacher_guardian:*` không đụng (v1).
 */

const ChatConversation = require('../models/ChatConversation');
const frappeService = require('./frappeService');
const {
  collectScopeTeachers,
  buildConversationPayload,
  upsertMergedConversationFromPayload,
  invalidateConversationParticipantsListCaches,
  parentPortalEmailFromGuardianId,
  portalGuardianIdFromEmail,
} = require('../controllers/chatController');
const { participantRooms } = require('../utils/chatBroadcastRooms');
const { cacheDelByPattern } = require('../utils/cache');

const MAX_REMOVAL_RATIO = Math.min(
  Math.max(parseFloat(process.env.CHAT_SYNC_MAX_REMOVAL_RATIO || '0.5') || 0.5, 0),
  1,
);
const SYNC_CONCURRENCY = Math.max(parseInt(process.env.CHAT_SYNC_CONCURRENCY || '2', 10) || 2, 1);

function normalizeEmail(value) {
  return value ? String(value).trim().toLowerCase() : '';
}

function normalizeId(value) {
  return value ? String(value).trim() : '';
}

/** Tập khóa nhận diện GV còn trong roster (email + teacherId, GVCN ∪ GVBM). */
function buildTeacherKeySets(scope) {
  const emails = new Set();
  const teacherIds = new Set();
  for (const t of collectScopeTeachers(scope)) {
    const email = normalizeEmail(t.email);
    if (email) emails.add(email);
    const tid = normalizeId(t.teacherId || t.name).toLowerCase();
    if (tid) teacherIds.add(tid);
  }
  return { emails, teacherIds };
}

/** Tập khóa nhận diện PH còn trong roster (guardianId + email thường + email portal). */
function buildGuardianKeySets(scope) {
  const guardianIds = new Set();
  const emails = new Set();
  for (const g of scope.guardians || []) {
    const gid = normalizeId(g.guardian_id || g.guardianId || g.name).toLowerCase();
    if (gid) {
      guardianIds.add(gid);
      const portal = normalizeEmail(parentPortalEmailFromGuardianId(gid));
      if (portal) emails.add(portal);
    }
    const email = normalizeEmail(g.email || g.portalEmail);
    if (email) emails.add(email);
  }
  return { guardianIds, emails };
}

/** Participant GV còn trong scope? Cross-match email/teacherId như canAccessConversation. */
function teacherStillInScope(participant, teacherKeys) {
  const email = normalizeEmail(participant.email);
  if (email && teacherKeys.emails.has(email)) return true;
  const tid = normalizeId(participant.teacherId).toLowerCase();
  if (tid && teacherKeys.teacherIds.has(tid)) return true;
  return false;
}

/** Participant PH còn trong scope? Cross-match guardianId ↔ email portal cả 2 chiều. */
function guardianStillInScope(participant, guardianKeys) {
  const gid = normalizeId(participant.guardianId).toLowerCase();
  if (gid && guardianKeys.guardianIds.has(gid)) return true;
  const email = normalizeEmail(participant.email);
  if (email) {
    if (guardianKeys.emails.has(email)) return true;
    const gidFromEmail = portalGuardianIdFromEmail(email);
    if (gidFromEmail && guardianKeys.guardianIds.has(gidFromEmail)) return true;
  }
  if (gid) {
    const portalFromGid = normalizeEmail(parentPortalEmailFromGuardianId(gid));
    if (portalFromGid && guardianKeys.emails.has(portalFromGid)) return true;
  }
  return false;
}

/** Khóa snapshot ↔ participant để đánh dấu removedAt đồng bộ 2 danh sách hiển thị. */
function snapshotMatchesParticipant(snapshot, participant) {
  const sEmail = normalizeEmail(snapshot.email);
  const pEmail = normalizeEmail(participant.email);
  if (sEmail && pEmail && sEmail === pEmail) return true;
  const sTid = normalizeId(snapshot.teacherId).toLowerCase();
  const pTid = normalizeId(participant.teacherId).toLowerCase();
  if (sTid && pTid && sTid === pTid) return true;
  const sGid = normalizeId(snapshot.guardianId).toLowerCase();
  const pGid = normalizeId(participant.guardianId).toLowerCase();
  if (sGid && pGid && sGid === pGid) return true;
  return false;
}

function deleteMapKey(conversation, field, key) {
  let m = conversation[field];
  if (!m) return false;
  if (!(m instanceof Map)) {
    m = new Map(Object.entries(m || {}));
    conversation[field] = m;
  }
  if (!m.has(key)) return false;
  m.delete(key);
  conversation.markModified(field);
  return true;
}

/**
 * Reconcile MỘT conversation class_general với scope authoritative.
 * @returns {{ added: number, removed: number, reactivated: number, guard: string|null }}
 */
async function reconcileClassConversation(conversationRef, scope, { dryRun = false } = {}) {
  const stats = { added: 0, removed: 0, reactivated: 0, created: false, guard: null };

  // Target có thể chưa có nhóm trong Mongo (lớp enumerate từ Frappe, chưa ai mở chat)
  // → upsert sẽ TẠO mới thay vì chỉ merge.
  let before = null;
  if (conversationRef?._id) {
    before = await ChatConversation.findById(conversationRef._id);
  }
  if (!before && conversationRef?.classId) {
    before = await ChatConversation.findOne({
      classId: conversationRef.classId,
      schoolYearId: conversationRef.schoolYearId,
      type: 'class_general',
    });
  }

  const activeBefore = before ? (before.participants || []).filter((p) => !p.removedAt) : [];
  const removedBefore = before ? (before.participants || []).filter((p) => Boolean(p.removedAt)) : [];

  // Chỉ TẠO MỚI nhóm cho lớp chính quy — lớp mixed/club không auto-tạo (khớp isRegularScope
  // ở read-path). Nhóm đã tồn tại thì vẫn reconcile bình thường.
  const classType = String(scope?.classType || scope?.class_type || '').trim().toLowerCase();
  if (!before && classType !== 'regular') {
    stats.guard = 'CLASS_TYPE_NOT_REGULAR';
    return stats;
  }

  // ===== BƯỚC 1: ADD/MERGE — payload dùng teachers ∪ subject_teachers (GVBM vào nhóm luôn,
  // fix luôn gap "GV mới được phân công chưa thấy nhóm"). Merge tự reactivate người quay lại roster.
  const scopeForPayload = { ...scope, teachers: collectScopeTeachers(scope) };
  const payload = await buildConversationPayload(scopeForPayload, 'class_general', null);
  let conversation = before;
  if (!dryRun) {
    conversation = await upsertMergedConversationFromPayload(payload);
    stats.created = !before;
  } else if (!before) {
    // dryRun không ghi gì — chỉ báo sẽ tạo nhóm mới.
    stats.guard = 'DRY_RUN_WOULD_CREATE';
    return stats;
  }

  // ===== BƯỚC 2: diff — active participant không còn trong scope ⇒ candidate revoke.
  const teacherKeys = buildTeacherKeySets(scope);
  const guardianKeys = buildGuardianKeySets(scope);

  const activeNow = (conversation.participants || []).filter((p) => !p.removedAt);
  const toRemove = activeNow.filter((p) => (
    p.role === 'teacher'
      ? !teacherStillInScope(p, teacherKeys)
      : !guardianStillInScope(p, guardianKeys)
  ));

  stats.added = Math.max(0, activeNow.length - activeBefore.length);
  stats.reactivated = Math.max(
    0,
    removedBefore.length - (conversation.participants || []).filter((p) => Boolean(p.removedAt)).length,
  );

  // Có thêm người / tạo nhóm mới ⇒ xóa cache list để GV/PH mới thấy nhóm ngay,
  // kể cả khi không có ai bị revoke (bước 5 chỉ chạy khi có toRemove).
  if (!dryRun && (stats.created || stats.added > 0 || stats.reactivated > 0)) {
    invalidateConversationParticipantsListCaches(conversation).catch(() => {});
  }

  // ===== BƯỚC 3: GUARDS — fail bất kỳ ⇒ chỉ ADD (đã làm ở bước 1), KHÔNG revoke.
  const scopeTeachers = collectScopeTeachers(scope);
  if (scope.scopeComplete !== true) {
    stats.guard = 'SCOPE_NOT_AUTHORITATIVE';
  } else if (!scopeTeachers.length) {
    stats.guard = 'SCOPE_ZERO_TEACHERS';
  } else if (!(scope.students || []).length && !(scope.guardians || []).length) {
    stats.guard = 'SCOPE_EMPTY_ROSTER';
  } else if (conversation.status === 'locked' || scope.isActive === false) {
    // Lớp/năm học cũ: giữ nguyên membership để xem lại lịch sử.
    stats.guard = 'CLASS_LOCKED';
  } else if (activeNow.length && toRemove.length / activeNow.length > MAX_REMOVAL_RATIO) {
    stats.guard = 'REMOVAL_RATIO_EXCEEDED';
  } else {
    const teachersLeft = activeNow.filter(
      (p) => p.role === 'teacher' && !toRemove.includes(p),
    );
    if (!teachersLeft.length && toRemove.some((p) => p.role === 'teacher')) {
      stats.guard = 'WOULD_REMOVE_LAST_TEACHER';
    }
  }

  if (stats.guard) {
    if (toRemove.length) {
      console.warn('[ChatMembershipSync] guard trip — bỏ qua revoke', {
        conversationId: String(conversation._id),
        classId: conversation.classId,
        schoolYearId: conversation.schoolYearId,
        guard: stats.guard,
        wouldRemove: toRemove.length,
      });
    }
    return stats;
  }

  if (!toRemove.length) return stats;

  if (dryRun) {
    stats.removed = toRemove.length;
    console.info('[ChatMembershipSync][dry-run] diff', {
      conversationId: String(conversation._id),
      classId: conversation.classId,
      schoolYearId: conversation.schoolYearId,
      remove: toRemove.map((p) => ({
        role: p.role,
        email: p.email || '',
        teacherId: p.teacherId || '',
        guardianId: p.guardianId || '',
        name: p.name || '',
      })),
    });
    return stats;
  }

  // ===== BƯỚC 4: APPLY — soft-remove + dọn unreadCounts/hidden state của user bị gỡ.
  const now = new Date();
  for (const p of toRemove) {
    p.removedAt = now;
    p.removedReason = 'roster_sync';
    if (p.user) {
      const key = String(p.user);
      deleteMapKey(conversation, 'unreadCounts', key);
      deleteMapKey(conversation, 'hiddenFromListAtByUserId', key);
    }
    for (const list of [conversation.teachers, conversation.guardians]) {
      for (const snap of list || []) {
        if (!snap.removedAt && snapshotMatchesParticipant(snap, p)) {
          snap.removedAt = now;
        }
      }
    }
  }
  conversation.membershipSyncedAt = now;
  conversation.markModified('participants');
  conversation.markModified('teachers');
  conversation.markModified('guardians');
  await conversation.save();
  stats.removed = toRemove.length;

  console.info('[ChatMembershipSync] revoked', {
    conversationId: String(conversation._id),
    classId: conversation.classId,
    schoolYearId: conversation.schoolYearId,
    removed: toRemove.map((p) => `${p.role}:${p.email || p.teacherId || p.guardianId || p.name}`),
  });

  // ===== BƯỚC 5: side effects — cache list + socket của người bị gỡ; cache người được add.
  await Promise.all(
    toRemove
      .filter((p) => p.user)
      .map((p) => cacheDelByPattern(`chat:conv:${String(p.user)}:*`).catch(() => {})),
  );
  if (global.io) {
    const chatRoom = `chat_${String(conversation._id)}`;
    for (const p of toRemove) {
      const rooms = participantRooms(p);
      if (!rooms.length) continue;
      global.io.to(rooms).emit('chat:conversation_removed', {
        conversationId: String(conversation._id),
      });
      for (const room of rooms) {
        // redis-adapter (socket.io >= 4.x): socketsLeave có hiệu lực cluster-wide.
        global.io.in(room).socketsLeave(chatRoom);
      }
    }
  }
  invalidateConversationParticipantsListCaches(conversation).catch(() => {});
  frappeService
    .invalidateCachesForClassChat(conversation.classId, conversation.schoolYearId)
    .catch(() => {});
  // Cache notify:recipients:* TTL 60s — tự hết, không cần đụng.

  return stats;
}

/**
 * Sync toàn bộ (hoặc một lớp) — enumerate class_general trong Mongo, mỗi lớp lấy scope
 * sync từ Frappe. Lỗi đọc scope ⇒ skip lớp đó (lỗi đọc ≠ roster rỗng), KHÔNG revoke.
 */
async function runFullMembershipSync({ classId, schoolYearId, dryRun = false } = {}) {
  const filter = { type: 'class_general' };
  if (classId) filter.classId = String(classId).trim();
  if (schoolYearId) filter.schoolYearId = String(schoolYearId).trim();

  const mongoTargets = await ChatConversation.find(filter)
    .select('_id classId schoolYearId status')
    .lean();

  // Union thêm lớp từ Frappe (năm học đang bật) — TẠO nhóm còn thiếu cho lớp chưa ai mở chat.
  // Lỗi liệt kê ⇒ fallback quét nhóm sẵn có (job vẫn chạy, chỉ mất chiều "tạo mới").
  const byKey = new Map(
    mongoTargets.map((t) => [`${t.classId}\0${t.schoolYearId}`, t]),
  );
  let frappeTargetCount = 0;
  try {
    const frappeTargets = await frappeService.listClassChatSyncTargets();
    for (const t of frappeTargets) {
      const cid = String(t.classId || '').trim();
      const sy = String(t.schoolYearId || '').trim();
      if (!cid || !sy) continue;
      if (classId && cid !== String(classId).trim()) continue;
      if (schoolYearId && sy !== String(schoolYearId).trim()) continue;
      const key = `${cid}\0${sy}`;
      if (!byKey.has(key)) {
        byKey.set(key, { classId: cid, schoolYearId: sy });
        frappeTargetCount += 1;
      }
    }
  } catch (e) {
    console.warn('[ChatMembershipSync] listClassChatSyncTargets failed — chỉ quét nhóm sẵn có', {
      error: e?.response?.status || e.message,
    });
  }
  const targets = Array.from(byKey.values());
  if (frappeTargetCount) {
    console.info('[ChatMembershipSync] targets', {
      fromMongo: mongoTargets.length,
      newFromFrappe: frappeTargetCount,
      total: targets.length,
    });
  }

  const summary = {
    dryRun: Boolean(dryRun),
    total: targets.length,
    processed: 0,
    added: 0,
    removed: 0,
    reactivated: 0,
    created: 0,
    guards: {},
    scopeErrors: 0,
    results: [],
  };

  let cursor = 0;
  const worker = async () => {
    while (cursor < targets.length) {
      const target = targets[cursor];
      cursor += 1;
      const line = {
        classId: target.classId,
        schoolYearId: target.schoolYearId,
        added: 0,
        removed: 0,
        reactivated: 0,
        guard: null,
      };
      try {
        const scope = await frappeService.getClassChatScopeForSync(
          target.classId,
          target.schoolYearId,
        );
        if (!scope) {
          line.guard = 'SCOPE_NOT_FOUND';
          summary.scopeErrors += 1;
        } else {
          const stats = await reconcileClassConversation(target, scope, { dryRun });
          Object.assign(line, stats);
        }
      } catch (e) {
        if (e?.frappeCode === 'CLASS_NOT_FOUND') {
          // Lớp đã bị xoá trong SIS nhưng nhóm chat còn trong Mongo (nhóm mồ côi):
          // KHOÁ nhóm để giữ lịch sử xem lại, không cho hoạt động tiếp. Không revoke ai.
          line.guard = 'CLASS_NOT_FOUND';
          if (!dryRun && target._id) {
            try {
              await ChatConversation.updateOne(
                { _id: target._id, status: { $ne: 'locked' } },
                {
                  $set: {
                    status: 'locked',
                    lockedReason: 'Lớp không còn tồn tại trong SIS — chỉ xem lại lịch sử',
                  },
                },
              );
              line.locked = true;
            } catch (lockErr) {
              console.warn('[ChatMembershipSync] lock orphan conversation failed', {
                classId: target.classId,
                error: lockErr.message,
              });
            }
          }
          console.warn('[ChatMembershipSync] lớp không còn trong SIS — khoá nhóm mồ côi', {
            classId: target.classId,
            schoolYearId: target.schoolYearId,
            dryRun,
          });
        } else {
          line.guard = 'SCOPE_FETCH_ERROR';
          line.error = e?.frappeCode || e?.response?.status || e.message;
          summary.scopeErrors += 1;
          console.warn('[ChatMembershipSync] scope fetch failed — skip lớp', {
            classId: target.classId,
            schoolYearId: target.schoolYearId,
            error: line.error,
          });
        }
      }
      summary.processed += 1;
      summary.added += line.added;
      summary.removed += line.removed;
      summary.reactivated += line.reactivated;
      if (line.created) summary.created += 1;
      if (line.guard) summary.guards[line.guard] = (summary.guards[line.guard] || 0) + 1;
      summary.results.push(line);
      console.info('[ChatMembershipSync] class done', JSON.stringify(line));
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(SYNC_CONCURRENCY, targets.length || 1) }, () => worker()),
  );

  console.info('[ChatMembershipSync] summary', JSON.stringify({
    dryRun: summary.dryRun,
    total: summary.total,
    added: summary.added,
    removed: summary.removed,
    reactivated: summary.reactivated,
    created: summary.created,
    guards: summary.guards,
    scopeErrors: summary.scopeErrors,
  }));

  return summary;
}

module.exports = {
  reconcileClassConversation,
  runFullMembershipSync,
};
