const jwt = require('jsonwebtoken');
const User = require('../models/User');
const frappeService = require('../services/frappeService');

// Chuẩn hoá: tách optionalAuth và authenticate để dùng tuỳ route
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.split(' ')[1];
    if (!token) {
      console.warn('[Auth] Missing Authorization header');
      return res.status(401).json({ message: 'Unauthorized', detail: 'No token' });
    }

    let user = null;
    let decoded = null;
    try { decoded = jwt.verify(token, process.env.JWT_SECRET || 'breakpoint'); } catch {}
    if (decoded) {
      try {
        // Ưu tiên tìm theo email trong claim (hỗ trợ cả sub và email từ Frappe JWT)
        // - Frappe JWT: decoded.sub (chuẩn JWT) hoặc decoded.email
        // - Local JWT: decoded.email hoặc decoded.id
        const userEmail = decoded.sub || decoded.email;
        if (userEmail) {
          user = await User.findOne({ email: userEmail }).select('fullname fullName email role department');
        }
        // Backward: nếu có id
        if (!user && decoded.id) {
          user = await User.findById(decoded.id).select('fullname fullName email role department');
        }
      } catch {}
    }
    if (!user) {
      try {
        const frappeUser = await frappeService.authenticateUser(token);
        user = await User.updateFromFrappe(frappeUser);
        if (!user) {
          console.warn('[Auth] Frappe returned no user context');
          return res.status(401).json({ message: 'Unauthorized', detail: 'Frappe user not found' });
        }
      } catch (e) {
        console.error('[Auth] Frappe auth failed:', e?.message || e);
        return res.status(401).json({ message: 'Unauthorized', detail: 'Auth failed' });
      }
    }
    req.user = {
      _id: user._id,
      fullname: user.fullname || user.fullName,
      email: user.email,
      role: user.role,
      department: user.department,
    };
    // Debug: quick trace
    try { console.log('[Auth] OK user=', req.user.email, 'role=', req.user.role); } catch {}
    next();
  } catch (error) {
    console.error('[Auth] middleware error:', error?.message || error);
    return res.status(500).json({ message: 'Auth middleware error', error: error.message });
  }
};

const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.split(' ')[1];
    if (!token) { req.user = null; return next(); }
    let decoded = null;
    try { decoded = jwt.verify(token, process.env.JWT_SECRET || 'breakpoint'); } catch {}
    if (!decoded) { req.user = null; return next(); }
    try {
      // Hỗ trợ cả Frappe JWT (sub/email) và local JWT (id)
      const userEmail = decoded.sub || decoded.email;
      let user = null;
      
      if (userEmail) {
        user = await User.findOne({ email: userEmail }).select('fullname fullName email role department');
      }
      
      if (!user && decoded.id) {
        user = await User.findById(decoded.id).select('fullname fullName email role department');
      }
      
      if (user) {
        req.user = { _id: user._id, fullname: user.fullname || user.fullName, email: user.email, role: user.role, department: user.department };
      } else {
        // Fallback: tạo user object từ token claims
        req.user = { _id: decoded.id || userEmail, email: userEmail };
      }
    } catch { 
      req.user = { _id: decoded.id || decoded.sub || decoded.email }; 
    }
    return next();
  } catch { req.user = null; return next(); }
};

module.exports = { authenticate, optionalAuth };

