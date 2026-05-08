/**
 * Điều phối gửi notify cho social-service.
 *
 * SOCIAL_NOTIFY_TRANSPORT:
 *   - frappe           (mặc định an toàn): chỉ POST Frappe webhook handle_wislife_event / handle_chat_event như cũ.
 *   - dual             : POST Frappe (fire-and-forget) + đồng thời gửi notification-service (stream/HTTP).
 *   - stream           : chỉ XADD Redis stream notify.send (notification-service consumer).
 *   - http             : chỉ POST notification-service /api/notifications/send.
 *   - stream_then_http : ưu tiên stream, fallback HTTP.
 */
const axios = require('axios');
const redis = require('../config/redis');
const { buildParts, publishWislifeNotifyStream } = require('./wislifeStreamNotify');
const { buildChatParts, publishChatNotifyStream } = require('./chatStreamNotify');
const { sendToFrappeLegacy } = require('./frappeLegacyNotify');
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
 * Resolve recipients cho notification-service (chỉ dùng khi kind=wislife).
 * Token được dùng nội bộ (không gửi qua envelope).
 * @param {string} eventType
 * @param {Record<string, unknown>} eventData
 * @param {string} bearerToken
 */
async function enrichWislifeEventDataWithToken(eventType, eventData, bearerToken) {
  const d = eventData && typeof eventData === 'object' ? { ...eventData } : {};
  if (eventType === 'new_class_post') {
    const list = await resolveClassRecipients(d.classId, d.schoolYearId, bearerToken);
    d.recipientEmails = filterOutAuthor(list, d.authorEmail);
  } else if (eventType === 'new_post_broadcast') {
    const list = await resolveSchoolWideRecipients(bearerToken);
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
 * Gửi qua notification-service (stream ưu tiên, fallback HTTP nếu transport=stream_then_http).
 * @param {'wislife'|'chat'} kind
 * @param {string} eventType
 * @param {Record<string, unknown>} data
 * @param {string} transport
 */
async function sendToNotificationService(kind, eventType, data, transport) {
  // 'dual' = song song Frappe + notification-service: dùng cùng chiến lược "stream rồi fallback HTTP".
  const wantStream = transport.startsWith('stream') || transport === 'dual';
  const wantHttpFallback =
    transport === 'http' || transport === 'stream_then_http' || transport === 'dual';

  if (wantStream) {
    try {
      const pub = redis.getPubClient();
      if (pub?.isOpen) {
        const ok =
          kind === 'chat'
            ? await publishChatNotifyStream(pub, eventType, data)
            : await publishWislifeNotifyStream(pub, eventType, data);
        if (ok) return { success: true, via: 'stream' };
      } else {
        console.warn('[Notify] Redis pub chưa mở');
      }
    } catch (e) {
      console.warn('[Notify] Stream lỗi:', e?.message || e);
    }

    if (transport === 'stream') {
      return { success: false, reason: 'stream_failed_or_empty' };
    }
  }

  if (wantHttpFallback) {
    return sendViaHttp(kind, eventType, data);
  }

  return { success: false, reason: 'unknown_transport' };
}

/**
 * @param {{ kind: 'wislife'|'chat', eventType: string, eventData?: Record<string, unknown> }} args
 * @returns {Promise<{ success: boolean, via?: string, reason?: string, message?: unknown }>}
 */
async function dispatch({ kind, eventType, eventData }) {
  const original = eventData && typeof eventData === 'object' ? { ...eventData } : {};
  // Tách token cho social nội bộ — không leak ra Frappe webhook hay notification-service envelope.
  const tok = typeof original.authorToken === 'string' ? original.authorToken : '';
  delete original.authorToken;

  const transport = String(process.env.SOCIAL_NOTIFY_TRANSPORT || 'frappe')
    .toLowerCase()
    .trim();

  // Mode 'frappe': revert hành vi cũ — chỉ gọi Frappe webhook (Frappe tự fan-out / push).
  if (transport === 'frappe') {
    return sendToFrappeLegacy(kind, eventType, original);
  }

  // Mode 'dual': song song Frappe + notification-service (an toàn cho giai đoạn migration).
  if (transport === 'dual') {
    sendToFrappeLegacy(kind, eventType, original).catch((e) => {
      console.warn('[Notify] Frappe legacy lỗi:', e?.message || e);
    });
  }

  // Tới đây: stream | http | stream_then_http | dual → cần resolve thêm cho 2 case Wislife.
  let data = { ...original };
  if (kind === 'wislife') {
    data = await enrichWislifeEventDataWithToken(eventType, data, tok);
    if (eventType === 'new_class_post' || eventType === 'new_post_broadcast') {
      const n = Array.isArray(data.recipientEmails) ? data.recipientEmails.length : 0;
      if (n === 0) {
        console.warn(`[Notify] ${eventType}: 0 recipient — bỏ qua notification-service`);
        return transport === 'dual'
          ? { success: true, via: 'frappe-only' }
          : { success: false, reason: 'no_recipients' };
      }
      console.log(`[Notify] ${eventType}: resolve ${n} người nhận cho notification-service`);
    }
  }

  const nsResult = await sendToNotificationService(kind, eventType, data, transport);
  if (transport === 'dual') {
    // Trong dual mode, Frappe đã fire-and-forget — kết quả tổng vẫn coi là thành công nếu NS OK.
    return nsResult.success ? nsResult : { success: true, via: 'frappe-only', message: nsResult };
  }
  return nsResult;
}

module.exports = {
  dispatch,
  enrichWislifeEventData: enrichWislifeEventDataWithToken,
};
