/**
 * Cắt chuỗi xem trước cho body thông báo đẩy — KHÔNG cắt giữa một từ.
 *
 * Trước đây body push cắt cứng `slice(0, N)` nên từ cuối bị đứt đôi và mất nghĩa, ví dụ
 * "...là học sinh mới củ" (đúng ra là "của lớp 1A"). Body do server soạn rồi gửi nguyên văn
 * ra Expo, client KHÔNG sửa được, nên phải cắt đúng ngay từ đây.
 *
 * Quy tắc: lùi về ranh giới khoảng trắng gần nhất, bỏ luôn từ đang dở rồi thêm "…".
 * Chỉ khi cả đoạn đầu không có khoảng trắng nào (URL / chuỗi liền dài) mới cắt cứng —
 * lúc đó bỏ hết là mất sạch nội dung.
 */

const ELLIPSIS = '…';

/** Dấu phụ tổ hợp (NFD) — chỉ dùng cho nhánh cắt cứng, để không bỏ lại dấu lơ lửng. */
const TRAILING_COMBINING_MARKS = /[\u0300-\u036f]+$/;

/** Khoảng trắng + dấu câu thừa ở cuối, để không ra "Trí, …" hay "abc.…". */
const TRAILING_PUNCTUATION = /[\s.,;:…–—-]+$/;

function tidyTail(s) {
  return s.replace(TRAILING_PUNCTUATION, '');
}

/**
 * @param {unknown} text nội dung gốc
 * @param {number} maxChars độ dài tối đa CỦA KẾT QUẢ (đã tính cả dấu "…")
 * @returns {string}
 */
function truncatePreview(text, maxChars) {
  const s = String(text ?? '').trim();
  const max = Number(maxChars);
  if (!s) return '';
  if (!Number.isFinite(max) || max <= 1) return s;

  // Đếm theo code point để không cắt đôi emoji (cặp surrogate).
  const chars = Array.from(s);
  if (chars.length <= max) return s;

  const head = chars.slice(0, max - 1).join('');
  // Ký tự ngay sau điểm cắt là khoảng trắng ⇒ từ cuối đã trọn vẹn, không cần bỏ.
  const wordSafe = /\s/.test(chars[max - 1]) ? head : head.replace(/\S+$/, '');

  const kept = tidyTail(wordSafe);
  if (kept) return `${kept}${ELLIPSIS}`;

  const hardCut = tidyTail(head.replace(TRAILING_COMBINING_MARKS, ''));
  return hardCut ? `${hardCut}${ELLIPSIS}` : '';
}

module.exports = { truncatePreview };
