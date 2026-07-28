/**
 * Lịch vòng đời bình chọn — chạy TRONG tiến trình app (không phải PM2 cron).
 *
 * Hai job, quét mỗi phút:
 *  1. Nhắc trước hạn  → thông báo in-app + push cho thành viên CHƯA bỏ phiếu.
 *  2. Hết hạn         → thông báo cho cả nhóm + broadcast socket để thẻ bình chọn
 *                       chuyển sang "Đã kết thúc" ngay trên máy đang mở.
 *
 * Vì sao chạy in-process thay vì thêm entry vào ecosystem-cron.config.js:
 *  - Job (2) phải phát socket, mà `global.io` chỉ tồn tại trong tiến trình app.
 *  - `ecosystem.config.js` để `instances: 1` nên không có chuyện hai tiến trình cùng chạy;
 *    dù vậy mỗi job vẫn "giành" bằng một update nguyên tử trên chính document, nên có nhân
 *    bản thêm instance sau này cũng không bắn trùng.
 *
 * Bỏ lỡ cửa sổ (service restart / deploy) KHÔNG mất job: truy vấn là `<= now`, không phải
 * một khoảng hẹp — lần quét sau vẫn bắt được. Riêng job nhắc thì bỏ qua nếu poll đã quá hạn,
 * vì nhắc lúc đó không còn ý nghĩa.
 */
const ChatConversation = require('../models/ChatConversation');
const ChatMessage = require('../models/ChatMessage');
const {
  broadcastPollUpdate,
  chatRecipientEmails,
  firePollLifecycleNotify,
  pollPendingVoterEmails,
} = require('../controllers/chatController');

const DEFAULT_INTERVAL_MS = 60 * 1000;
/** Trần mỗi lượt quét — tránh một tick ôm quá nhiều việc. Vượt trần thì log rõ, không nuốt. */
const BATCH_LIMIT = 200;

let timer = null;
/** Chặn hai tick chồng nhau khi Mongo/Frappe chậm. */
let running = false;

function log(...args) {
  console.log('[PollScheduler]', ...args);
}

/** Nạp conversation cho các message poll, gộp 1 truy vấn. */
async function loadConversationsFor(messages) {
  const ids = [...new Set(messages.map((m) => String(m.conversation)))];
  if (!ids.length) return new Map();
  const rows = await ChatConversation.find({ _id: { $in: ids } });
  return new Map(rows.map((c) => [String(c._id), c]));
}

/** Job 1 — nhắc thành viên chưa bỏ phiếu. */
async function runReminderJob(now) {
  const due = await ChatMessage.find({
    isDeleted: false,
    recalledAt: null,
    'poll.remindAt': { $ne: null, $lte: now },
    'poll.remindedAt': null,
    'poll.closedAt': null,
    // Đã quá hạn thì thôi, không nhắc nữa.
    'poll.closesAt': { $gt: now },
  })
    .sort({ 'poll.remindAt': 1 })
    .limit(BATCH_LIMIT);

  if (!due.length) return 0;
  if (due.length === BATCH_LIMIT) {
    log(`nhắc: chạm trần ${BATCH_LIMIT} bản ghi trong một lượt — phần còn lại chờ lượt sau`);
  }

  const conversations = await loadConversationsFor(due);
  let sent = 0;

  for (const message of due) {
    // Giành job: chỉ tiến trình set được remindedAt mới gửi.
    const claimed = await ChatMessage.findOneAndUpdate(
      { _id: message._id, 'poll.remindedAt': null },
      { $set: { 'poll.remindedAt': new Date() } },
      { new: true },
    );
    if (!claimed?.poll) continue;

    const conversation = conversations.get(String(claimed.conversation));
    if (!conversation || conversation.status === 'locked') continue;

    const recipientEmails = pollPendingVoterEmails(conversation, claimed.poll);
    if (!recipientEmails.length) continue;

    firePollLifecycleNotify('poll_reminder', conversation, claimed, { recipientEmails });
    sent += 1;
  }

  if (sent) log(`nhắc: đã gửi cho ${sent} bình chọn`);
  return sent;
}

/** Job 2 — báo bình chọn đã hết hạn. */
async function runCloseJob(now) {
  const due = await ChatMessage.find({
    isDeleted: false,
    recalledAt: null,
    'poll.closesAt': { $ne: null, $lte: now },
    'poll.closeNotifiedAt': null,
  })
    .sort({ 'poll.closesAt': 1 })
    .limit(BATCH_LIMIT);

  if (!due.length) return 0;
  if (due.length === BATCH_LIMIT) {
    log(`hết hạn: chạm trần ${BATCH_LIMIT} bản ghi trong một lượt — phần còn lại chờ lượt sau`);
  }

  const conversations = await loadConversationsFor(due);
  let sent = 0;

  for (const message of due) {
    // Giành job + tăng rev: broadcast mang cùng rev sẽ bị client bỏ qua (applyPollUpdate),
    // nên phải bump thì thẻ bình chọn mới chuyển sang "Đã kết thúc".
    // KHÔNG set closedAt — mốc đó dành riêng cho "kết thúc sớm thủ công".
    const claimed = await ChatMessage.findOneAndUpdate(
      { _id: message._id, 'poll.closeNotifiedAt': null },
      { $set: { 'poll.closeNotifiedAt': new Date() }, $inc: { 'poll.rev': 1 } },
      { new: true },
    );
    if (!claimed?.poll) continue;

    const conversation = conversations.get(String(claimed.conversation));
    if (!conversation) continue;

    await broadcastPollUpdate(conversation, claimed);
    if (conversation.status !== 'locked') {
      firePollLifecycleNotify('poll_closed', conversation, claimed, {
        // Hết hạn tự động: không có người thao tác nên báo cho toàn bộ thành viên.
        recipientEmails: chatRecipientEmails(conversation, ''),
      });
    }
    sent += 1;
  }

  if (sent) log(`hết hạn: đã xử lý ${sent} bình chọn`);
  return sent;
}

async function runPollSchedulerTick() {
  if (running) {
    log('bỏ qua tick — lượt trước còn đang chạy');
    return;
  }
  running = true;
  const now = new Date();
  try {
    await runReminderJob(now);
  } catch (error) {
    console.error('[PollScheduler] lỗi job nhắc:', error);
  }
  try {
    await runCloseJob(now);
  } catch (error) {
    console.error('[PollScheduler] lỗi job hết hạn:', error);
  } finally {
    running = false;
  }
}

function startPollScheduler() {
  if (timer) return timer;
  if (String(process.env.POLL_SCHEDULER_ENABLED || '1') === '0') {
    log('đã tắt qua POLL_SCHEDULER_ENABLED=0');
    return null;
  }
  const intervalMs = Math.max(
    10 * 1000,
    Number(process.env.POLL_SCHEDULER_INTERVAL_MS) || DEFAULT_INTERVAL_MS,
  );
  timer = setInterval(() => {
    void runPollSchedulerTick();
  }, intervalMs);
  // Không giữ tiến trình sống chỉ vì cái timer này.
  if (typeof timer.unref === 'function') timer.unref();
  log(`đã bật — quét mỗi ${Math.round(intervalMs / 1000)}s`);
  return timer;
}

function stopPollScheduler() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

module.exports = { startPollScheduler, stopPollScheduler, runPollSchedulerTick };
