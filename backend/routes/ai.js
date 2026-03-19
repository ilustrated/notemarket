const express = require('express');
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { db, authenticate } = require('../middleware/auth');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

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
// 프론트엔드가 R2에서 파일을 직접 받아 multipart로 전송 (서버→R2 SSL 문제 우회)
router.post('/qa', authenticate, upload.single('file'), async (req, res) => {
  const { note_id, question } = req.body;
  if (!note_id || !question) return res.status(400).json({ error: '노트 ID와 질문이 필요해요.' });
  if (!req.file) return res.status(400).json({ error: '파일이 필요해요.' });

  try {
    const [txRes, noteRes] = await Promise.all([
      db.query("SELECT id FROM transactions WHERE note_id=$1 AND buyer_id=$2 AND status='completed'", [note_id, req.user.id]),
      db.query('SELECT seller_id, title FROM notes WHERE id=$1', [note_id]),
    ]);
    const note = noteRes.rows[0];
    if (!note) return res.status(404).json({ error: '노트를 찾을 수 없어요.' });
    if (!txRes.rows[0] && note.seller_id !== req.user.id)
      return res.status(403).json({ error: '구매한 노트에만 질문할 수 있어요.' });

    const base64 = req.file.buffer.toString('base64');
    const mimeType = req.file.mimetype;

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
