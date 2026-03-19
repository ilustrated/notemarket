const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'frontend')));

// 각 라우트를 개별적으로 로드해서 하나가 실패해도 다른 게 작동하도록
try { app.use('/api/auth', require('./routes/auth')); } catch(e) { console.error('auth route error:', e.message); }
try { app.use('/api/notes', require('./routes/notes')); } catch(e) { console.error('notes route error:', e.message); }
try { app.use('/api/payment', require('./routes/payment')); } catch(e) { console.error('payment route error:', e.message); }
try { app.use('/api/admin', require('./routes/admin')); } catch(e) { console.error('admin route error:', e.message); }
try { app.use('/api/ai', require('./routes/ai')); } catch(e) { console.error('ai route error:', e.message); }
try { app.use('/api/study', require('./routes/study')); } catch(e) { console.error('study route error:', e.message); }

app.get('/api/envkeys', (req, res) => res.json({ keys: Object.keys(process.env).sort() }));

app.get('/api/health', (req, res) => res.json({
  status: 'ok',
  env: {
    db: !!process.env.DATABASE_URL,
    jwt: !!process.env.JWT_ACCESS_SECRET,
    r2: !!process.env.R2_ACCOUNT_ID,
    r2_public_url: process.env.R2_PUBLIC_URL || null,
    nicepay: !!process.env.NICEPAY_CLIENT_ID,
    google: !!process.env.GOOGLE_API_KEY,
  }
}));

app.use((req, res) => res.sendFile(path.join(__dirname, 'frontend', 'index.html')));

if (require.main === module) {
  app.listen(process.env.PORT || 3000, () => console.log('server running: http://localhost:3000'));
}

module.exports = app;
