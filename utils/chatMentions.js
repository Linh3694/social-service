/**
 * 🏷️ Mention trong chat (SIS-179) — logic thuần, không đụng mongoose/Express.
 *
 * Mô hình CỐ Ý tổng quát để nhóm chat tự tạo sau này không phải viết lại:
 *   - Vai trò trong nhóm: `admin` (Trưởng/Phó nhóm) vs `member`. Với nhóm lớp, `admin` được
 *     SUY RA từ `homeroomRole` của snapshot GV (GVCN/Phó GVCN) — không cần backfill dữ liệu.
 *   - Phân loại thành viên (`segment`): hiện có `teachers` / `guardians`, suy từ `participant.role`.
 *     Thêm segment mới ⇒ chỉ mở rộng `ROLE_TO_SEGMENT`, không đụng luồng gửi tin.
 *
 * Tin nhắn lưu `content` TEXT THUẦN ("@Nguyễn Văn A xem giúp") + mảng `mentions` neo theo
 * offset. Client cũ chưa cập nhật vẫn đọc được tin bình thường (không lộ token `@[id]`),
 * `lastMessage.content` không đổi, và không phải migrate tin cũ.
 *
 * KHÔNG chứa nhãn hiển thị ("Tất cả" / "Giáo viên"): nhãn do từng client dịch theo i18n,
 * server chỉ giữ `type` + `segment` + tên người dùng đã gõ.
 */

/** Loại mention. `segment` gom mọi kiểu "tag cả nhóm con" để thêm nhóm mới không phải đổi enum. */
const MENTION_TYPES = ['user', 'segment', 'everyone'];

/** participant.role (dữ liệu đang có) → segment id. */
const ROLE_TO_SEGMENT = {
  teacher: 'teachers',
  guardian: 'guardians',
};

/** Segment mặc định khi hội thoại chưa có participant nào (nhóm vừa tạo). */
const DEFAULT_SEGMENTS = ['teachers', 'guardians'];

/** Trần số mention một tin — chặn payload rác, không phải giới hạn nghiệp vụ. */
const MAX_MENTIONS_PER_MESSAGE = 50;

/** Vai trò nhóm được coi là quản trị (Trưởng/Phó nhóm). */
const ADMIN_GROUP_ROLES = new Set(['owner', 'admin']);

/** homeroomRole của snapshot GV được coi là quản trị nhóm lớp. */
const HOMEROOM_ADMIN_ROLES = new Set(['homeroom', 'vice_homeroom']);

function normalizeEmail(value) {
  return value ? String(value).trim().toLowerCase() : '';
}

function normalizeId(value) {
  return value ? String(value).trim() : '';
}

/**
 * Các segment CÓ MẶT trong hội thoại (suy từ participants đang active).
 * Nhóm chỉ có GV ⇒ ['teachers'] ⇒ `@Tất cả` chỉ cần quyền với segment đó.
 */
function conversationSegments(conversation) {
  const found = [];
  for (const p of conversation?.participants || []) {
    if (!p || p.removedAt) continue;
    const segment = ROLE_TO_SEGMENT[String(p.role || '')];
    if (segment && !found.includes(segment)) found.push(segment);
  }
  return found.length ? found : [...DEFAULT_SEGMENTS];
}

/**
 * Chuẩn hoá `mentionPolicy` lưu trong hội thoại về dạng `{ [actorRole]: { [segment]: bool } }`.
 * Key thiếu ⇒ hiểu là ĐƯỢC PHÉP: nhóm cũ chưa có field vẫn giữ nguyên hành vi mở.
 */
function normalizeMentionPolicy(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  const source = typeof raw.toObject === 'function' ? raw.toObject() : raw;
  for (const [actorRole, segments] of Object.entries(source)) {
    if (!ROLE_TO_SEGMENT[actorRole] || !segments || typeof segments !== 'object') continue;
    const bySegment = {};
    for (const [segment, allowed] of Object.entries(segments)) {
      if (!DEFAULT_SEGMENTS.includes(segment) && !Object.values(ROLE_TO_SEGMENT).includes(segment)) {
        continue;
      }
      bySegment[segment] = Boolean(allowed);
    }
    if (Object.keys(bySegment).length) out[actorRole] = bySegment;
  }
  return out;
}

/** Gộp policy hiện có với phần cập nhật (nhận cập nhật TỪNG PHẦN, không phải ghi đè cả cây). */
function mergeMentionPolicy(current, patch) {
  const base = normalizeMentionPolicy(current);
  const incoming = normalizeMentionPolicy(patch);
  const merged = { ...base };
  for (const [actorRole, segments] of Object.entries(incoming)) {
    merged[actorRole] = { ...(merged[actorRole] || {}), ...segments };
  }
  return merged;
}

/** Thành viên thường (không phải quản trị nhóm) có được tag cả `segment` không. */
function isSegmentMentionAllowed(policy, actorRole, segment) {
  const normalized = normalizeMentionPolicy(policy);
  const entry = normalized[actorRole];
  if (!entry || entry[segment] === undefined) return true; // thiếu cấu hình = mở
  return entry[segment] === true;
}

/**
 * Người dùng có phải quản trị nhóm không.
 *
 * @param {object} conversation
 * @param {{ userId?: string, email?: string, teacherId?: string, role?: 'teacher'|'guardian' }} identity
 */
function resolveConversationAdmin(conversation, identity) {
  const userId = normalizeId(identity?.userId);
  const email = normalizeEmail(identity?.email);
  const teacherId = normalizeId(identity?.teacherId).toLowerCase();

  // 1. Vai trò ghi thẳng trên participant — đường dùng cho nhóm tự tạo sau này.
  for (const p of conversation?.participants || []) {
    if (!p || p.removedAt) continue;
    const matched = (userId && p.user && String(p.user) === userId)
      || (email && normalizeEmail(p.email) === email);
    if (matched && ADMIN_GROUP_ROLES.has(String(p.groupRole || ''))) return true;
  }

  // 2. Nhóm lớp: quản trị = GVCN/Phó GVCN theo snapshot roster.
  if (identity?.role === 'guardian') return false;
  for (const t of conversation?.teachers || []) {
    if (!t || t.removedAt) continue;
    if (!HOMEROOM_ADMIN_ROLES.has(String(t.homeroomRole || ''))) continue;
    if (email && normalizeEmail(t.email) === email) return true;
    if (teacherId && normalizeId(t.teacherId).toLowerCase() === teacherId) return true;
  }
  return false;
}

/**
 * Quyền tag NHÓM của một người xem — server tính, client chỉ vẽ theo.
 * Tag từng người cụ thể luôn được phép nên không có mặt ở đây.
 */
function viewerMentionPermissions(conversation, identity) {
  const segments = conversationSegments(conversation);
  const isGroupAdmin = resolveConversationAdmin(conversation, identity);
  const actorRole = identity?.role === 'guardian' ? 'guardian' : 'teacher';
  const allowedSegments = isGroupAdmin
    ? [...segments]
    : segments.filter((segment) => isSegmentMentionAllowed(
      conversation?.mentionPolicy,
      actorRole,
      segment,
    ));
  return {
    isGroupAdmin,
    allowedSegments,
    // `@Tất cả` không có công tắc riêng: phải với tới MỌI segment của nhóm mới hiện ra,
    // nếu không sẽ thành đường vòng cho người đang bị chặn một nhóm con.
    canMentionEveryone: allowedSegments.length > 0 && allowedSegments.length === segments.length,
  };
}

/**
 * Tìm lại vị trí của một mention trong nội dung ĐÃ chuẩn hoá (server trim `content`).
 * Ưu tiên offset client gửi; lệch thì dò lại nếu chuỗi `@Tên` chỉ xuất hiện đúng một lần.
 * @returns {{ start: number, length: number } | null}
 */
function resolveMentionRange(content, mention) {
  const name = String(mention?.name || '').trim();
  if (!name) return null;
  const token = `@${name}`;
  const start = Number(mention?.start);
  if (Number.isInteger(start) && start >= 0 && content.substr(start, token.length) === token) {
    return { start, length: token.length };
  }
  const first = content.indexOf(token);
  if (first < 0) return null;
  if (content.indexOf(token, first + 1) >= 0) return null; // trùng lặp ⇒ không đoán bừa
  return { start: first, length: token.length };
}

/**
 * Lọc & xác thực mentions client gửi lên.
 *
 * - Bỏ mention không khớp nội dung, trùng dải, hoặc trỏ tới người ngoài nhóm.
 * - Tag nhóm vượt quyền ⇒ ném lỗi 403 (KHÔNG âm thầm bỏ: người gửi phải biết tin của mình
 *   không nhắc được cả nhóm, thay vì tưởng đã nhắc).
 *
 * @param {Array} raw danh sách mention client gửi
 * @param {string} content nội dung tin ĐÃ trim
 * @param {{ segments: string[], permissions: object, findMember: (m) => object|null }} ctx
 */
function sanitizeMentions(raw, content, ctx) {
  if (!Array.isArray(raw) || !raw.length) return [];
  const text = String(content || '');
  if (!text) return [];

  const segments = ctx?.segments || [...DEFAULT_SEGMENTS];
  const permissions = ctx?.permissions || {};
  const findMember = typeof ctx?.findMember === 'function' ? ctx.findMember : () => null;

  const out = [];
  const takenRanges = [];
  const seenKeys = new Set();

  for (const item of raw.slice(0, MAX_MENTIONS_PER_MESSAGE)) {
    const type = String(item?.type || '').trim();
    if (!MENTION_TYPES.includes(type)) continue;

    const range = resolveMentionRange(text, item);
    if (!range) continue;
    const overlaps = takenRanges.some((r) => (
      range.start < r.start + r.length && r.start < range.start + range.length
    ));
    if (overlaps) continue;

    const name = String(item.name).trim();
    let entry = null;

    if (type === 'everyone') {
      if (!permissions.canMentionEveryone) {
        const err = new Error('Bạn không được nhắc tất cả thành viên trong nhóm này');
        err.statusCode = 403;
        err.code = 'MENTION_ALL_FORBIDDEN';
        throw err;
      }
      entry = { type, name };
    } else if (type === 'segment') {
      const segment = String(item.segment || '').trim();
      if (!segments.includes(segment)) continue;
      if (!(permissions.allowedSegments || []).includes(segment)) {
        const err = new Error('Bạn không được nhắc cả nhóm thành viên này');
        err.statusCode = 403;
        err.code = 'MENTION_ALL_FORBIDDEN';
        throw err;
      }
      entry = { type, segment, name };
    } else {
      // Tag từng người: ai cũng được, nhưng chỉ với người ĐANG trong nhóm.
      const member = findMember(item);
      if (!member) continue;
      entry = {
        type,
        name,
        userId: member.userId || undefined,
        email: member.email || undefined,
      };
    }

    const key = entry.type === 'user'
      ? `user:${entry.userId || entry.email}`
      : `${entry.type}:${entry.segment || ''}`;
    if (seenKeys.has(key)) continue;

    seenKeys.add(key);
    takenRanges.push(range);
    out.push({ ...entry, start: range.start, length: range.length });
  }

  return out.sort((a, b) => a.start - b.start);
}

/**
 * Email những người được nhắc trong tin — luôn loại người gửi.
 * `members` là danh sách thành viên ĐANG active: { userId, email, role }.
 */
function mentionRecipientEmails(members, mentions, senderEmail) {
  if (!Array.isArray(mentions) || !mentions.length) return [];
  const senderNorm = normalizeEmail(senderEmail);
  const wantEveryone = mentions.some((m) => m.type === 'everyone');
  const wantSegments = new Set(
    mentions.filter((m) => m.type === 'segment').map((m) => m.segment),
  );
  const wantUserIds = new Set(
    mentions.filter((m) => m.type === 'user' && m.userId).map((m) => String(m.userId)),
  );
  const wantEmails = new Set(
    mentions.filter((m) => m.type === 'user' && m.email).map((m) => normalizeEmail(m.email)),
  );

  const seen = new Set();
  const emails = [];
  for (const member of members || []) {
    const norm = normalizeEmail(member?.email);
    if (!norm || norm === senderNorm || seen.has(norm)) continue;
    const segment = ROLE_TO_SEGMENT[String(member?.role || '')];
    const hit = wantEveryone
      || (segment && wantSegments.has(segment))
      || (member?.userId && wantUserIds.has(String(member.userId)))
      || wantEmails.has(norm);
    if (!hit) continue;
    seen.add(norm);
    emails.push(String(member.email).trim());
  }
  return emails;
}

module.exports = {
  MENTION_TYPES,
  ROLE_TO_SEGMENT,
  DEFAULT_SEGMENTS,
  MAX_MENTIONS_PER_MESSAGE,
  conversationSegments,
  normalizeMentionPolicy,
  mergeMentionPolicy,
  isSegmentMentionAllowed,
  resolveConversationAdmin,
  viewerMentionPermissions,
  resolveMentionRange,
  sanitizeMentions,
  mentionRecipientEmails,
};
