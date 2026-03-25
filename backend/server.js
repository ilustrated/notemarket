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
app.use('/api/ai',      require('./routes/ai'));
app.use('/api/study',   require('./routes/study'));

// 서버 상태 확인용 API
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// R2 연결 디버그 (배포 후 삭제 예정)
app.get('/api/debug-r2', async (req, res) => {
  const results = {};
  results.node = process.version;
  results.openssl = process.versions.openssl;

  const r2Endpoint = `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  results.endpoint = r2Endpoint;

  // 1) fetch 테스트
  try {
    const fRes = await fetch(r2Endpoint, { signal: AbortSignal.timeout(5000) });
    results.fetch = { ok: true, status: fRes.status };
  } catch (e) {
    results.fetch = { ok: false, error: e.cause?.code || e.code || e.message };
  }

  // 2) https 기본 테스트
  const https = require('https');
  try {
    await new Promise((resolve, reject) => {
      const req2 = https.get(r2Endpoint, (r) => { results.https_default = { ok: true, status: r.statusCode }; r.resume(); resolve(); });
      req2.on('error', e => { results.https_default = { ok: false, error: e.code || e.message }; resolve(); });
      req2.setTimeout(5000, () => { results.https_default = { ok: false, error: 'timeout' }; req2.destroy(); resolve(); });
    });
  } catch(e) {}

  // 3) https + TLS 1.2 강제
  try {
    await new Promise((resolve, reject) => {
      const agent = new https.Agent({ rejectUnauthorized: false, minVersion: 'TLSv1.2' });
      const req2 = https.get(r2Endpoint, { agent }, (r) => { results.https_tls12 = { ok: true, status: r.statusCode }; r.resume(); resolve(); });
      req2.on('error', e => { results.https_tls12 = { ok: false, error: e.code || e.message }; resolve(); });
      req2.setTimeout(5000, () => { results.https_tls12 = { ok: false, error: 'timeout' }; req2.destroy(); resolve(); });
    });
  } catch(e) {}

  // 4) https + secureProtocol 강제
  try {
    await new Promise((resolve, reject) => {
      const agent = new https.Agent({ rejectUnauthorized: false, secureProtocol: 'TLSv1_2_method' });
      const req2 = https.get(r2Endpoint, { agent }, (r) => { results.https_secureProto = { ok: true, status: r.statusCode }; r.resume(); resolve(); });
      req2.on('error', e => { results.https_secureProto = { ok: false, error: e.code || e.message }; resolve(); });
      req2.setTimeout(5000, () => { results.https_secureProto = { ok: false, error: 'timeout' }; req2.destroy(); resolve(); });
    });
  } catch(e) {}

  // 5) SDK 테스트
  try {
    const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');
    const { NodeHttpHandler } = require('@smithy/node-http-handler');
    const testR2 = new S3Client({
      region: 'auto',
      endpoint: r2Endpoint,
      credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
      forcePathStyle: true,
      requestHandler: new NodeHttpHandler({ httpsAgent: new https.Agent({ rejectUnauthorized: false, minVersion: 'TLSv1.2' }) }),
    });
    const d = await testR2.send(new ListObjectsV2Command({ Bucket: process.env.R2_PRIVATE_BUCKET, MaxKeys: 1 }));
    results.sdk = { ok: true, keyCount: d.KeyCount };
  } catch(e) {
    results.sdk = { ok: false, error: e.message?.substring(0, 200) };
  }

  res.json(results);
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
