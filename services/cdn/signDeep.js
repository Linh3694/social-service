/**
 * signMediaDeep — điểm ký DUY NHẤT cho mọi payload đi ra ngoài.
 *
 * CDN-Design.md §6.4 cảnh báo cạm bẫy hay gặp nhất: ký ở REST nhưng quên ký ở
 * socket ⇒ ảnh hiện đúng khi F5 nhưng vỡ khi tin nhắn đến realtime. Vì vậy chỉ
 * có MỘT hàm này, gọi ở cả 3 nơi: middleware REST, chatBroadcastRooms,
 * newfeedSocket.
 *
 * Ký theo GIÁ TRỊ chứ không theo tên field, nên các đường mới (lastMessage,
 * reply quote, authorSnapshot.avatarUrl, poll…) tự động được phủ mà không phải
 * nhớ khai báo thêm.
 */

const { config } = require('./config');
const { signPath } = require('./sign');
const { toObjectPath } = require('./resolve');

// Payload chat/feed lồng nhau khá sâu (message → replyTo → sender → snapshot).
// Giới hạn để một cấu trúc vòng bất ngờ không làm treo event loop.
const MAX_DEPTH = 12;

function signValue(value) {
  const path = toObjectPath(value);
  return path ? signPath(path) : null;
}

/**
 * Duyệt payload, thay giá trị media bằng URL đã ký.
 *
 * Dùng structural sharing: nhánh nào không có media thì trả về đúng tham chiếu
 * cũ, không clone. Feed lớn nhờ vậy không bị nhân đôi chi phí GC.
 */
function transform(node, depth) {
  if (depth > MAX_DEPTH || node == null) return node;

  if (typeof node === 'string') {
    return signValue(node) || node;
  }

  if (typeof node !== 'object') return node;

  // Mongoose document / subdocument → chuyển sang plain trước khi duyệt.
  // res.json() cũng sẽ gọi toJSON, nên làm sớm không đổi kết quả cuối.
  if (typeof node.toJSON === 'function' && !Array.isArray(node)) {
    const plain = node.toJSON();
    // Date, ObjectId… có toJSON trả primitive — không duyệt tiếp
    if (plain === null || typeof plain !== 'object') return plain;
    return transform(plain, depth);
  }

  if (Array.isArray(node)) {
    let changed = false;
    const out = new Array(node.length);
    for (let i = 0; i < node.length; i += 1) {
      out[i] = transform(node[i], depth + 1);
      if (out[i] !== node[i]) changed = true;
    }
    return changed ? out : node;
  }

  let changed = false;
  const out = {};
  for (const key of Object.keys(node)) {
    const next = transform(node[key], depth + 1);
    out[key] = next;
    if (next !== node[key]) changed = true;
  }
  return changed ? out : node;
}

/**
 * @template T
 * @param {T} payload
 * @returns {T} payload đã ký (hoặc chính nó nếu CDN tắt / không có media)
 */
function signMediaDeep(payload) {
  if (!config.enabled) return payload;
  try {
    return transform(payload, 0);
  } catch (error) {
    // Không bao giờ để lỗi ký làm hỏng response — thà ảnh vỡ còn hơn 500.
    console.error('[cdn] signMediaDeep error:', error.message);
    return payload;
  }
}

module.exports = { signMediaDeep };
