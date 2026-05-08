/**
 * Điều phối gửi notify: ưu tiên Redis Stream notify.send, fallback HTTP notification-service.
 */
const axios = require('axios');
const redis = require('../config/redis');
const { buildParts, publishWislifeNotifyStream } = require('./wislifeStreamNotify');
const { buildChatParts, publishChatNotifyStream } = require('./chatStreamNotify');
const {
  resolveClassRecipients,
  resolveSchoolWideRecipients,
  oneEmail,
} = require('../utils/recipientResolver');

/** Loại email tác giả khỏi danh sách (tránh tự notify). */
function filterOutAuthor(recipientEmails, authorEmail) {
  const a = oneEmail(authorEmail);
  if (!a || !Array.isArray(recipientEmails)) return recipientEmails || [];
  return recipientEmails.filter((e) => oneEmail(e) !== a);
}

/**
 * @param {string} eventType
 * @param {Record<string, unknown>} eventData
 * @returns {Promise<Record<string, unknown>>}
 */
async function enrichWislifeEventData(eventType, eventData) {
  const d = eventData && typeof eventData === 'object' ? { ...eventData } : {};
  // Token chỉ dùng nội bộ social để gọi Frappe; KHÔNG gửi qua envelope ra notification-service.
  const tok = typeof d.authorToken === 'string' ? d.authorToken : '';
  delete d.authorToken;
  if (eventType === 'new_class_post') {
    const list = await resolveClassRecipients(d.classId, d.schoolYearId, tok);
    d.recipientEmails = filterOutAuthor(list, d.authorEmail);
  } else if (eventType === 'new_post_broadcast') {
    const list = await resolveSchoolWideRecipients(tok);
    d.recipientEmails = filterOutAuthor(list, d.authorEmail);
  }
  return d;
}

/**
 * @param {'wislife'|'chat'} kind
 * @param {string} eventType
 * @param {Record<string, unknown>} eventData
 */
async function sendViaHttp(kind, eventType, eventData) {
  const parts =
    kind === 'chat'
      ? buildChatParts(eventType, eventData)
      : buildParts(eventType, eventData);

  if (!parts || !parts.recipients?.length) {
    console.warn('[Notify] HTTP bỏ qua — không build được payload:', eventType);
    return { success: false, reason: 'no_parts' };
  }

  const base = (process.env.NOTIFICATION_SERVICE_URL || '').replace(/\/$/, '');
  if (!base) {
    console.error('[Notify] NOTIFICATION_SERVICE_URL chưa cấu hình');
    return { success: false, reason: 'no_notification_url' };
  }

  const secret = (process.env.INTERNAL_SERVICE_SECRET || '').trim();
  const url = `${base}/api/notifications/send`;
  const payload = {
    recipients: parts.recipients,
    title: parts.title,
    body: parts.body,
    type: kind === 'chat' ? 'chat' : 'wislife',
    notification_type: eventType,
    channel: 'push',
    data: parts.data,
  };

  const MAX_RETRIES = 2;
  const TIMEOUT_MS = 15000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      /** @type {Record<string, string>} */
      const headers = {
        'Content-Type': 'application/json',
        'X-Service-Name': 'social-service',
      };
      if (secret) headers['X-Service-Token'] = secret;

      const response = await axios.post(url, payload, { timeout: TIMEOUT_MS, headers });
      const ok = response.data?.success !== false;
      if (ok) {
        console.log(
          `[Notify] HTTP OK ${eventType} → ${parts.recipients.length} người nhận (lần ${attempt}/${MAX_RETRIES})`,
        );
        return { success: true, via: 'http' };
      }
      console.warn('[Notify] HTTP response không success:', response.data);
      return { success: false, message: response.data };
    } catch (error) {
      const isTimeout =
        error.code === 'ECONNABORTED' || String(error.message || '').includes('timeout');
      console.error(`[Notify] HTTP lỗi (${eventType}) lần ${attempt}:`, error.message);
      if (isTimeout && attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      return { success: false, message: error.message };
    }
  }
  return { success: false, message: 'Max retries exceeded' };
}

/**
 * @param {{ kind: 'wislife'|'chat', eventType: string, eventData?: Record<string, unknown> }} args
 * @returns {Promise<{ success: boolean, via?: string, reason?: string, message?: unknown }>}
 */
async function dispatch({ kind, eventType, eventData }) {
  let data = eventData && typeof eventData === 'object' ? { ...eventData } : {};

  if (kind === 'wislife') {
    data = await enrichWislifeEventData(eventType, data);

    if (eventType === 'new_class_post' || eventType === 'new_post_broadcast') {
      const n = Array.isArray(data.recipientEmails) ? data.recipientEmails.length : 0;
      if (n === 0) {
        console.warn(`[Notify] ${eventType}: không có recipient sau resolve — bỏ qua`);
        return { success: false, reason: 'no_recipients' };
      }
      console.log(`[Notify] ${eventType}: resolve ${n} người nhận`);
    }
  }

  const transport = String(process.env.SOCIAL_NOTIFY_TRANSPORT || 'stream_then_http')
    .toLowerCase()
    .trim();

  if (transport.startsWith('stream')) {
    try {
      const pub = redis.getPubClient();
      if (pub?.isOpen) {
        const ok =
          kind === 'chat'
            ? await publishChatNotifyStream(pub, eventType, data)
            : await publishWislifeNotifyStream(pub, eventType, data);
        if (ok) return { success: true, via: 'stream' };
      } else {
        console.warn('[Notify] Redis pub chưa mở — sẽ thử HTTP nếu stream_then_http');
      }
    } catch (e) {
      console.warn('[Notify] Stream lỗi:', e?.message || e);
    }

    if (transport === 'stream') {
      return { success: false, reason: 'stream_failed_or_empty' };
    }
  }

  if (transport === 'http' || transport === 'stream_then_http') {
    return sendViaHttp(kind, eventType, data);
  }

  return { success: false, reason: 'unknown_transport' };
}

module.exports = {
  dispatch,
  enrichWislifeEventData,
};
