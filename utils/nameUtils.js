/**
 * 🇻🇳 Vietnamese Name Utility
 * 
 * Chuẩn hóa tên theo format Việt Nam: Họ + Họ-đệm + Tên
 * Ví dụ: "Nguyễn Văn An", "Trần Thị Mai Hương"
 * 
 * Vấn đề: Data từ Microsoft Auth thường theo format Tây: "First Middle Last"
 * Cần phát hiện và đảo ngược nếu cần.
 */

// Danh sách họ phổ biến Việt Nam - SẮP XẾP THEO ĐỘ PHỔ BIẾN (cao nhất trước)
// Khi có nhiều họ trong tên, ưu tiên họ phổ biến hơn
const VIETNAMESE_SURNAMES_PRIORITY = [
  // Tier 1: Rất phổ biến (>5% dân số)
  'nguyễn', 'nguyen', 'trần', 'tran', 'lê', 'le', 'phạm', 'pham',
  // Tier 2: Phổ biến (2-5%)
  'huỳnh', 'huynh', 'hoàng', 'hoang', 'vũ', 'vu', 'võ', 'vo',
  'phan', 'trương', 'truong', 'bùi', 'bui', 'đặng', 'dang',
  'đỗ', 'do', 'ngô', 'ngo', 'hồ', 'ho', 'dương', 'duong',
  // Tier 3: Khá phổ biến (1-2%)
  'đinh', 'dinh', 'lý', 'ly', 'lương', 'luong', 'đào', 'dao',
  'trịnh', 'trinh', 'tô', 'to', 'tạ', 'ta', 'chu', 'châu', 'chau',
  'quách', 'quach', 'thái', 'thai', 'lưu', 'luu',
  'phùng', 'phung', 'vương', 'vuong', 'từ', 'tu',
  'kiều', 'kieu', 'đoàn', 'doan', 'tăng', 'tang', 'mã', 'ma',
  'tống', 'tong', 'triệu', 'trieu', 'nghiêm', 'nghiem', 'thạch', 'thach',
  'doãn', 'khương', 'khuong', 'ninh',
  // Tier 4: Ít phổ biến - những họ này cũng có thể là TÊN
  'hà', 'ha', 'cao', 'la', 'mai', 'lam', 'quang'
];

// Flat list để check nhanh
const VIETNAMESE_SURNAMES = [...VIETNAMESE_SURNAMES_PRIORITY];

// Họ ghép phổ biến
const COMPOUND_SURNAMES = [
  'nguyễn đình', 'nguyen dinh', 'nguyễn văn', 'nguyen van',
  'trần văn', 'tran van', 'lê văn', 'le van', 'phạm văn', 'pham van'
];

// Danh sách tên đệm phổ biến (nam)
const MALE_MIDDLE_NAMES = ['văn', 'van', 'hữu', 'huu', 'đức', 'duc', 'công', 'cong', 'quốc', 'quoc', 'minh', 'xuân', 'xuan', 'duy', 'viết', 'viet', 'thanh', 'mạnh', 'manh', 'tuấn', 'tuan', 'trung', 'bảo', 'bao', 'quang'];

// Danh sách tên đệm phổ biến (nữ)
const FEMALE_MIDDLE_NAMES = ['thị', 'thi', 'thanh', 'thu', 'ngọc', 'ngoc', 'kim', 'hoài', 'hoai', 'mai', 'hồng', 'hong', 'thúy', 'thuy', 'diễm', 'diem', 'phương', 'phuong', 'lan', 'thu', 'mỹ', 'my', 'như', 'nhu', 'bích', 'bich'];

/**
 * Loại bỏ dấu tiếng Việt để so sánh
 * @param {string} str 
 * @returns {string}
 */
function removeVietnameseTones(str) {
  if (!str) return '';
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

/**
 * Kiểm tra xem một từ có phải là họ Việt Nam không
 * @param {string} word 
 * @returns {boolean}
 */
function isVietnameseSurname(word) {
  if (!word) return false;
  const normalized = removeVietnameseTones(word.toLowerCase());
  return VIETNAMESE_SURNAMES.some(surname => 
    normalized === removeVietnameseTones(surname)
  );
}

/**
 * Lấy độ ưu tiên của họ (số càng nhỏ = càng phổ biến)
 * @param {string} word 
 * @returns {number} - Index trong mảng priority, -1 nếu không phải họ VN
 */
function getSurnamePriority(word) {
  if (!word) return -1;
  const normalized = removeVietnameseTones(word.toLowerCase());
  const index = VIETNAMESE_SURNAMES_PRIORITY.findIndex(surname => 
    normalized === removeVietnameseTones(surname)
  );
  return index;
}

/**
 * Kiểm tra xem một từ có phải là tên đệm Việt Nam không
 * @param {string} word 
 * @returns {boolean}
 */
function isVietnameseMiddleName(word) {
  if (!word) return false;
  const normalized = removeVietnameseTones(word.toLowerCase());
  return [...MALE_MIDDLE_NAMES, ...FEMALE_MIDDLE_NAMES].some(name => 
    normalized === removeVietnameseTones(name)
  );
}

/**
 * Phát hiện format của tên và trả về vị trí họ
 * Logic mới: Tìm TẤT CẢ các vị trí có họ VN, chọn họ PHỔ BIẾN NHẤT
 * 
 * @param {string[]} parts - Mảng các phần của tên
 * @returns {{format: 'vietnamese'|'western'|'middle_surname'|'unknown', surnameIndex: number}}
 * 
 * @example
 * detectNameFormat(['Cao', 'Linh', 'Nguyễn']) // Cả Cao và Nguyễn là họ, nhưng Nguyễn phổ biến hơn
 * // → { format: 'western', surnameIndex: 2 } (Nguyễn ở cuối)
 */
function detectNameFormat(parts) {
  if (parts.length < 2) return { format: 'unknown', surnameIndex: -1 };
  
  // Bước 1: Tìm TẤT CẢ các vị trí có họ VN và priority của chúng
  const surnamePositions = [];
  for (let i = 0; i < parts.length; i++) {
    const priority = getSurnamePriority(parts[i]);
    if (priority >= 0) {
      surnamePositions.push({ index: i, priority: priority, word: parts[i] });
    }
  }
  
  // Không có họ VN nào
  if (surnamePositions.length === 0) {
    return { format: 'unknown', surnameIndex: -1 };
  }
  
  // Chỉ có 1 họ → dùng họ đó
  if (surnamePositions.length === 1) {
    const pos = surnamePositions[0];
    if (pos.index === 0) {
      return { format: 'vietnamese', surnameIndex: 0 };
    } else if (pos.index === parts.length - 1) {
      return { format: 'western', surnameIndex: pos.index };
    } else {
      return { format: 'middle_surname', surnameIndex: pos.index };
    }
  }
  
  // Có NHIỀU họ → chọn họ PHỔ BIẾN NHẤT (priority nhỏ nhất)
  // Ví dụ: "Cao Linh Nguyễn" → Cao (priority ~16) vs Nguyễn (priority 0) → chọn Nguyễn
  surnamePositions.sort((a, b) => a.priority - b.priority);
  const bestSurname = surnamePositions[0];
  
  // Nếu họ phổ biến nhất ở vị trí đầu → format VN đúng
  if (bestSurname.index === 0) {
    return { format: 'vietnamese', surnameIndex: 0 };
  }
  
  // Nếu họ phổ biến nhất ở vị trí cuối → format Tây
  if (bestSurname.index === parts.length - 1) {
    return { format: 'western', surnameIndex: bestSurname.index };
  }
  
  // Họ phổ biến nhất ở giữa → format middle_surname
  return { format: 'middle_surname', surnameIndex: bestSurname.index };
}

/**
 * Chuẩn hóa tên sang format Việt Nam
 * 
 * @param {string} fullName - Tên đầy đủ cần chuẩn hóa
 * @returns {string} - Tên đã chuẩn hóa theo format VN (Họ Đệm Tên)
 * 
 * @example
 * formatVietnameseName('Duy Hiếu Nguyễn') // → 'Nguyễn Duy Hiếu'
 * formatVietnameseName('Nguyễn Hải Linh') // → 'Nguyễn Hải Linh' (giữ nguyên)
 * formatVietnameseName('Anh Đoàn Vân')    // → 'Đoàn Vân Anh' (họ ở giữa)
 * formatVietnameseName('John Smith')      // → 'John Smith' (không phải tên VN)
 */
function formatVietnameseName(fullName) {
  if (!fullName || typeof fullName !== 'string') {
    return fullName || '';
  }
  
  const trimmed = fullName.trim();
  if (!trimmed) return '';
  
  const parts = trimmed.split(/\s+/).filter(Boolean);
  
  // Nếu chỉ có 1 từ → giữ nguyên
  if (parts.length <= 1) {
    return trimmed;
  }
  
  const { format, surnameIndex } = detectNameFormat(parts);
  
  if (format === 'western') {
    // Đảo ngược: First Middle Last → Last Middle First
    // Ví dụ: ['Duy', 'Hiếu', 'Nguyễn'] → ['Nguyễn', 'Duy', 'Hiếu']
    const lastName = parts.pop(); // Lấy phần cuối (họ)
    return [lastName, ...parts].join(' ');
  }
  
  if (format === 'middle_surname') {
    // Họ ở giữa: First Surname Middle → Surname Middle First
    // Ví dụ: ['Anh', 'Đoàn', 'Vân'] → ['Đoàn', 'Vân', 'Anh']
    // surnameIndex = 1 (Đoàn)
    const surname = parts[surnameIndex];
    const beforeSurname = parts.slice(0, surnameIndex); // ['Anh']
    const afterSurname = parts.slice(surnameIndex + 1);  // ['Vân']
    // Sắp xếp: Họ + phần sau + phần trước
    return [surname, ...afterSurname, ...beforeSurname].join(' ');
  }
  
  // Format VN hoặc unknown → giữ nguyên
  return trimmed;
}

/**
 * Chuẩn hóa tên với title case
 * @param {string} fullName 
 * @returns {string}
 */
function formatVietnameseNameWithTitleCase(fullName) {
  const formatted = formatVietnameseName(fullName);
  if (!formatted) return '';
  
  // Title case cho từng từ
  return formatted
    .split(/\s+/)
    .map(word => {
      if (!word) return '';
      // Giữ nguyên các chữ viết tắt (2 chữ trở xuống đều viết hoa)
      if (word.length <= 2) return word.toUpperCase();
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
}

/**
 * Kiểm tra xem một tên có phải là tên Việt Nam không
 * @param {string} fullName 
 * @returns {boolean}
 */
function isVietnameseName(fullName) {
  if (!fullName) return false;
  const parts = fullName.trim().split(/\s+/);
  
  // Kiểm tra xem có chứa họ VN ở đầu hoặc cuối không
  return isVietnameseSurname(parts[0]) || isVietnameseSurname(parts[parts.length - 1]);
}

module.exports = {
  formatVietnameseName,
  formatVietnameseNameWithTitleCase,
  isVietnameseName,
  isVietnameseSurname,
  getSurnamePriority,
  detectNameFormat,
  removeVietnameseTones
};


