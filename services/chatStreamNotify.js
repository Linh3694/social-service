/**
 * Chat / Trao đổi → Redis Stream `notify.send` (notification-service).
 */
const { publishEnvelope } = require('../utils/eventBus');

function normalizeName(name) {
  const s = String(name || '').trim();
  return s || 'Ai đó';
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
 * @returns {{ recipients: string[], title: string, body: string, data: Record<string, unknown> } | null}
 */
function buildChatParts(eventType, eventData) {
  const d = eventData || {};
  const senderName = normalizeName(d.senderName);
  const conversationId = d.conversationId != null ? String(d.conversationId) : '';
  const messageId = d.messageId != null ? String(d.messageId) : '';
  const conversationType = d.conversationType != null ? String(d.conversationType) : '';
  const emails = normalizeEmails(d.recipientEmails);
  if (!emails.length) return null;

  switch (eventType) {
    case 'new_message': {
      const preview = String(d.messagePreview || '').trim().slice(0, 100);
      const body = preview ? `${senderName}: ${preview}` : `${senderName} đã gửi tin nhắn`;
      return {
        recipients: emails,
        title: 'Trao đổi',
        body,
        data: {
          type: 'chat_new_message',
          action: 'open_chat',
          conversationId,
          conversationType,
          messageId,
          senderName,
          senderRole: d.senderRole,
          hasAttachment: Boolean(d.hasAttachment),
          timestamp: d.timestamp,
        },
      };
    }
    case 'message_reaction': {
      const body = `${senderName} đã thả cảm xúc về tin nhắn`;
      return {
        recipients: emails,
        title: 'Trao đổi',
        body,
        data: {
          type: 'chat_reaction',
          action: 'open_chat',
          conversationId,
          conversationType,
          messageId,
          senderName,
          senderRole: d.senderRole,
          timestamp: d.timestamp,
        },
      };
    }
    case 'message_recalled': {
      const body = `${senderName} đã thu hồi một tin nhắn`;
      return {
        recipients: emails,
        title: 'Trao đổi',
        body,
        data: {
          type: 'chat_message_recalled',
          action: 'open_chat',
          conversationId,
          conversationType,
          messageId,
          senderName,
          senderRole: d.senderRole,
          timestamp: d.timestamp,
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
 * @returns {Promise<boolean>}
 */
async function publishChatNotifyStream(pubClient, eventType, eventData) {
  const parts = buildChatParts(eventType, eventData);
  if (!parts) return false;
  if (!pubClient?.isOpen) {
    console.warn('[ChatStream] pubClient chưa mở — bỏ qua');
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
    type: 'chat',
    notification_type: eventType,
    channel: 'push',
    data: parts.data,
  };

  await publishEnvelope(pubClient, channel, envelope);
  console.log(
    `[ChatStream] notify.send ${eventType} → ${parts.recipients.length} email qua kênh ${channel}`,
  );
  return true;
}

module.exports = { publishChatNotifyStream, buildChatParts };
