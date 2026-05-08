/**
 * Webhook legacy gửi event social → Frappe (handle_wislife_event / handle_chat_event).
 * Chỉ dùng khi SOCIAL_NOTIFY_TRANSPORT = frappe | dual.
 */
const axios = require('axios');

const TIMEOUT_MS = 10000;
const MAX_RETRIES = 2;

async function postFrappeWebhook(method, eventType, eventData) {
  const baseURL = process.env.FRAPPE_API_URL || 'https://admin.sis.wellspring.edu.vn';
  const url = `${baseURL.replace(/\/$/, '')}/api/method/${method}`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await axios.post(
        url,
        { event_type: eventType, event_data: eventData },
        {
          timeout: TIMEOUT_MS,
          headers: {
            'X-Service-Name': 'social-service',
            'X-Request-Source': 'service-to-service',
            'Content-Type': 'application/json',
          },
        },
      );
      if (response.data?.message?.success !== false) {
        console.log(`[FrappeLegacy] ${eventType} → ${method} OK (lần ${attempt}/${MAX_RETRIES})`);
        return { success: true };
      }
      console.warn(`[FrappeLegacy] ${eventType} response không success:`, response.data);
      return { success: false, message: response.data?.message };
    } catch (error) {
      const isTimeout =
        error.code === 'ECONNABORTED' || String(error.message || '').includes('timeout');
      console.error(`[FrappeLegacy] ${eventType} lỗi lần ${attempt}: ${error.message}`);
      if (isTimeout && attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      if (error.response) {
        console.error(`[FrappeLegacy] Response status: ${error.response.status}`);
      }
      return { success: false, message: error.message };
    }
  }
  return { success: false, message: 'Max retries exceeded' };
}

async function sendWislifeToFrappe(eventType, eventData) {
  return postFrappeWebhook('erp.api.notification.wislife.handle_wislife_event', eventType, eventData);
}

async function sendChatToFrappe(eventType, eventData) {
  return postFrappeWebhook('erp.api.notification.exchange.handle_chat_event', eventType, eventData);
}

/**
 * @param {'wislife'|'chat'} kind
 */
async function sendToFrappeLegacy(kind, eventType, eventData) {
  if (kind === 'chat') return sendChatToFrappe(eventType, eventData);
  return sendWislifeToFrappe(eventType, eventData);
}

module.exports = {
  sendWislifeToFrappe,
  sendChatToFrappe,
  sendToFrappeLegacy,
};
