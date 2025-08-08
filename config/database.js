const mongoose = require('mongoose');

module.exports = {
  async connect() {
    const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/wis_social';
    await mongoose.connect(uri);
    console.log('✅ [Social Service] MongoDB connected');
  },
};

