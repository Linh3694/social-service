/**
 * 🎨 Định dạng chữ trong chat (in đậm / nghiêng / gạch chân / màu) — logic thuần,
 * không đụng mongoose/Express.
 *
 * Mô hình giống hệt `chatMentions.js`: `content` VẪN là TEXT THUẦN, mảng `formats` chỉ neo
 * vị trí theo offset. Hệ quả (chính là lý do chọn cách này thay vì lưu HTML):
 *   - offset của `mentions` không bị lệch — hai mảng cùng neo vào một chuỗi;
 *   - body push notification, `lastMessage.content`, trích dẫn reply và tìm kiếm vẫn chạy
 *     nguyên trên `content` nên KHÔNG phải sửa gì (thẻ HTML sẽ lọt hết vào những chỗ đó);
 *   - client cũ chưa cập nhật bỏ qua field lạ ⇒ hiển thị text thuần, không phải migrate tin cũ;
 *   - không có HTML do người dùng nhập ⇒ không mở bề mặt XSS mới, mobile không cần renderer HTML.
 *
 * Màu lưu bằng TOKEN chứ không phải hex: nền bong bóng mỗi app một khác (cam / teal / navy /
 * xám), nên client phải tự map token sang màu đọc được trên nền của mình.
 */

/** Token màu chữ hợp lệ. Thêm token mới ⇒ nhớ bổ sung bảng map ở cả 5 client. */
const CHAT_TEXT_COLOR_TOKENS = ['red', 'orange', 'green', 'blue', 'purple', 'gray'];

/** Các mark boolean — liệt kê một chỗ để thêm mark mới không phải sửa rải rác. */
const CHAT_FORMAT_FLAGS = ['bold', 'italic', 'underline'];

/** Trần số dải một tin — chặn payload rác, không phải giới hạn nghiệp vụ. */
const MAX_FORMATS_PER_MESSAGE = 50;

/** Trần số dải client gửi lên trước khi chuẩn hoá (chuẩn hoá xong mới cắt còn MAX). */
const MAX_INCOMING_FORMATS = 500;

const COLOR_TOKEN_SET = new Set(CHAT_TEXT_COLOR_TOKENS);

/** Khoá so sánh hai dải có cùng bộ mark hay không (để gộp đoạn liền kề). */
function marksKey(mark) {
  return `${CHAT_FORMAT_FLAGS.map((f) => (mark[f] ? '1' : '0')).join('')}|${mark.color || ''}`;
}

/** Dải không mang mark nào thì vô nghĩa — bỏ để khỏi tốn payload. */
function isEmptyMark(mark) {
  return !mark.color && CHAT_FORMAT_FLAGS.every((f) => !mark[f]);
}

/**
 * Đọc một phần tử client gửi lên thành `{ start, end, ...marks }`.
 * Trả null nếu không dùng được (không phải số, dải rỗng, nằm ngoài nội dung).
 */
function readIncoming(item, contentLength) {
  if (!item || typeof item !== 'object') return null;

  const rawStart = Number(item.start);
  const rawLength = Number(item.length);
  if (!Number.isFinite(rawStart) || !Number.isFinite(rawLength)) return null;

  const length = Math.trunc(rawLength);
  if (length <= 0) return null;

  // Clamp thay vì loại: client tính offset trên chuỗi CHƯA trim thì dải lố vài ký tự, cắt lại
  // vẫn đúng ý người gửi. Phải suy `end` từ start GỐC rồi mới clamp hai đầu — clamp start trước
  // sẽ NỚI dải ra (start -5 length 8 thành 0..8 thay vì 0..3), tức tô đậm cả chữ không được chọn.
  const start = Math.max(0, Math.trunc(rawStart));
  const end = Math.min(contentLength, Math.trunc(rawStart) + length);
  if (end <= start) return null;

  const mark = {};
  for (const flag of CHAT_FORMAT_FLAGS) {
    if (item[flag] === true) mark[flag] = true;
  }
  // Màu sai token thì bỏ RIÊNG field màu, giữ các mark còn lại — người gửi mất màu
  // nhưng không mất luôn phần in đậm.
  const color = typeof item.color === 'string' ? item.color.trim().toLowerCase() : '';
  if (color && COLOR_TOKEN_SET.has(color)) mark.color = color;

  if (isEmptyMark(mark)) return null;
  return { start, end, ...mark };
}

/**
 * Lọc & chuẩn hoá `formats` client gửi lên.
 *
 * Client ĐƯỢC PHÉP gửi dải chồng nhau (in đậm + tô màu trên cùng một đoạn). Server gộp lại
 * thành các run RỜI NHAU, sắp xếp theo `start` — nhờ vậy 5 client chỉ việc cắt chuỗi theo
 * offset để render, không nơi nào phải tự giải chồng lấn (lệch thuật toán ⇒ lệch hiển thị).
 *
 * @param {Array} raw danh sách dải client gửi
 * @param {string} content nội dung tin ĐÃ trim (offset tính trên chuỗi này)
 * @returns {Array<{start:number,length:number,bold?:boolean,italic?:boolean,underline?:boolean,color?:string}>}
 */
function sanitizeFormats(raw, content) {
  if (!Array.isArray(raw) || !raw.length) return [];
  const text = String(content || '');
  if (!text) return [];

  const items = [];
  for (const item of raw.slice(0, MAX_INCOMING_FORMATS)) {
    const parsed = readIncoming(item, text.length);
    if (parsed) items.push(parsed);
  }
  if (!items.length) return [];

  // Quét theo ranh giới: mọi điểm bắt đầu/kết thúc chia chuỗi thành các đoạn con, mỗi đoạn con
  // nhận hợp của các mark phủ lên nó. Cách này xử lý mọi kiểu chồng lấn/lồng nhau bằng một
  // lượt duy nhất, không phải xét từng cặp.
  const boundaries = new Set();
  for (const item of items) {
    boundaries.add(item.start);
    boundaries.add(item.end);
  }
  const points = [...boundaries].sort((a, b) => a - b);

  const runs = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const start = points[i];
    const end = points[i + 1];
    if (end <= start) continue;

    const mark = {};
    for (const item of items) {
      if (item.start > start || item.end < end) continue;
      for (const flag of CHAT_FORMAT_FLAGS) {
        if (item[flag]) mark[flag] = true;
      }
      // Chồng màu: dải khai báo SAU thắng — client gửi theo thứ tự người dùng thao tác.
      if (item.color) mark.color = item.color;
    }
    if (isEmptyMark(mark)) continue;

    // Gộp với run liền trước nếu sát nhau và cùng bộ mark → payload gọn, render ít node hơn.
    const prev = runs[runs.length - 1];
    if (prev && prev.end === start && marksKey(prev) === marksKey(mark)) {
      prev.end = end;
      continue;
    }
    runs.push({ start, end, ...mark });
  }

  return runs.slice(0, MAX_FORMATS_PER_MESSAGE).map(({ start, end, ...mark }) => ({
    start,
    length: end - start,
    ...mark,
  }));
}

/** `formats` từ body — chấp nhận cả chuỗi JSON (client gửi qua form-data). */
function parseIncomingFormats(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }
  return [];
}

module.exports = {
  CHAT_TEXT_COLOR_TOKENS,
  CHAT_FORMAT_FLAGS,
  MAX_FORMATS_PER_MESSAGE,
  sanitizeFormats,
  parseIncomingFormats,
};
