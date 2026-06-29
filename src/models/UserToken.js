const mongoose = require('mongoose');

const userTokenSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
    index: true
  },
  phone: {
    type: String,
    required: true,
    trim: true,
    index: true
  },
  fcmToken: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Compound index to quickly find tokens associated with either email or phone
userTokenSchema.index({ email: 1, phone: 1 });

module.exports = mongoose.model('UserToken', userTokenSchema);
