const express = require('express');
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { db, authenticate } = require('../middleware/auth');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

// R2 공개 URL로 파일 읽기
async function getFileFromR2(key) {
  const publicUrl = process.env.R2_PUBLIC_URL || 'https://pub-4d66a8676c2e4bc2b3c13d3ce03e2152.r2.dev';
  const r2Res = await fetch(`${publicUrl}/${key}`);
  if (!r2Res.ok) throw new Error(`파일 다운로드 실패: ${r2Res.status}`);
  const buffer = Buffer.from(await r2Res.arrayBuffer());
  const contentType = r2Res.headers.get('content-type') || 'application/octet-stream';
  return { buffer, contentType };
}

// POST /api/ai/extract
router.post('/extract', authenticate, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '파일이 필요해요.' });

  const { mimetype, buffer } = req.file;
  const base64 = buffer.toString('base64');

  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
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

    // R2 공개 URL로 파일 읽기
    const { buffer: fileBuffer } = await getFileFromR2(note.file_key);
    const base64 = fileBuffer.toString('base64');
    const ext = note.file_key.split('.').pop().toLowerCase();
    const imgTypes = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
    const mimeType = ext === 'pdf' ? 'application/pdf' : (imgTypes[ext] || 'image/jpeg');

    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
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

// ── POST /api/ai/exam-analysis ──
// 기출문제 분석 (인증 + 판매자)
router.post('/exam-analysis', authenticate, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '파일이 필요해요.' });
  const { note_id } = req.body;
  if (!note_id) return res.status(400).json({ error: 'note_id가 필요해요.' });

  try {
    // 판매자 소유 확인
    const noteRes = await db.query('SELECT seller_id FROM notes WHERE id=$1', [note_id]);
    if (!noteRes.rows[0]) return res.status(404).json({ error: '노트를 찾을 수 없어요.' });
    if (noteRes.rows[0].seller_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: '본인의 노트에만 분석을 업로드할 수 있어요.' });
    }

    const { mimetype, buffer } = req.file;
    const base64 = buffer.toString('base64');
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const prompt = '이 기출문제를 분석해서 교수님의 출제 경향을 분석해주세요:\n\n📊 출제 유형 분포 (퍼센트로)\n🎯 자주 나오는 토픽 (상위 5개)\n💡 시험 준비 전략\n⚠️ 주의할 점\n\n마크다운 기호(#, **, - 등) 없이 일반 텍스트로 작성해주세요.';

    const result = await model.generateContent([
      { inlineData: { data: base64, mimeType: mimetype } },
      prompt,
    ]);
    const analysis = result.response.text();

    await db.query(
      'INSERT INTO exam_analyses (note_id, analysis) VALUES ($1, $2)',
      [note_id, analysis]
    );

    res.json({ analysis });
  } catch (err) {
    console.error('AI exam-analysis error:', err);
    res.status(500).json({ error: 'AI 분석 중 오류가 발생했어요: ' + err.message });
  }
});

// ── GET /api/ai/exam-analysis/:noteId ──
// 기출문제 분석 조회 (공개)
router.get('/exam-analysis/:noteId', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT analysis, created_at FROM exam_analyses WHERE note_id=$1 ORDER BY created_at DESC LIMIT 1',
      [req.params.noteId]
    );
    const row = result.rows[0];
    res.json({ analysis: row ? row.analysis : null, updated_at: row ? row.created_at : null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '서버 오류가 발생했어요.' });
  }
});

module.exports = router;
