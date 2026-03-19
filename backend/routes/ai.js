const express = require('express');
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { db, authenticate } = require('../middleware/auth');

const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
});

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

// R2에서 SDK로 직접 파일 읽기 (presigned URL + http 클라이언트 없이)
async function getFileFromR2(key) {
  const response = await r2.send(new GetObjectCommand({
    Bucket: process.env.R2_PRIVATE_BUCKET,
    Key: key,
  }));
  const chunks = [];
  for await (const chunk of response.Body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return { buffer: Buffer.concat(chunks), contentType: response.ContentType };
}

// POST /api/ai/extract
router.post('/extract', authenticate, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '파일이 필요해요.' });

  const { mimetype, buffer } = req.file;
  const base64 = buffer.toString('base64');

  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });
    const prompt = mimetype === 'application/pdf'
      ? 'PDF의 내용을 빠짐없이 추출하고 깔끔하게 정리해주세요. 제목, 소제목, 본문 구조를 유지하되, 마크다운 기호(#, **, - 등) 없이 일반 텍스트로만 출력해주세요.'
      : '이 필기 이미지의 모든 내용을 빠짐없이 추출하고 깔끔하게 정리해주세요. 제목, 소제목, 본문 구조를 유지하되, 마크다운 기호(#, **, - 등) 없이 일반 텍스트로만 출력해주세요.';

    const result = await model.generateContent([
      { inlineData: { data: base64, mimeType: mimetype } },
      prompt,
    ]);
    res.json({ text: result.response.text() });
  } catch (err) {
    console.error('AI extract error:', err);
    res.status(500).json({ error: 'AI 변환 중 오류가 발생했어요: ' + err.message });
  }
});

// POST /api/ai/qa
router.post('/qa', authenticate, async (req, res) => {
  const { note_id, question } = req.body;
  if (!note_id || !question) return res.status(400).json({ error: '노트 ID와 질문이 필요해요.' });

  try {
    const [txRes, noteRes] = await Promise.all([
      db.query("SELECT id FROM transactions WHERE note_id=$1 AND buyer_id=$2 AND status='completed'", [note_id, req.user.id]),
      db.query('SELECT file_key, seller_id, title FROM notes WHERE id=$1', [note_id]),
    ]);
    const note = noteRes.rows[0];
    if (!note) return res.status(404).json({ error: '노트를 찾을 수 없어요.' });
    if (!txRes.rows[0] && note.seller_id !== req.user.id)
      return res.status(403).json({ error: '구매한 노트에만 질문할 수 있어요.' });

    // SDK로 직접 R2에서 파일 읽기 (presigned URL 불필요)
    const { buffer: fileBuffer } = await getFileFromR2(note.file_key);
    const base64 = fileBuffer.toString('base64');
    const ext = note.file_key.split('.').pop().toLowerCase();
    const imgTypes = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
    const mimeType = ext === 'pdf' ? 'application/pdf' : (imgTypes[ext] || 'image/jpeg');

    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });
    const result = await model.generateContent([
      { inlineData: { data: base64, mimeType } },
      `이 노트를 참고해서 다음 질문에 답해주세요. 노트에 없는 내용이면 솔직하게 말해주세요.\n\n질문: ${question}`,
    ]);

    res.json({ answer: result.response.text() });
  } catch (err) {
    console.error('AI Q&A error:', err);
    res.status(500).json({ error: 'AI 답변 중 오류가 발생했어요: ' + err.message });
  }
});

module.exports = router;
