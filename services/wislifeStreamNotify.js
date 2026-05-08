/**
 * Wislife → Redis Stream dạng `notify.send` (khớp notification-service Phase 3).
 * Bật SOCIAL_WISLIFE_TRANSPORT=stream để bỏ hop Frappe cho các event đã có email người nhận rõ ràng.
 */
const { publishEnvelope } = require('../utils/eventBus');

function normalizeName(name) {
  const s = String(name || '').trim();
  return s || 'Ai đó';
}

/** classId/studentIds — đồng bộ với ERP _wislife_extra_fields. */
function wislifeExtras(d) {
  if (!d || typeof d !== 'object') return {};
  const out = {};
  const cid = d.classId != null ? String(d.classId).trim() : d.class_id != null ? String(d.class_id).trim() : '';
  if (cid) {
    out.classId = cid;
    out.class_id = cid;
  }
  const sid = d.studentId != null ? String(d.studentId).trim() : d.student_id != null ? String(d.student_id).trim() : '';
  if (sid) {
    out.studentId = sid;
    out.student_id = sid;
  }
  if (Array.isArray(d.participantStudentIds) && d.participantStudentIds.length) {
    const cleaned = [...new Set(d.participantStudentIds.map((x) => String(x).trim()).filter(Boolean))];
    if (cleaned.length) out.participantStudentIds = cleaned;
  }
  return out;
}

function normalizeEmails(list) {
  const seen = new Set();
  const out = [];
  for (const raw of list || []) {
    const e = String(raw || '').trim().toLowerCase();
    if (!e || !e.includes('@')) continue;
    if (seen.has(e)) continue;
    seen.add(e);
    out.push(e);
  }
  return out;
}

/**
 * @returns {{ recipients: string[], title: string, body: string, data: Record<string, unknown>, notificationBodyKey: string } | null}
 */
function buildParts(eventType, eventData) {
  const d = eventData || {};
  const extras = wislifeExtras(d);
  const userLabel = normalizeName(d.userName);
  const postId = d.postId != null ? String(d.postId) : '';
  const commentId = d.commentId != null ? String(d.commentId) : '';

  switch (eventType) {
    case 'post_reacted': {
      const recipientEmail = d.recipientEmail;
      const emails = normalizeEmails([recipientEmail]);
      if (!emails.length) return null;
      const notification_message = `${userLabel} đã bày tỏ cảm xúc về bài viết của bạn`;
      return {
        recipients: emails,
        title: 'Wislife',
        body: notification_message,
        notificationBodyKey: notification_message,
        data: {
          type: 'wislife_post_reaction',
          postId,
          action: 'open_post',
          actorName: userLabel,
          reactionType: d.reactionType,
          ...extras,
        },
      };
    }
    case 'post_commented': {
      const emails = normalizeEmails([d.recipientEmail]);
      if (!emails.length) return null;
      const notification_message = `${userLabel} đã bình luận bài viết của bạn`;
      return {
        recipients: emails,
        title: 'Wislife',
        body: notification_message,
        notificationBodyKey: notification_message,
        data: {
          type: 'wislife_post_comment',
          postId,
          action: 'open_post',
          actorName: userLabel,
          ...extras,
        },
      };
    }
    case 'comment_reacted': {
      const emails = normalizeEmails([d.recipientEmail]);
      if (!emails.length) return null;
      const notification_message = `${userLabel} đã bày tỏ cảm xúc về bình luận của bạn`;
      return {
        recipients: emails,
        title: 'Wislife',
        body: notification_message,
        notificationBodyKey: notification_message,
        data: {
          type: 'wislife_comment_reaction',
          postId,
          commentId,
          action: 'open_post',
          actorName: userLabel,
          reactionType: d.reactionType,
          ...extras,
        },
      };
    }
    case 'comment_replied': {
      const emails = normalizeEmails([d.recipientEmail]);
      if (!emails.length) return null;
      const notification_message = `${userLabel} đã trả lời bình luận của bạn`;
      return {
        recipients: emails,
        title: 'Wislife',
        body: notification_message,
        notificationBodyKey: notification_message,
        data: {
          type: 'wislife_comment_reply',
          postId,
          commentId,
          action: 'open_post',
          actorName: userLabel,
          ...extras,
        },
      };
    }
    case 'post_mention': {
      const emails = normalizeEmails(d.mentionedEmails);
      if (!emails.length) return null;
      const notification_message = `${userLabel} đã nhắc đến bạn trong một bình luận`;
      return {
        recipients: emails,
        title: 'Wislife',
        body: notification_message,
        notificationBodyKey: notification_message,
        data: {
          type: 'wislife_mention',
          postId,
          commentId,
          action: 'open_post',
          actorName: userLabel,
          ...extras,
        },
      };
    }
    case 'post_tagged': {
      const emails = normalizeEmails(d.recipientEmails);
      if (!emails.length) return null;
      const authorName = normalizeName(d.authorName);
      const notification_message = `${authorName} đã tag bạn trong một bài viết`;
      return {
        recipients: emails,
        title: 'Wislife',
        body: notification_message,
        notificationBodyKey: notification_message,
        data: {
          type: 'wislife_post_tagged',
          postId,
          action: 'open_post',
          actorName: authorName,
          ...extras,
        },
      };
    }
    default:
      return null;
  }
}

/**
 * @param {import('redis').RedisClientType} pubClient
 * @param {string} eventType
 * @param {Record<string, unknown>} eventData
 * @returns {Promise<boolean>} true nếu đã XADD/PUBLISH envelope hợp lệ
 */
async function publishWislifeNotifyStream(pubClient, eventType, eventData) {
  const parts = buildParts(eventType, eventData);
  if (!parts) return false;
  if (!pubClient?.isOpen) {
    console.warn('[WislifeStream] pubClient chưa mở — bỏ qua');
    return false;
  }

  const channel = process.env.REDIS_NOTIFICATION_CHANNEL || 'notification-service';
  const envelope = {
    service: 'social-service',
    event: eventType,
    kind: 'notify.send',
    deliverFromStream: true,
    deliver: true,
    recipients: parts.recipients,
    title: parts.title,
    body: parts.body,
    type: 'wislife',
    notification_type: eventType,
    channel: 'push',
    data: parts.data,
  };

  await publishEnvelope(pubClient, channel, envelope);
  console.log(
    `[WislifeStream] notify.send ${eventType} → ${parts.recipients.length} email qua kênh ${channel} (stream events:${channel})`,
  );
  return true;
}

module.exports = { publishWislifeNotifyStream, buildParts };
