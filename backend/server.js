// SSL 인증서 검증 비활성화 (Cloudflare R2 연결용)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const express = require('express');
const cors    = require('cors');
const path    = require('path');
require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json());

// 프론트엔드 정적 파일 서빙
app.use(express.static(path.join(__dirname, 'frontend')));

// API 라우터 연결
app.use('/api/auth',    require('./routes/auth'));
app.use('/api/notes',   require('./routes/notes'));
app.use('/api/payment', require('./routes/payment'));
app.use('/api/admin',   require('./routes/admin'));

// 서버 상태 확인용 API
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// 모든 경로에서 index.html 반환
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(__dirname, 'frontend', 'index.html'));
});

// 에러 처리
app.use((err, req, res, next) => {
  console.error('서버 오류:', err.message);
  res.status(500).json({ error: '서버 오류가 발생했어요.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('노트마켓 서버 실행 중: http://localhost:' + PORT);
});
