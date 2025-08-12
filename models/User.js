const mongoose = require('mongoose');

// Đồng bộ core schema từ Frappe ERP (apps/erp) mức tối thiểu cho Social
const userSchema = new mongoose.Schema({
  // Core identity
  name: { type: String, index: true },
  email: { type: String, required: true, index: true },
  fullname: { type: String },
  fullName: { type: String },
  username: { type: String },
  employeeCode: { type: String, index: true },
  department: { type: String },
  role: { type: String, default: 'user' },
  active: { type: Boolean, default: true },
  disabled: { type: Boolean, default: false },
  avatarUrl: { type: String },

  // Social follow graph
  following: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
}, { timestamps: true });

// Cập nhật/đồng bộ từ Frappe User
userSchema.statics.updateFromFrappe = async function updateFromFrappe(frappeUser) {
  if (!frappeUser) throw new Error('Missing frappe user');
  const normalizeRoles = (val) => {
    if (!val) return [];
    if (Array.isArray(val)) {
      return val
        .map((r) => (typeof r === 'string' ? r : (r && (r.role || r.name)) || null))
        .filter(Boolean);
    }
    return [];
  };
  const roles = normalizeRoles(frappeUser.roles).length
    ? normalizeRoles(frappeUser.roles)
    : normalizeRoles(frappeUser.user_roles);
  const primaryRole = roles[0] || frappeUser.role || 'user';
  const query = { email: frappeUser.email };
  const update = {
    name: frappeUser.name,
    email: frappeUser.email,
    fullname: frappeUser.full_name,
    fullName: frappeUser.full_name,
    username: frappeUser.username || frappeUser.name,
    employeeCode: frappeUser.employee || frappeUser.employee_code,
    department: frappeUser.department,
    role: typeof primaryRole === 'string' ? primaryRole : 'user',
    active: frappeUser.enabled === 1 || frappeUser.enabled === true,
    disabled: !(frappeUser.enabled === 1 || frappeUser.enabled === true),
    avatarUrl: frappeUser.user_image || frappeUser.avatar || '',
  };
  const options = { new: true, upsert: true, setDefaultsOnInsert: true };
  return await this.findOneAndUpdate(query, update, options);
};

module.exports = mongoose.model('User', userSchema);

