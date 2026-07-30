/**
 * Rút gọn error trước khi ghi log — KHÔNG kèm credential.
 *
 * `console.error('...', error)` với một AxiosError sẽ in cả `config.headers` và
 * `request._header`, tức lộ nguyên văn `Authorization: token <api key>:<secret>`, Bearer JWT và
 * `X-Parent-Portal-Token` (mỗi stack lộ 3-4 lần). Ai đọc được file log PM2 là có luôn key gọi
 * API prod. Hàm này giữ đúng phần cần để chẩn đoán — status, method, url, mã lỗi, thông điệp
 * Frappe, stack — và bỏ toàn bộ header, cookie, body request.
 *
 * Dùng: `console.error('[Chat] listConversations error:', describeError(error))`
 */

/** Số frame stack giữ lại — đủ thấy chuỗi gọi mà không ngập log. */
const STACK_FRAMES = 8;

/** Độ dài tối đa của response body dạng chuỗi (vd trang HTML 502 của nginx). */
const BODY_MAX = 300;

function trimStack(stack) {
  if (typeof stack !== 'string') return undefined;
  const lines = stack.split('\n').filter((line) => line.trim().startsWith('at '));
  if (!lines.length) return undefined;
  const kept = lines.slice(0, STACK_FRAMES).map((line) => line.trim());
  if (lines.length > STACK_FRAMES) kept.push(`… +${lines.length - STACK_FRAMES} frame`);
  return kept;
}

/**
 * Frappe trả `_server_messages` là chuỗi JSON của mảng chuỗi JSON — bóc ra cho đọc được.
 * Chính field này nói rõ doctype/user bị chặn quyền, nên phải giữ.
 */
function parseServerMessages(raw) {
  if (typeof raw !== 'string') return undefined;
  try {
    const outer = JSON.parse(raw);
    if (!Array.isArray(outer)) return undefined;
    return outer
      .map((entry) => {
        try {
          const parsed = JSON.parse(entry);
          return parsed?.message || entry;
        } catch {
          return entry;
        }
      })
      .map((message) => String(message).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
  } catch {
    return undefined;
  }
}

/** Chỉ lấy các field an toàn từ response body. Không đổ nguyên body ra log. */
function describeResponseBody(data) {
  if (data == null) return undefined;
  if (typeof data === 'string') {
    const trimmed = data.trim();
    if (!trimmed) return undefined;
    return trimmed.length > BODY_MAX ? `${trimmed.slice(0, BODY_MAX)}…` : trimmed;
  }
  if (typeof data !== 'object') return String(data);

  const out = {};
  if (data.exception) out.exception = data.exception;
  if (data.exc_type && data.exc_type !== data.exception) out.exc_type = data.exc_type;
  if (typeof data.message === 'string') out.message = data.message;
  const serverMessages = parseServerMessages(data._server_messages);
  if (serverMessages?.length) out.serverMessages = serverMessages;
  // `exc` là traceback Python rất dài và trùng thông tin với `exception` ⇒ chỉ đánh dấu là có.
  if (data.exc && !out.exception) out.hasTraceback = true;
  return Object.keys(out).length ? out : undefined;
}

function fullUrl(config) {
  if (!config) return undefined;
  const base = config.baseURL || '';
  const path = config.url || '';
  if (!base && !path) return undefined;
  if (!base) return path;
  if (/^https?:\/\//i.test(path)) return path;
  return `${String(base).replace(/\/+$/, '')}${path.startsWith('/') ? '' : '/'}${path}`;
}

/**
 * @param {unknown} error
 * @returns {Object} object phẳng, an toàn để đưa vào console.*
 */
function describeError(error) {
  if (error == null) return { message: String(error) };
  if (typeof error !== 'object') return { message: String(error) };

  const out = {};
  if (error.name && error.name !== 'Error') out.name = error.name;
  if (error.message) out.message = error.message;
  if (error.code) out.code = error.code;
  if (error.statusCode) out.statusCode = error.statusCode;

  const config = error.config;
  if (config) {
    if (config.method) out.method = String(config.method).toUpperCase();
    const url = fullUrl(config);
    if (url) out.url = url;
  }

  const response = error.response;
  if (response) {
    out.status = response.status;
    if (response.statusText) out.statusText = response.statusText;
    const body = describeResponseBody(response.data);
    if (body !== undefined) out.responseBody = body;
  }

  const stack = trimStack(error.stack);
  if (stack) out.stack = stack;

  if (!Object.keys(out).length) out.message = 'Unknown error';
  return out;
}

module.exports = { describeError };
