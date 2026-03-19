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

// DB 테이블 자동 생성 후 서버 시작
async function initTables() {
  const { db } = require('./middleware/auth');
  await db.query(`CREATE TABLE IF NOT EXISTS grade_badges (
    id SERIAL PRIMARY KEY,
    note_id INTEGER NOT NULL,
    seller_id INTEGER NOT NULL,
    screenshot_key TEXT NOT NULL,
    grade TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    admin_note TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS study_group_members (
    id SERIAL PRIMARY KEY,
    note_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    contact TEXT,
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(note_id, user_id)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS exam_analyses (
    id SERIAL PRIMARY KEY,
    note_id INTEGER NOT NULL,
    analysis TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  console.log('DB tables initialized');
}

if (require.main === module) {
  initTables()
    .then(() => {
      app.listen(process.env.PORT || 3000, () => console.log('server running: http://localhost:3000'));
    })
    .catch(e => {
      console.error('initTables failed:', e.message);
      app.listen(process.env.PORT || 3000, () => console.log('server running: http://localhost:3000'));
    });
}

module.exports = app;
