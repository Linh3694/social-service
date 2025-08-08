const mongoose = require('mongoose');

// Đồng bộ core schema từ Frappe ERP (apps/erp) mức tối thiểu cho Social
const userSchema = new mongoose.Schema({
  // Core identity
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

module.exports = mongoose.model('User', userSchema);

