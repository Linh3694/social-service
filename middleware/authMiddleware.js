const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { resolveAuthenticatedUser, toReqUserShape } = require('../utils/authResolve');

// Chuẩn hoá: tách optionalAuth và authenticate để dùng tuỳ route
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.split(' ')[1];
    if (!token) {
      console.warn('[Auth] Missing Authorization header');
      return res.status(401).json({ message: 'Unauthorized', detail: 'No token' });
    }

    const wantsRefresh =
      req.query?.refresh === '1'
      || req.headers['x-auth-refresh'] === '1';

    let userDoc;
    try {
      userDoc = await resolveAuthenticatedUser(token, { forceRefresh: Boolean(wantsRefresh) });
    } catch (e) {
      console.error('[Auth] Resolve failed:', e?.message || e);
      return res.status(e.statusCode || 401).json({
        message: 'Unauthorized',
        detail: e.message || 'Auth failed',
      });
    }

    req.user = toReqUserShape(userDoc);
    try { console.log('[Auth] OK user=', req.user.email, 'role=', req.user.role, 'roles=', req.user.roles); } catch {}
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
        user = await User.findOne({ email: userEmail }).select('fullname fullName email role roles department');
      }
      
      if (!user && decoded.id) {
        user = await User.findById(decoded.id).select('fullname fullName email role roles department');
      }
      
      if (user) {
        req.user = { _id: user._id, fullname: user.fullname || user.fullName, email: user.email, role: user.role, roles: user.roles || [], department: user.department };
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
