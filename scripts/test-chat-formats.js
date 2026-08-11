#!/usr/bin/env node
/**
 * Kiểm chứng `utils/chatFormats.js` — chạy độc lập, KHÔNG cần Mongo/Redis.
 *
 *   node scripts/test-chat-formats.js
 *
 * Phủ đúng những chỗ dễ sai của mô hình neo-theo-offset:
 *   - chồng lấn / lồng nhau phải ra các run RỜI NHAU (5 client cắt chuỗi theo đây;
 *     lệch một ký tự là hiển thị lệch ở app này mà đúng ở app kia)
 *   - clamp phải CẮT chứ không NỚI dải (nới ⇒ tô đậm cả chữ người gửi không chọn)
 *   - màu sai token chỉ mất màu, không mất luôn bold/italic
 *   - đầu vào rác không làm ngã request
 */

const assert = require('assert');
const { sanitizeFormats } = require('../utils/chatFormats');

let failed = 0;
function check(label, actual, expected) {
  try {
    assert.deepStrictEqual(actual, expected);
    console.log(`  ok   ${label}`);
  } catch (_) {
    failed += 1;
    console.log(`  FAIL ${label}`);
    console.log(`       got      ${JSON.stringify(actual)}`);
    console.log(`       expected ${JSON.stringify(expected)}`);
  }
}

const text = 'Xin chao cac phu huynh'; // 22 ký tự

console.log('chatFormats.sanitizeFormats');

check('dải đơn giữ nguyên',
  sanitizeFormats([{ start: 0, length: 3, bold: true }], text),
  [{ start: 0, length: 3, bold: true }]);

check('chồng lấn một phần → 3 run rời nhau',
  sanitizeFormats([
    { start: 0, length: 10, bold: true },
    { start: 5, length: 10, color: 'oxford-blue' },
  ], text),
  [
    { start: 0, length: 5, bold: true },
    { start: 5, length: 5, bold: true, color: 'oxford-blue' },
    { start: 10, length: 5, color: 'oxford-blue' },
  ]);

check('lồng nhau → mark cộng dồn ở đoạn giữa',
  sanitizeFormats([
    { start: 0, length: 20, bold: true },
    { start: 5, length: 3, italic: true },
  ], text),
  [
    { start: 0, length: 5, bold: true },
    { start: 5, length: 3, bold: true, italic: true },
    { start: 8, length: 12, bold: true },
  ]);

check('hai dải liền kề cùng mark → gộp làm một',
  sanitizeFormats([
    { start: 0, length: 5, bold: true },
    { start: 5, length: 5, bold: true },
  ], text),
  [{ start: 0, length: 10, bold: true }]);

check('khoảng hở giữa hai dải không bị nuốt',
  sanitizeFormats([
    { start: 0, length: 3, bold: true },
    { start: 10, length: 3, italic: true },
  ], text),
  [
    { start: 0, length: 3, bold: true },
    { start: 10, length: 3, italic: true },
  ]);

check('client gửi lộn xộn → sort theo start',
  sanitizeFormats([
    { start: 10, length: 3, bold: true },
    { start: 0, length: 3, italic: true },
  ], text),
  [
    { start: 0, length: 3, italic: true },
    { start: 10, length: 3, bold: true },
  ]);

check('vượt độ dài nội dung → cắt',
  sanitizeFormats([{ start: 18, length: 999, bold: true }], text),
  [{ start: 18, length: 4, bold: true }]);

// Chỗ này từng sai: clamp `start` trước rồi mới cộng `length` sẽ ra 0..8 (NỚI dải thêm 5 ký tự)
// thay vì 0..3 — tức bôi đậm cả chữ người gửi không hề chọn.
check('start âm → cắt phần âm, KHÔNG nới dải',
  sanitizeFormats([{ start: -5, length: 8, bold: true }], text),
  [{ start: 0, length: 3, bold: true }]);

check('dải nằm hẳn ngoài nội dung → bỏ',
  sanitizeFormats([{ start: 100, length: 5, bold: true }], text), []);

check('length <= 0 → bỏ',
  sanitizeFormats([
    { start: 0, length: 0, bold: true },
    { start: 2, length: -5, bold: true },
  ], text), []);

check('màu hex (không phải token) → bỏ màu, giữ bold',
  sanitizeFormats([{ start: 0, length: 3, bold: true, color: '#ff0000' }], text),
  [{ start: 0, length: 3, bold: true }]);

check('dải không mang mark nào → bỏ',
  sanitizeFormats([{ start: 0, length: 3 }], text), []);

check('hai màu chồng nhau → dải khai báo sau thắng',
  sanitizeFormats([
    { start: 0, length: 5, color: 'oxford-blue' },
    { start: 0, length: 5, color: 'teal' },
  ], text),
  [{ start: 0, length: 5, color: 'teal' }]);

check('highlight hợp lệ được giữ',
  sanitizeFormats([{ start: 0, length: 4, highlight: 'amber' }], text),
  [{ start: 0, length: 4, highlight: 'amber' }]);

check('màu chữ + highlight cùng đoạn',
  sanitizeFormats([
    { start: 0, length: 4, color: 'oxford-blue' },
    { start: 0, length: 4, highlight: 'lime' },
  ], text),
  [{ start: 0, length: 4, color: 'oxford-blue', highlight: 'lime' }]);

// Amber/Lime/Honey CHỈ hợp lệ ở vai highlight — đưa vào `color` là chữ không đọc được trên nền sáng.
check('màu tươi đặt nhầm vào color → bị loại',
  sanitizeFormats([{ start: 0, length: 4, color: 'amber', bold: true }], text),
  [{ start: 0, length: 4, bold: true }]);

// Ngược lại: màu chữ đậm không phải token highlight.
check('màu chữ đặt nhầm vào highlight → bị loại',
  sanitizeFormats([{ start: 0, length: 4, highlight: 'oxford-blue', bold: true }], text),
  [{ start: 0, length: 4, bold: true }]);

check('highlight khác nhau không bị gộp',
  sanitizeFormats([
    { start: 0, length: 3, highlight: 'amber' },
    { start: 3, length: 3, highlight: 'lime' },
  ], text),
  [
    { start: 0, length: 3, highlight: 'amber' },
    { start: 3, length: 3, highlight: 'lime' },
  ]);

check('số dạng chuỗi (form-data) vẫn đọc được',
  sanitizeFormats([{ start: '2', length: '4', underline: true }], text),
  [{ start: 2, length: 4, underline: true }]);

check('content rỗng → []', sanitizeFormats([{ start: 0, length: 3, bold: true }], ''), []);

check('đầu vào rác không ném lỗi',
  sanitizeFormats([null, 'x', 42, { start: NaN, length: 3, bold: true }], text), []);

check('không phải mảng → []', sanitizeFormats('bold', text), []);

console.log(failed ? `\n${failed} test FAILED` : '\nOK — chat-formats: tất cả test đã qua.');
process.exit(failed ? 1 : 0);
