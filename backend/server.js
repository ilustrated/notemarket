// SSL 인증서 검증 비활성화 (Cloudflare R2 연결용)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const express = require('express');
const cors    = require('cors');
require('dotenv').config();

const app = express();

// CORS 설정 (프론트엔드에서 API 호출 허용)
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'http://localhost:5500',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    // 배포 후 실제 도메인 추가: 'https://notemarket.co.kr'
  ],
  credentials: true
}));

app.use(express.json());

// API 라우터 연결
app.use('/api/auth',    require('./routes/auth'));
app.use('/api/notes',   require('./routes/notes'));
app.use('/api/payment', require('./routes/payment'));
app.use('/api/admin',   require('./routes/admin'));

// 서버 상태 확인용 API
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// 에러 처리
app.use((err, req, res, next) => {
  console.error('서버 오류:', err.message);
  res.status(500).json({ error: '서버 오류가 발생했어요.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`노트마켓 서버 실행 중: http://localhost:${PORT}`);
});
