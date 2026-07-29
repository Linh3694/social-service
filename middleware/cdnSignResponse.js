/**
 * Ký media cho MỌI response REST tại một chỗ duy nhất.
 *
 * Vì sao bọc `res.json` thay vì ký trong từng controller: social-service có
 * nhiều nhánh trả bài viết khác nhau (populatePostQuery, populateFeedListQuery,
 * populateFeedBodiesQuery, hydrateFeedPostsAuthorsFromSnapshot…). Ký rải rác
 * chắc chắn sẽ sót một nhánh, và triệu chứng là ảnh vỡ ở đúng một màn hình —
 * rất khó truy vết. Bọc ở ranh giới response thì không nhánh nào lọt.
 *
 * Xem CDN-Design.md §6.4.
 */

const { config } = require('../services/cdn/config');
const { signMediaDeep } = require('../services/cdn/signDeep');

function cdnSignResponse(req, res, next) {
  if (!config.enabled) return next();

  const originalJson = res.json.bind(res);
  res.json = (body) => originalJson(signMediaDeep(body));
  next();
}

module.exports = cdnSignResponse;
