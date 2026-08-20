const mongoose = require('mongoose');
const { formatVietnameseNameFromParts } = require('../utils/nameUtils');

/**
 * 🧑‍💼 Social Service - User Model
 * Đồng bộ user từ Frappe ERP để sử dụng trong chức năng Social/Newsfeed
 * Pattern tương tự ticket-service và inventory-service
 */
const userSchema = new mongoose.Schema({
  // Core identity - đồng bộ từ Frappe
  name: { type: String, index: true },
  // unique đã tạo index btree trên email — không thêm index: true / schema.index({ email }) tránh trùng
  email: { type: String, required: true, unique: true, trim: true, lowercase: true },
  fullname: { type: String, trim: true },
  fullName: { type: String, trim: true }, // Alias cho compatibility
  username: { type: String, trim: true },
  guardian_id: { type: String, trim: true, sparse: true, index: true },
  
  // Employee info
  employeeCode: { type: String },
  department: { type: String, default: '' },
  jobTitle: { type: String, default: 'User' },
  
  // Roles - đồng bộ từ Frappe
  role: { type: String, default: 'user' },
  roles: [{ type: String, trim: true }],
  
  // Status
  active: { type: Boolean, default: true },
  disabled: { type: Boolean, default: false },
  
  // Profile
  avatarUrl: { type: String, default: '' },
  user_image: { type: String, default: '' },
  sis_photo: { type: String, default: '' },
  guardian_image: { type: String, default: '' },
  phone: { type: String, trim: true, sparse: true },
  mobileNo: { type: String, trim: true, sparse: true },
  
  // Provider info
  provider: { type: String, default: 'frappe' },
  microsoftId: { type: String, sparse: true },
  
  // Social follow graph
  following: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  followers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  
  // Activity tracking
  lastLogin: { type: Date },
  lastSeen: { type: Date, default: Date.now },
}, { timestamps: true });

// Indexes để tối ưu query (định nghĩa một lần — tránh trùng với index / unique trên path)
userSchema.index({ username: 1 }, { sparse: true });
userSchema.index({ employeeCode: 1 }, { sparse: true });
userSchema.index({ role: 1 });
userSchema.index({ roles: 1 });
userSchema.index({ active: 1 });
userSchema.index({ department: 1 });
// Text index cho search mention - hỗ trợ tìm kiếm theo tên
userSchema.index({ fullname: 'text', email: 'text' });

/** Đuôi email tài khoản PHHS đăng nhập parent portal. */
const PARENT_PORTAL_EMAIL_SUFFIX = '@parent.wellspring.edu.vn';

/**
 * Payload này là account PHHS (parent portal) hay không.
 *
 * Nhận diện CHỈ qua danh tính parent portal — role `Parent Portal User` (do
 * frappeService.authenticateParentGuardian tự sinh, không bao giờ có trên account GV),
 * field guardian_id, hoặc email tổng hợp `{guardian_id}@parent.wellspring.edu.vn` — chứ
 * KHÔNG suy từ tên role 'Parent'/'Guardian': hàng chục GV của trường đồng thời là PHHS
 * nhưng ở hai account riêng. Cùng quy ước với `userRole()` ở controllers/chatController.js.
 *
 * @param {Object} frappeUser
 * @param {string[]} roles
 * @returns {boolean}
 */
function isParentPortalAccount(frappeUser, roles) {
  if ((roles || []).includes('Parent Portal User')) return true;
  if (String(frappeUser?.guardian_id || '').trim()) return true;
  const email = String(frappeUser?.email || frappeUser?.name || '').trim().toLowerCase();
  return email.endsWith(PARENT_PORTAL_EMAIL_SUFFIX);
}

/** Dùng chung cho script sửa tên (scripts/fix-user-names.js) — một nguồn sự thật. */
userSchema.statics.isParentPortalAccount = function isParentPortalAccountStatic(user, roles) {
  return isParentPortalAccount(user, roles || user?.roles);
};

/**
 * Tên hiển thị chuẩn cho MỌI đường sync Frappe → Mongo.
 *
 * BẮT BUỘC dùng hàm này ở mọi chỗ ghi `fullname`. Trước đây chỉ updateFromFrappe chuẩn hoá,
 * còn cron sync toàn bộ user và webhook (controllers/userController.js) ghi thẳng
 * `full_name` của Frappe, nên cứ sau mỗi lần cron chạy là tên GV lại bị đảo ngược trở lại
 * ('Hà Nguyễn Thị Việt') và hiện ra trên thông báo Wislife — vì Wislife lấy thẳng
 * `user.fullname` lúc gửi, không format lại (services/wislifeStreamNotify.js).
 *
 * Chỉ chuẩn hoá account GV/CBNV: account đồng bộ AD/Microsoft mới bị đảo họ tên, còn tên
 * PHHS do ERP nhập sẵn đúng thứ tự VN nên đảo lại là làm sai (SIS-170).
 *
 * @param {Object} frappeUser Payload user từ Frappe (DocType User hoặc dạng đã map).
 * @param {string[]} [roles] Roles đã normalize; thiếu thì suy từ chính payload.
 * @returns {string} Tên hiển thị, có thể là chuỗi rỗng nếu payload không có tên nào.
 */
function resolveFrappeDisplayName(frappeUser, roles) {
  if (!frappeUser || typeof frappeUser !== 'object') return '';

  const rawFullName =
    frappeUser.full_name ||
    frappeUser.fullname ||
    frappeUser.fullName ||
    [frappeUser.first_name, frappeUser.middle_name, frappeUser.last_name].filter(Boolean).join(' ') ||
    frappeUser.name;

  if (isParentPortalAccount(frappeUser, roles)) {
    return String(rawFullName || '').trim();
  }

  return formatVietnameseNameFromParts(
    frappeUser.first_name,
    frappeUser.middle_name,
    frappeUser.last_name,
    rawFullName
  );
}

/** Cho các luồng sync ngoài model (controllers/userController.js) dùng cùng một luật. */
userSchema.statics.resolveFrappeDisplayName = function resolveFrappeDisplayNameStatic(frappeUser, roles) {
  return resolveFrappeDisplayName(frappeUser, roles);
};

/**
 * Giữ nguyên roles của account PHHS khi payload KHÔNG đến từ luồng parent portal.
 *
 * Account PH (`{guardian_id}@parent.wellspring.edu.vn`) phải mang roles ['Parent Portal User']
 * kèm guardian_id — do frappeService.authenticateParentGuardian dựng. Các luồng đồng bộ user
 * chung (cron sync toàn bộ user, Redis user_updated, webhook) đọc DocType User của Frappe nên
 * trả roles ['Parent','Guardian'] và KHÔNG có guardian_id; ghi đè vào sẽ xoá dấu vết parent
 * portal của doc. Chỉ payload tự mang 'Parent Portal User' hoặc guardian_id mới được ghi roles.
 *
 * Các field khác (ảnh, tên, trạng thái enabled) vẫn đồng bộ bình thường.
 *
 * @param {Object} update Object update sẽ đưa vào $set — bị sửa trực tiếp.
 * @param {string} email Email của doc đích.
 * @returns {Object} chính `update`, cho tiện chaining.
 */
function preserveParentPortalRoles(update, email) {
  if (!update) return update;
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized.endsWith(PARENT_PORTAL_EMAIL_SUFFIX)) return update;
  const roles = Array.isArray(update.roles) ? update.roles : [];
  const fromParentPortal = roles.includes('Parent Portal User') || Boolean(update.guardian_id);
  if (fromParentPortal) return update;
  delete update.roles;
  delete update.role;
  return update;
}

/** Cho các luồng sync ngoài model dùng cùng một luật (xem controllers/userController.js). */
userSchema.statics.preserveParentPortalRoles = function (update, email) {
  return preserveParentPortalRoles(update, email);
};

/**
 * Giữ roles hiện có khi payload KHÔNG mang roles.
 *
 * BẮT BUỘC gọi ở MỌI đường sync Frappe → Mongo trước khi ghi. Payload thiếu child table
 * `Has Role` — token không đủ quyền đọc, endpoint cũ, hay query roles ném lỗi rồi bị nuốt —
 * sẽ ghi `roles: []` và user mất SẠCH quyền. Giữ bản cũ chậm vài giờ là thiệt hại nhỏ hơn
 * nhiều so với việc xoá trắng, và cron 6:00 sẽ chữa lại.
 *
 * Đã từng mất role SIS BOD đúng theo cách này, nhưng lần đó chỉ vá cho luồng sync bulk.
 *
 * @param {Object} update Object update sẽ đưa vào $set — bị sửa trực tiếp.
 * @returns {Object} chính `update`, cho tiện chaining.
 */
function preserveRolesWhenPayloadEmpty(update) {
  if (!update) return update;
  if (Array.isArray(update.roles) && update.roles.length > 0) return update;
  delete update.roles;
  delete update.role;
  return update;
}

/** Cho các luồng sync ngoài model dùng cùng một luật (webhook, sync theo email). */
userSchema.statics.preserveRolesWhenPayloadEmpty = function (update) {
  return preserveRolesWhenPayloadEmpty(update);
};

/**
 * 🔄 Cập nhật/đồng bộ user từ Frappe
 * Pattern giống ticket-service để đảm bảo nhất quán
 * @param {Object} frappeUser - User object từ Frappe API
 * @returns {Promise<Document>} - Updated/created user document
 */
userSchema.statics.updateFromFrappe = async function updateFromFrappe(frappeUser) {
  if (!frappeUser || typeof frappeUser !== 'object') {
    throw new Error('Invalid Frappe user payload');
  }

  // Lấy email - ưu tiên email field, fallback về name (trong Frappe name thường là email)
  const email = frappeUser.email || frappeUser.user_id || frappeUser.username || frappeUser.name;
  if (!email) {
    throw new Error('User email is required');
  }

  // Normalize roles: hỗ trợ cả string array và object array
  // (tính trước fullname vì bước chuẩn hoá tên cần biết đây có phải account PHHS không)
  const roles = Array.isArray(frappeUser.roles)
    ? frappeUser.roles.map((r) => (typeof r === 'string' ? r : r?.role)).filter(Boolean)
    : Array.isArray(frappeUser.roles_list)
    ? frappeUser.roles_list
    : [];

  // Tên hiển thị: một luật duy nhất cho mọi đường sync (xem resolveFrappeDisplayName).
  const fullName = resolveFrappeDisplayName(frappeUser, roles);

  // Xác định enabled status: ưu tiên docstatus, fallback về enabled/disabled fields
  const isEnabled = frappeUser.docstatus === 0 || 
    (frappeUser.docstatus === undefined && frappeUser.enabled !== false && frappeUser.disabled !== true);

  // Build update object
  const update = {
    name: frappeUser.name,
    email: email,
    fullname: fullName,
    fullName: fullName, // Alias
    username: frappeUser.username || frappeUser.name,
    guardian_id: frappeUser.guardian_id,
    employeeCode: frappeUser.employee_code || frappeUser.employeeCode || frappeUser.employee,
    department: frappeUser.department || frappeUser.location || '',
    jobTitle: frappeUser.job_title || frappeUser.designation || 'User',
    // roles rỗng (payload thiếu child table) → gán bên dưới sẽ bỏ qua, giữ roles cũ.
    role: roles.length > 0 ? roles[0].toLowerCase() : 'user',
    roles: roles,
    active: isEnabled,
    disabled: !isEnabled,
    avatarUrl: frappeUser.guardian_image || frappeUser.user_image || frappeUser.userImage || frappeUser.avatar || frappeUser.avatar_url || '',
    user_image: frappeUser.user_image || frappeUser.userImage || '',
    sis_photo: frappeUser.sis_photo || frappeUser.photo || '',
    guardian_image: frappeUser.guardian_image || '',
    phone: frappeUser.phone || undefined,
    mobileNo: frappeUser.mobile_no || undefined,
    provider: 'frappe',
    microsoftId: frappeUser.microsoft_id || frappeUser.microsoftId,
    updatedAt: new Date(),
  };

  // Chỉ update fullname nếu có giá trị hợp lệ (không ghi đè bằng null/undefined)
  if (!fullName || !fullName.trim()) {
    delete update.fullname;
    delete update.fullName;
  }

  preserveRolesWhenPayloadEmpty(update);
  preserveParentPortalRoles(update, email);

  const query = { email: email.toLowerCase() };
  const options = { upsert: true, new: true, setDefaultsOnInsert: true };
  return await this.findOneAndUpdate(query, update, options);
};

/**
 * 🔍 Tìm user theo nhiều identifier
 */
userSchema.statics.findByLogin = function(identifier) {
  return this.findOne({
    $or: [
      { username: identifier },
      { email: identifier },
      { employeeCode: identifier }
    ]
  });
};

module.exports = mongoose.model('User', userSchema);

