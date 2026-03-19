const express = require('express');
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { db, authenticate } = require('../middleware/auth');

function getR2() {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
  });
}

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const client = new Anthropic();

// POST /api/ai/extract
// 이미지 또는 PDF를 받아 Claude로 필기 내용 추출
router.post('/extract', authenticate, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '파일이 필요해요.' });

  const { mimetype, buffer } = req.file;
  const base64 = buffer.toString('base64');

  let content;
  if (mimetype === 'application/pdf') {
    content = [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
      { type: 'text', text: '이 PDF의 내용을 빠짐없이 추출하고 깔끔하게 정리해주세요. 제목, 소제목, 본문 구조를 유지하되, 마크다운 기호(#, **, - 등) 없이 일반 텍스트로만 출력해주세요.' }
    ];
  } else {
    content = [
      { type: 'image', source: { type: 'base64', media_type: mimetype, data: base64 } },
      { type: 'text', text: '이 필기 이미지의 모든 내용을 빠짐없이 추출하고 깔끔하게 정리해주세요. 제목, 소제목, 본문 구조를 유지하되, 마크다운 기호(#, **, - 등) 없이 일반 텍스트로만 출력해주세요.' }
    ];
  }

  try {
    const response = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 8000,
      messages: [{ role: 'user', content }]
    });
    const text = response.content.find(b => b.type === 'text')?.text || '';
    res.json({ text });
  } catch (err) {
    console.error('AI extract error:', err);
    res.status(500).json({ error: 'AI 변환 중 오류가 발생했어요: ' + err.message });
  }
});

// POST /api/ai/qa
// 구매한 노트 파일을 Claude에 전달해 질문에 답변
router.post('/qa', authenticate, async (req, res) => {
  const { note_id, question } = req.body;
  if (!note_id || !question) return res.status(400).json({ error: '노트 ID와 질문이 필요해요.' });

  try {
    // 구매 여부 or 본인 노트 확인
    const [txRes, noteRes] = await Promise.all([
      db.query("SELECT id FROM transactions WHERE note_id=$1 AND buyer_id=$2 AND status='completed'", [note_id, req.user.id]),
      db.query('SELECT file_key, seller_id, title FROM notes WHERE id=$1', [note_id]),
    ]);
    const note = noteRes.rows[0];
    if (!note) return res.status(404).json({ error: '노트를 찾을 수 없어요.' });
    if (!txRes.rows[0] && note.seller_id !== req.user.id)
      return res.status(403).json({ error: '구매한 노트에만 질문할 수 있어요.' });

    // R2에서 파일 다운로드
    const r2 = getR2();
    const s3Res = await r2.send(new GetObjectCommand({ Bucket: process.env.R2_PRIVATE_BUCKET, Key: note.file_key }));
    const chunks = [];
    for await (const chunk of s3Res.Body) chunks.push(chunk);
    const base64 = Buffer.concat(chunks).toString('base64');

    // 파일 확장자로 타입 결정
    const ext = note.file_key.split('.').pop().toLowerCase();
    const isPDF = ext === 'pdf';
    const imgTypes = { jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', gif:'image/gif', webp:'image/webp' };
    const mimeType = isPDF ? 'application/pdf' : (imgTypes[ext] || 'image/jpeg');

    const source = isPDF
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
      : { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } };

    const response = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 2000,
      messages: [{ role: 'user', content: [source, { type: 'text', text: `이 노트를 참고해서 다음 질문에 답해주세요. 노트에 없는 내용이면 솔직하게 말해주세요.\n\n질문: ${question}` }] }],
    });

    const answer = response.content.find(b => b.type === 'text')?.text || '';
    res.json({ answer });
  } catch (err) {
    console.error('AI Q&A error:', err);
    res.status(500).json({ error: 'AI 답변 중 오류가 발생했어요: ' + err.message });
  }
});

module.exports = router;
