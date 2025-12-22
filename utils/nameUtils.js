/**
 * 🇻🇳 Vietnamese Name Utility
 * 
 * Chuẩn hóa tên theo format Việt Nam: Họ + Họ-đệm + Tên
 * Ví dụ: "Nguyễn Văn An", "Trần Thị Mai Hương"
 * 
 * Vấn đề: Data từ Microsoft Auth thường theo format Tây: "First Middle Last"
 * Cần phát hiện và đảo ngược nếu cần.
 */

// Danh sách họ phổ biến Việt Nam (dùng để detect format)
const VIETNAMESE_SURNAMES = [
  // Họ đơn phổ biến
  'nguyễn', 'nguyen', 'trần', 'tran', 'lê', 'le', 'phạm', 'pham',
  'huỳnh', 'huynh', 'hoàng', 'hoang', 'vũ', 'vu', 'võ', 'vo',
  'phan', 'trương', 'truong', 'bùi', 'bui', 'đặng', 'dang',
  'đỗ', 'do', 'ngô', 'ngo', 'hồ', 'ho', 'dương', 'duong',
  'đinh', 'dinh', 'lý', 'ly', 'lương', 'luong', 'mai', 'đào', 'dao',
  'trịnh', 'trinh', 'tô', 'to', 'tạ', 'ta', 'chu', 'châu', 'chau',
  'quách', 'quach', 'cao', 'la', 'thái', 'thai', 'lưu', 'luu',
  'phùng', 'phung', 'vương', 'vuong', 'từ', 'tu', 'hà', 'ha',
  'kiều', 'kieu', 'đoàn', 'doan', 'tăng', 'tang', 'lam', 'mã', 'ma',
  'tống', 'tong', 'triệu', 'trieu', 'nghiêm', 'nghiem', 'thạch', 'thach',
  'quang', 'doãn', 'doan', 'khương', 'khuong', 'ninh',
  // Họ ghép phổ biến
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
 * @param {string[]} parts - Mảng các phần của tên
 * @returns {{format: 'vietnamese'|'western'|'middle_surname'|'unknown', surnameIndex: number}}
 */
function detectNameFormat(parts) {
  if (parts.length < 2) return { format: 'unknown', surnameIndex: -1 };
  
  const firstPart = parts[0];
  const lastPart = parts[parts.length - 1];
  
  // Nếu phần đầu là họ VN → đã chuẩn format VN
  if (isVietnameseSurname(firstPart)) {
    // Double check: phần cuối không phải họ
    if (!isVietnameseSurname(lastPart) || parts.length === 1) {
      return { format: 'vietnamese', surnameIndex: 0 };
    }
  }
  
  // Nếu phần cuối là họ VN → format Tây, cần đảo
  if (isVietnameseSurname(lastPart)) {
    return { format: 'western', surnameIndex: parts.length - 1 };
  }
  
  // *** MỚI: Kiểm tra họ ở GIỮA tên (ví dụ: "Anh Đoàn Vân" → họ Đoàn ở vị trí 1)
  // Case này xảy ra khi Microsoft Auth format sai: First + Last + Middle
  for (let i = 1; i < parts.length - 1; i++) {
    if (isVietnameseSurname(parts[i])) {
      // Tìm thấy họ ở giữa - cần sắp xếp lại
      return { format: 'middle_surname', surnameIndex: i };
    }
  }
  
  // Nếu có 3 phần và phần giữa là tên đệm VN
  if (parts.length >= 3) {
    const middlePart = parts[1];
    
    // Format VN: Họ + Đệm + Tên → phần 2 là đệm
    if (isVietnameseMiddleName(middlePart) && isVietnameseSurname(firstPart)) {
      return { format: 'vietnamese', surnameIndex: 0 };
    }
  }
  
  return { format: 'unknown', surnameIndex: -1 };
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
  detectNameFormat,
  removeVietnameseTones
};

