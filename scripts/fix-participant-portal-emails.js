#!/usr/bin/env node

/**
 * 🔧 Backfill `participants[].email` (và `guardians[].email`) bị ghi bằng giá trị rác
 *     lấy từ `CRM Guardian.email`.
 *
 * Chạy thử (KHÔNG ghi DB):   node scripts/fix-participant-portal-emails.js
 * Ghi DB thật:               node scripts/fix-participant-portal-emails.js --apply
 *
 * ── BỐI CẢNH ────────────────────────────────────────────────────────────────────
 * `CRM Guardian.email` là cột ĐỊNH DANH nội bộ của CRM, KHÔNG đảm bảo là email hợp lệ
 * và KHÔNG phải tài khoản đăng nhập (trên prod đã gặp giá trị "32"). Tài khoản portal
 * thật là `{guardian_id}@parent.wellspring.edu.vn`, Frappe trả ở field `portalEmail`.
 *
 * Ba chỗ trong luồng chat từng ưu tiên sai (`g.email || g.portalEmail`) nên đã ĐÓNG DẤU
 * giá trị rác vào Mongo:
 *   - controllers/chatController.js:709  (buildSubsetConversationPayload)
 *   - controllers/chatController.js:825  (buildClassConversationPayload)
 *   - services/chatMembershipSync.js:61  (buildGuardianKeySets — chỉ khớp, không ghi)
 *
 * Hệ quả: `chatRecipientEmails` (chatController.js:176) đọc thẳng `p.email` để gửi push
 * ⇒ PH đó KHÔNG nhận thông báo chat. Nhưng `participantRooms` (utils/chatBroadcastRooms.js)
 * còn dựng phòng từ `participant.guardianId` ⇒ PH vẫn THẤY tin nhắn khi đang mở app và
 * vẫn là thành viên. Đúng triệu chứng đã quan sát trên prod.
 *
 * ── VÌ SAO PHẢI BACKFILL, KHÔNG CHỜ SYNC TỰ CHỮA ────────────────────────────────
 * `participantIdentityKey` (chatController.js:933): có `user` ⇒ khoá `role|user:<id>`,
 * không có ⇒ `role|email:<email>`. Participant hỏng thường KHÔNG có `user` (lookup Mongo
 * trượt vì tra bằng chính email rác) ⇒ khoá là `guardian|email:32`. Sau khi vá code, sync
 * sinh participant khoá `guardian|user:<id>` — KHÔNG trùng khoá cũ, mà `unionByKey`
 * (chatController.js:967) KHÔNG BAO GIỜ xoá entry cũ ⇒ chạy sync chỉ THÊM BẢN SAO,
 * participant hỏng nằm lại vĩnh viễn.
 *
 * Script này vì thế ghi CẢ `email` LẪN `user` để khoá định danh khớp với payload sync,
 * lần sync sau merge đè tại chỗ thay vì đẻ bản sao.
 *
 * ── AN TOÀN ─────────────────────────────────────────────────────────────────────
 * - KHÔNG xoá / KHÔNG tạo lại participant. Chỉ `$set` field trên phần tử sẵn có.
 * - KHÔNG đụng `unreadCounts`, `hiddenFromListAtByUserId`, `ChatMessage.readBy`
 *   (trạng thái đã đọc khoá theo `user._id`, không theo email) ⇒ giữ nguyên.
 * - KHÔNG đụng `guardians[].contactEmail` — đó là email LIÊN LẠC để hiển thị, khác
 *   `email` định danh (xem models/ChatConversation.js:33-40).
 * - Participant role `teacher` có email hỏng ⇒ CHỈ BÁO CÁO, không tự đoán, không ghi.
 * - Idempotent: điều kiện ghi nằm trong `arrayFilters` (`email` chưa chứa "@"). Chạy lần 2
 *   ⇒ 0 bản ghi khớp. Ứng dụng có sửa xen kẽ thì lệnh ghi tự no-op, không đè ngược.
 *
 * ── CỜ ──────────────────────────────────────────────────────────────────────────
 *   --apply                 ghi DB (mặc định: dry-run, chỉ in)
 *   --conversation=<id>     chỉ xử lý 1 hội thoại (canary)
 *   --guardian=<guardian_id> chỉ xử lý 1 PH (canary, vd nguyen-duy-hieu-6213)
 *   --limit=<n>             giới hạn số hội thoại quét
 *   --merge-duplicates      khi đã tồn tại participant ĐÚNG cùng người trong hội thoại:
 *                           soft-remove (removedAt) bản hỏng thay vì bỏ qua. Không xoá.
 *   --verbose               in từng dòng thay đổi
 */

require('dotenv').config({ path: require('path').join(__dirname, '../config.env') });

const mongoose = require('mongoose');
const ChatConversation = require('../models/ChatConversation');
const User = require('../models/User');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/wis_social';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3).trim() : '';
};

const APPLY = flag('apply');
const MERGE_DUPES = flag('merge-duplicates');
const VERBOSE = flag('verbose');
const ONLY_CONVERSATION = opt('conversation');
const ONLY_GUARDIAN = opt('guardian').toLowerCase();
const LIMIT = Number(opt('limit')) || 0;

/**
 * Phải giữ ĐỒNG BỘ với chatController.js:294-299 (`PARENT_PORTAL_EMAIL_SUFFIX`,
 * `parentPortalEmailFromGuardianId`). Cố ý chép lại 3 dòng thay vì `require` controller:
 * controller kéo theo frappeService + redis, không phù hợp cho script CLI một phát.
 */
const PARENT_PORTAL_EMAIL_SUFFIX = '@parent.wellspring.edu.vn';

function normalizeEmail(value) {
  return value ? String(value).trim().toLowerCase() : '';
}

function normalizeId(value) {
  return value ? String(value).trim() : '';
}

function parentPortalEmailFromGuardianId(guardianId) {
  const normalized = normalizeId(guardianId).toLowerCase();
  return normalized ? `${normalized}${PARENT_PORTAL_EMAIL_SUFFIX}` : '';
}

/** "Hỏng" = rỗng, thiếu, hoặc không chứa "@". Khớp đúng định nghĩa của lệnh mongosh đếm. */
function isBrokenEmail(value) {
  return !normalizeEmail(value).includes('@');
}

/**
 * guardian_id của participant hỏng. Ưu tiên field trên chính participant; thiếu thì thử
 * suy từ snapshot `guardians[]` cùng hội thoại (khớp theo email rác giống hệt, hoặc theo
 * tên + studentIds). KHÔNG suy từ email vì email đang là rác.
 */
function resolveGuardianId(participant, conversation) {
  const direct = normalizeId(participant.guardianId).toLowerCase();
  if (direct) return { guardianId: direct, source: 'participant.guardianId' };

  const pEmail = normalizeEmail(participant.email);
  const pName = normalizeId(participant.name).toLowerCase();
  const pStudents = new Set((participant.studentIds || []).map(String));

  const candidates = (conversation.guardians || []).filter((g) => {
    const gid = normalizeId(g.guardianId).toLowerCase();
    if (!gid) return false;
    // Snapshot mang CÙNG giá trị rác (cùng một dòng code ghi ra cả hai) ⇒ khớp mạnh nhất.
    if (pEmail && normalizeEmail(g.email) === pEmail) return true;
    if (!pName) return false;
    if (normalizeId(g.name).toLowerCase() !== pName) return false;
    if (!pStudents.size) return true;
    return (g.studentIds || []).some((s) => pStudents.has(String(s)));
  });

  const unique = [...new Set(candidates.map((g) => normalizeId(g.guardianId).toLowerCase()))];
  if (unique.length === 1) return { guardianId: unique[0], source: 'guardians[] snapshot' };
  return { guardianId: '', source: unique.length > 1 ? 'ambiguous snapshot' : 'none' };
}

async function connectDB() {
  await mongoose.connect(MONGODB_URI);
  console.log(`✅ MongoDB connected — ${MONGODB_URI.replace(/\/\/[^@]*@/, '//***@')}`);
}

async function main() {
  console.log(`\n🔍 Backfill portal email cho participants — chế độ: ${APPLY ? 'APPLY (ghi DB)' : 'DRY-RUN (chỉ in)'}`);
  if (MERGE_DUPES) console.log('   ↳ --merge-duplicates: bản hỏng trùng người sẽ được SOFT-REMOVE (không xoá)');

  const filter = { participants: { $elemMatch: { email: { $not: /@/ } } } };
  if (ONLY_CONVERSATION) filter._id = new mongoose.Types.ObjectId(ONLY_CONVERSATION);
  if (ONLY_GUARDIAN) filter['participants.guardianId'] = ONLY_GUARDIAN;

  let query = ChatConversation.find(filter)
    .select('_id type classId className schoolYearId participants guardians')
    .lean();
  if (LIMIT) query = query.limit(LIMIT);
  const conversations = await query;

  console.log(`   ↳ ${conversations.length} hội thoại có ít nhất 1 participant email hỏng\n`);
  if (!conversations.length) return { conversations: 0 };

  // ===== PASS 1: gom candidate, phân loại.
  const candidates = [];
  const stats = {
    conversations: conversations.length,
    brokenRows: 0,
    teacherSkipped: 0,
    noGuardianId: 0,
    fixable: 0,
    duplicateTwin: 0,
    fixed: 0,
    userLinked: 0,
    snapshotsFixed: 0,
    softRemoved: 0,
    noMongoUser: 0,
  };
  const orphans = [];

  for (const conv of conversations) {
    for (const p of conv.participants || []) {
      if (!isBrokenEmail(p.email)) continue;
      stats.brokenRows += 1;

      if (p.role !== 'guardian') {
        // GV không có email portal suy ra được — email GV là tài khoản Frappe thật.
        stats.teacherSkipped += 1;
        orphans.push({
          conversationId: String(conv._id),
          classId: conv.classId,
          reason: 'TEACHER_INVALID_EMAIL',
          role: p.role,
          email: p.email || '(rỗng)',
          teacherId: p.teacherId || '',
          name: p.name || '',
        });
        continue;
      }

      const { guardianId, source } = resolveGuardianId(p, conv);
      if (!guardianId) {
        stats.noGuardianId += 1;
        orphans.push({
          conversationId: String(conv._id),
          classId: conv.classId,
          reason: 'NO_GUARDIAN_ID',
          detail: source,
          email: p.email || '(rỗng)',
          name: p.name || '',
          user: p.user ? String(p.user) : '',
        });
        continue;
      }

      candidates.push({
        conv,
        participant: p,
        guardianId,
        guardianIdSource: source,
        portalEmail: parentPortalEmailFromGuardianId(guardianId),
      });
    }
  }

  // ===== PASS 2: tra Mongo User một lượt (để gắn `participants[].user` còn thiếu).
  const gids = [...new Set(candidates.map((c) => c.guardianId))];
  const portalEmails = [...new Set(candidates.map((c) => c.portalEmail))];
  const users = gids.length
    ? await User.find({
      $or: [
        { guardian_id: { $in: gids } },
        { email: { $in: portalEmails } },
      ],
    }).select('_id email guardian_id fullname active').lean()
    : [];
  const userByGid = new Map();
  const userByEmail = new Map();
  for (const u of users) {
    const gid = normalizeId(u.guardian_id).toLowerCase();
    if (gid) userByGid.set(gid, u);
    const em = normalizeEmail(u.email);
    if (em) userByEmail.set(em, u);
  }

  // ===== PASS 3: áp.
  for (const c of candidates) {
    const { conv, participant, guardianId, portalEmail } = c;
    const mongoUser = userByGid.get(guardianId) || userByEmail.get(portalEmail) || null;
    // Email đích: ưu tiên email THẬT của tài khoản Mongo (nguồn sự thật cho push),
    // fallback về địa chỉ suy ra — công thức deterministic mà ERP dùng để tạo account PH.
    const targetEmail = normalizeEmail(mongoUser?.email) || portalEmail;
    if (!mongoUser) stats.noMongoUser += 1;

    // Đã có participant ĐÚNG của cùng người trong hội thoại? Sửa nữa ⇒ 2 dòng trùng email.
    const twin = (conv.participants || []).find((other) => (
      other !== participant
      && other.role === 'guardian'
      && !other.removedAt
      && (
        normalizeEmail(other.email) === targetEmail
        || (mongoUser && other.user && String(other.user) === String(mongoUser._id))
      )
    ));

    if (twin) {
      stats.duplicateTwin += 1;
      orphans.push({
        conversationId: String(conv._id),
        classId: conv.classId,
        reason: MERGE_DUPES ? 'DUPLICATE_TWIN_SOFT_REMOVED' : 'DUPLICATE_TWIN_SKIPPED',
        guardianId,
        brokenEmail: participant.email || '(rỗng)',
        keptEmail: normalizeEmail(twin.email),
      });
      if (!MERGE_DUPES) continue;

      if (VERBOSE || !APPLY) {
        console.log(`   [dupe] ${conv.classId} ${String(conv._id)} — soft-remove bản hỏng "${participant.email || ''}" (giữ ${twin.email})`);
      }
      if (APPLY) {
        const res = await ChatConversation.updateOne(
          { _id: conv._id },
          {
            $set: {
              'participants.$[p].removedAt': new Date(),
              'participants.$[p].removedReason': 'email_backfill_dupe',
            },
          },
          {
            arrayFilters: [{
              'p.guardianId': guardianId,
              'p.email': { $not: /@/ },
              'p.removedAt': null,
            }],
          },
        );
        if (res.modifiedCount) stats.softRemoved += 1;
      }
      continue;
    }

    stats.fixable += 1;
    // Chỉ gắn `user` khi chưa ai trong hội thoại giữ user đó — tránh tạo 2 participant
    // cùng `participantIdentityKey` (`guardian|user:<id>`).
    const userTaken = mongoUser && (conv.participants || []).some(
      (other) => other !== participant && other.user && String(other.user) === String(mongoUser._id),
    );
    const shouldLinkUser = Boolean(mongoUser) && !participant.user && !userTaken;

    if (VERBOSE || !APPLY) {
      console.log(
        `   [fix] ${conv.classId || '-'} ${String(conv._id)} | gid=${guardianId} (${c.guardianIdSource})`
        + ` | email "${participant.email || '(rỗng)'}" → "${targetEmail}"`
        + ` | user ${participant.user ? String(participant.user) : (shouldLinkUser ? `→ ${String(mongoUser._id)}` : '(không tìm thấy account Mongo)')}`,
      );
    }

    if (!APPLY) continue;

    const set = { 'participants.$[p].email': targetEmail };
    if (shouldLinkUser) set['participants.$[p].user'] = mongoUser._id;

    const res = await ChatConversation.updateOne(
      { _id: conv._id },
      { $set: set },
      {
        // Điều kiện "email chưa chứa @" nằm TRONG arrayFilters ⇒ lệnh tự no-op nếu
        // dữ liệu đã được sửa (chạy lại / app ghi xen kẽ). Đây là chốt idempotent.
        arrayFilters: [{ 'p.guardianId': guardianId, 'p.email': { $not: /@/ } }],
      },
    );
    if (res.modifiedCount) {
      stats.fixed += 1;
      if (shouldLinkUser) stats.userLinked += 1;
    }

    // Snapshot `guardians[].email` là email ĐỊNH DANH (khớp participant) — cùng nguồn hỏng.
    // `guardianSnapshotKey` ưu tiên `guardianId` nên sửa email KHÔNG làm đổi khoá merge.
    const snapRes = await ChatConversation.updateOne(
      { _id: conv._id },
      { $set: { 'guardians.$[g].email': targetEmail } },
      { arrayFilters: [{ 'g.guardianId': guardianId, 'g.email': { $not: /@/ } }] },
    );
    if (snapRes.modifiedCount) stats.snapshotsFixed += 1;
  }

  // ===== BÁO CÁO
  console.log('\n📊 Tổng kết');
  console.log(`   Hội thoại quét:                 ${stats.conversations}`);
  console.log(`   Dòng participant email hỏng:    ${stats.brokenRows}`);
  console.log(`   ├─ role teacher (BỎ QUA):       ${stats.teacherSkipped}`);
  console.log(`   ├─ không suy được guardian_id:  ${stats.noGuardianId}`);
  console.log(`   ├─ đã có bản đúng (trùng):      ${stats.duplicateTwin}`);
  console.log(`   └─ sửa được:                    ${stats.fixable}`);
  console.log(`   ├─ trong đó KHÔNG có account Mongo (dùng email suy ra): ${stats.noMongoUser}`);
  if (APPLY) {
    console.log(`   ✍️  participants[].email đã ghi: ${stats.fixed}`);
    console.log(`   ✍️  participants[].user gắn thêm: ${stats.userLinked}`);
    console.log(`   ✍️  guardians[].email đã ghi:    ${stats.snapshotsFixed}`);
    console.log(`   ✍️  bản trùng soft-remove:       ${stats.softRemoved}`);
  } else {
    console.log('   (DRY-RUN — chưa ghi gì. Thêm --apply để ghi.)');
  }

  if (orphans.length) {
    console.log(`\n⚠️  ${orphans.length} dòng KHÔNG tự chữa được — cần xử lý tay:`);
    for (const o of orphans.slice(0, 50)) console.log('   ' + JSON.stringify(o));
    if (orphans.length > 50) console.log(`   … và ${orphans.length - 50} dòng nữa`);
    console.log(
      '\n   NO_GUARDIAN_ID: KHÔNG suy ngược được từ email rác. Đường đi đúng:\n'
      + '     1) Vá 3 chỗ `g.email || g.portalEmail` (chatController.js:709/825,\n'
      + '        chatMembershipSync.js:61) thành `oneEmail(g.portalEmail) || oneEmail(g.email)`.\n'
      + '     2) Chạy lại sync membership (dry-run trước):\n'
      + '        CHAT_SYNC_DRY_RUN=1 node scripts/sync-chat-memberships-cron.js\n'
      + '        node scripts/sync-chat-memberships-cron.js\n'
      + '        → sync THÊM participant đúng (có `user` + portal email) từ roster Frappe.\n'
      + '     3) Chạy lại script này với --merge-duplicates để soft-remove bản hỏng còn lại.\n'
      + '     Thứ tự bắt buộc: chưa vá code mà chạy sync ⇒ ghi lại đúng giá trị rác.',
    );
  }

  return stats;
}

(async () => {
  await connectDB();
  try {
    await main();
  } catch (err) {
    console.error('❌ Lỗi:', err);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    console.log('\n👋 Đã ngắt kết nối MongoDB');
  }
})();
