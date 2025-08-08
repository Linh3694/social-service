const jwt = require('jsonwebtoken');
const User = require('../models/User');
const frappeService = require('../services/frappeService');

module.exports = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'Unauthorized - No token' });

    let user = null;
    // Thử decode JWT nội bộ (nếu đang dùng token nội bộ)
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      user = await User.findById(decoded.id).select('fullname fullName email role department');
    } catch {}

    // Nếu chưa có user local, fallback xác thực qua Frappe và đồng bộ vào local
    if (!user) {
      try {
        const frappeUser = await frappeService.authenticateUser(token);
        user = await User.updateFromFrappe(frappeUser);
      } catch (e) {
        return res.status(404).json({ message: 'User not found' });
      }
    }

    req.user = {
      _id: user._id,
      fullname: user.fullname || user.fullName,
      email: user.email,
      role: user.role,
      department: user.department,
    };
    next();
  } catch (error) {
    return res.status(401).json({ message: 'Unauthorized', error: error.message });
  }
};

