const jwt = require('jsonwebtoken');
const User = require('../models/User');
const frappeService = require('../services/frappeService');

module.exports = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'Unauthorized - No token' });

    let user = null;
    let decoded = null;
    // 1) Thử decode JWT nội bộ
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
      user = await User.findById(decoded.id).select('fullname fullName email role department');
    } catch {}

    // 2) Nếu chưa có user local, thử Frappe
    if (!user) {
      try {
        const frappeUser = await frappeService.authenticateUser(token);
        user = await User.updateFromFrappe(frappeUser);
      } catch (e) {
        // 3) Nếu vẫn thất bại, cho phép các request READ (GET) tiếp tục với minimal identity để không chặn newsfeed
        if (decoded && req.method === 'GET') {
          req.user = {
            _id: decoded.id,
            fullname: 'Unknown',
            email: '',
            role: decoded.role || 'user',
            department: '',
          };
          return next();
        }
        return res.status(401).json({ message: 'Unauthorized', detail: 'Frappe auth failed' });
      }
    }

    // 4) Map req.user đầy đủ khi có user
    if (user) {
      req.user = {
        _id: user._id,
        fullname: user.fullname || user.fullName,
        email: user.email,
        role: user.role,
        department: user.department,
      };
    }
    next();
  } catch (error) {
    // Tránh crash và trả JSON rõ ràng để Nginx không trả 502
    return res.status(500).json({ message: 'Auth middleware error', error: error.message });
  }
};

