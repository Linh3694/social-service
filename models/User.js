const mongoose = require('mongoose');
const { formatVietnameseName } = require('../utils/nameUtils');

/**
 * 🧑‍💼 Social Service - User Model
 * Đồng bộ user từ Frappe ERP để sử dụng trong chức năng Social/Newsfeed
 * Pattern tương tự ticket-service và inventory-service
 */
const userSchema = new mongoose.Schema({
  // Core identity - đồng bộ từ Frappe
  name: { type: String, index: true },
  email: { type: String, required: true, unique: true, trim: true, lowercase: true, index: true },
  fullname: { type: String, trim: true },
  fullName: { type: String, trim: true }, // Alias cho compatibility
  username: { type: String, trim: true, sparse: true },
  guardian_id: { type: String, trim: true, sparse: true, index: true },
  
  // Employee info
  employeeCode: { type: String, index: true, sparse: true },
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

// Indexes để tối ưu query
userSchema.index({ email: 1 });
userSchema.index({ username: 1 });
userSchema.index({ employeeCode: 1 });
userSchema.index({ role: 1 });
userSchema.index({ roles: 1 });
userSchema.index({ active: 1 });
userSchema.index({ department: 1 });
// Text index cho search mention - hỗ trợ tìm kiếm theo tên
userSchema.index({ fullname: 'text', email: 'text' });

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

  // Normalize fullname với nhiều fallback options
  const rawFullName = frappeUser.full_name || frappeUser.fullname || frappeUser.fullName ||
    [frappeUser.first_name, frappeUser.middle_name, frappeUser.last_name].filter(Boolean).join(' ') ||
    frappeUser.name;
  
  // Format tên theo chuẩn Việt Nam (Họ + Đệm + Tên)
  const fullName = formatVietnameseName(rawFullName);

  // Normalize roles: hỗ trợ cả string array và object array
  const roles = Array.isArray(frappeUser.roles)
    ? frappeUser.roles.map((r) => (typeof r === 'string' ? r : r?.role)).filter(Boolean)
    : Array.isArray(frappeUser.roles_list)
    ? frappeUser.roles_list
    : [];

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

