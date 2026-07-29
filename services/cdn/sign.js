/**
 * Ký URL theo ngx_http_secure_link_module.
 *
 * Phải khớp TUYỆT ĐỐI với /etc/nginx/snippets/cdn-securelink.conf trên VM3:
 *
 *   secure_link     $arg_s,$arg_e;
 *   secure_link_md5 "$secure_link_expires$uri <CDN_LINK_SECRET>";
 *
 * ⇒ chuỗi băm = <exp><uri><dấu cách><secret>, md5 nhị phân → base64url.
 * Lệch một ký tự trong CDN_LINK_SECRET ⇒ 403 toàn bộ media.
 *
 * Xem CDN-Design.md §3.1–3.2.
 */

const crypto = require('crypto');
const { config } = require('./config');

const CDN_SCHEME = 'cdn://';

/** Bucket của chat có TTL ngắn hơn hẳn (§3.4) — ảnh học sinh, GV↔PH. */
function profileForPath(objectPath) {
  return objectPath.startsWith('/social-chat/') ? 'chat' : 'default';
}

/**
 * Làm tròn expiry lên mốc cố định (§3.2).
 *
 * Không làm tròn thì mỗi user mở feed một thời điểm khác nhau sẽ nhận URL khác
 * nhau ⇒ cache miss 100%. Làm tròn khiến mọi user trong cùng cửa sổ nhận đúng
 * một URL, mà link rò rỉ vẫn tự chết sau tối đa (window + lifetime).
 */
function expiryFor(profile) {
  const { window, lifetime } = config.sign[profile] || config.sign.default;
  return Math.ceil(Date.now() / 1000 / window) * window + lifetime;
}

function base64url(buf) {
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/**
 * @param {string} objectPath đường dẫn tuyệt đối, ví dụ "/social-posts/2026/07/ab/x.webp"
 * @param {{profile?: 'default'|'chat', expires?: number}} [opts]
 * @returns {string} URL đầy đủ đã ký
 */
function signPath(objectPath, opts = {}) {
  const profile = opts.profile || profileForPath(objectPath);
  const exp = opts.expires || expiryFor(profile);
  const raw = `${exp}${objectPath} ${config.linkSecret}`;
  const sig = base64url(crypto.createHash('md5').update(raw).digest());
  return `${config.publicUrl}${objectPath}?e=${exp}&s=${sig}`;
}

/**
 * Ký một giá trị lấy từ DB.
 *
 * Trả về `null` khi giá trị không phải khoá CDN — người gọi tự quyết định giữ
 * nguyên (fallback legacy) hay bỏ qua.
 *
 * @param {unknown} stored giá trị trong DB, ví dụ "cdn://social-posts/2026/07/ab/x.webp"
 */
function signStored(stored) {
  if (typeof stored !== 'string' || !stored.startsWith(CDN_SCHEME)) return null;
  const key = stored.slice(CDN_SCHEME.length).replace(/^\/+/, '');
  if (!key) return null;
  return signPath(`/${key}`);
}

module.exports = { signPath, signStored, profileForPath, expiryFor, CDN_SCHEME };
