/**
 * Xác thực service-to-service bằng cặp FRAPPE_API_KEY/FRAPPE_API_SECRET.
 *
 * Dùng cho các endpoint admin do cron gọi (không có user nào đứng sau nên không có JWT).
 * So khớp đúng nguyên văn header, không parse lỏng.
 */
function isServiceKeyAuthorized(req) {
  const key = process.env.FRAPPE_API_KEY;
  const secret = process.env.FRAPPE_API_SECRET;
  if (!key || !secret) return false;
  const header = String(req?.headers?.authorization || '').trim();
  return header === `token ${key}:${secret}`;
}

module.exports = { isServiceKeyAuthorized };
