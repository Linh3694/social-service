/**
 * Chat / Trò chuyện → Redis Stream `notify.send` (notification-service).
 */
const { publishEnvelope } = require('../utils/eventBus');
const { formatVietnameseName } = require('../utils/nameUtils');

/**
 * Tên người gửi trong body push — chuẩn hoá Họ Đệm Tên, CHỈ với GV/CBNV.
 *
 * Body do đây soạn rồi gửi nguyên văn ra Expo, client KHÔNG sửa được, nên không chuẩn hoá
 * ở đây là tên đảo hiện thẳng trên thông báo dù trong app vẫn đúng (SIS-170). Ngược lại,
 * tên PHHS do ERP nhập sẵn đúng thứ tự VN nên phải giữ nguyên — đảo lại là làm sai.
 *
 * @param {string} name
 * @param {string} senderRole 'teacher' | 'guardian' (userRole() ở chatController)
 */
function normalizeName(name, senderRole) {
  const s = String(name || '').trim();
  if (!s) return 'Ai đó';
  if (String(senderRole || '').trim() === 'guardian') return s;
  return formatVietnameseName(s) || s;
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
  const senderName = normalizeName(d.senderName, d.senderRole);
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
        title: 'Trò chuyện',
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
          // 'text' | 'poll' — client phân biệt tin bình chọn. Giữ nguyên `type` để không
          // rơi khỏi kênh Android "chat" (map ở erp/api/erp_sis/mobile_push_notification.py).
          messageKind: d.messageKind || 'text',
          timestamp: d.timestamp,
        },
      };
    }
    case 'message_reaction': {
      const body = `${senderName} đã thả cảm xúc về tin nhắn`;
      return {
        recipients: emails,
        title: 'Trò chuyện',
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
    case 'poll_reminder': {
      const question = String(d.messagePreview || '').trim().slice(0, 100);
      return {
        recipients: emails,
        title: 'Bình chọn',
        body: question
          ? `Sắp hết hạn: "${question}" — bạn chưa bình chọn`
          : 'Một bình chọn sắp hết hạn — bạn chưa bình chọn',
        data: {
          type: 'chat_poll_reminder',
          action: 'open_chat',
          conversationId,
          conversationType,
          messageId,
          messageKind: 'poll',
          timestamp: d.timestamp,
        },
      };
    }
    case 'poll_closed': {
      const question = String(d.messagePreview || '').trim().slice(0, 100);
      return {
        recipients: emails,
        title: 'Bình chọn',
        body: question ? `Đã kết thúc: "${question}"` : 'Một bình chọn đã kết thúc',
        data: {
          type: 'chat_poll_closed',
          action: 'open_chat',
          conversationId,
          conversationType,
          messageId,
          messageKind: 'poll',
          timestamp: d.timestamp,
        },
      };
    }
    case 'message_recalled': {
      const body = `${senderName} đã thu hồi một tin nhắn`;
      return {
        recipients: emails,
        title: 'Trò chuyện',
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
