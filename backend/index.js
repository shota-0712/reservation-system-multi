require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const apiRoutes = require('./routes/api');

const app = express();
const PORT = process.env.PORT || 8080;

// CORS設定
const corsOptions = {
  origin: [
    'https://liff.line.me',  // LIFF アプリ
    /^http:\/\/localhost(:\d+)?$/,  // ローカル開発
    /^http:\/\/127\.0\.0\.1(:\d+)?$/,  // ローカル開発
  ],
  credentials: true,
};
app.use(cors(corsOptions));
app.use(express.json({ limit: '10mb' })); // 画像アップロード用に大きめに設定

// Static files (Frontend)
app.use(express.static(path.join(__dirname, 'public')));

// API routes
app.use('/api', apiRoutes);

// Health check endpoint (Cloud Run用)
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Serve the customer frontend from backend/public for root path
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({
    status: 'error',
    message: err.message || 'Internal Server Error'
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
});
