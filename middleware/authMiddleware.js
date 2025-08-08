const jwt = require('jsonwebtoken');
const User = require('../models/User');

module.exports = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'Unauthorized - No token' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select('fullname fullName email role department');
    if (!user) return res.status(404).json({ message: 'User not found' });

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

