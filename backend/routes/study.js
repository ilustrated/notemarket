const express = require('express');
const https   = require('https');
const multer  = require('multer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { NodeHttpHandler } = require('@smithy/node-http-handler');
const { db, authenticate } = require('../middleware/auth');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Cloudflare R2 클라이언트 설정 (TLS 1.2 강제 지정)
const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
  requestHandler: new NodeHttpHandler({
    httpsAgent: new https.Agent({
      rejectUnauthorized: false,
      minVersion: 'TLSv1.2',
    }),
  }),
});

// ── 구매 확인 헬퍼 ──
async function hasPurchased(noteId, userId) {
  const tx = await db.query(
    "SELECT id FROM transactions WHERE note_id=$1 AND buyer_id=$2 AND status='completed'",
    [noteId, userId]
  );
  return !!tx.rows[0];
}

async function isSeller(noteId, userId) {
  const note = await db.query('SELECT seller_id FROM notes WHERE id=$1', [noteId]);
  return note.rows[0]?.seller_id === userId;
}

// ── GET /api/study/:noteId/members ──
// 스터디 그룹 멤버 목록 (인증 + 구매 or 판매자)
router.get('/:noteId/members', authenticate, async (req, res) => {
  try {
    const { noteId } = req.params;
    const userId = req.user.id;

    const sellerCheck = await isSeller(noteId, userId);
    const purchasedCheck = await hasPurchased(noteId, userId);
    const isAdmin = req.user.role === 'admin';

    if (!sellerCheck && !purchasedCheck && !isAdmin) {
      return res.status(403).json({ error: '구매 후 스터디 그룹을 확인할 수 있어요.' });
    }

    const result = await db.query(`
      SELECT u.name, u.school, u.department, sgm.contact, sgm.joined_at,
        (sgm.user_id = $2) AS is_me
      FROM study_group_members sgm
      JOIN users u ON u.id = sgm.user_id
      WHERE sgm.note_id = $1
      ORDER BY sgm.joined_at ASC
    `, [noteId, userId]);

    const joinedCheck = await db.query(
      'SELECT id FROM study_group_members WHERE note_id=$1 AND user_id=$2',
      [noteId, userId]
    );

    res.json({
      members: result.rows,
      joined: !!joinedCheck.rows[0],
      count: result.rows.length,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '서버 오류가 발생했어요.' });
  }
});

// ── POST /api/study/:noteId/join ──
// 스터디 그룹 참여 (인증 + 구매)
router.post('/:noteId/join', authenticate, async (req, res) => {
  try {
    const { noteId } = req.params;
    const userId = req.user.id;
    const { contact } = req.body;

    const purchased = await hasPurchased(noteId, userId);
    const seller = await isSeller(noteId, userId);
    if (!purchased && !seller) {
      return res.status(403).json({ error: '구매 후 스터디 그룹에 참여할 수 있어요.' });
    }

    await db.query(`
      INSERT INTO study_group_members (note_id, user_id, contact)
      VALUES ($1, $2, $3)
      ON CONFLICT (note_id, user_id) DO UPDATE SET contact = EXCLUDED.contact
    `, [noteId, userId, contact || null]);

    const countResult = await db.query(
      'SELECT COUNT(*) FROM study_group_members WHERE note_id=$1',
      [noteId]
    );

    res.json({ success: true, count: parseInt(countResult.rows[0].count) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '서버 오류가 발생했어요.' });
  }
});

// ── DELETE /api/study/:noteId/leave ──
// 스터디 그룹 탈퇴 (인증)
router.delete('/:noteId/leave', authenticate, async (req, res) => {
  try {
    const { noteId } = req.params;
    await db.query(
      'DELETE FROM study_group_members WHERE note_id=$1 AND user_id=$2',
      [noteId, req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '서버 오류가 발생했어요.' });
  }
});

// ── GET /api/study/:noteId/grade-badge ──
// 성적 인증 배지 조회 (공개)
router.get('/:noteId/grade-badge', async (req, res) => {
  try {
    const result = await db.query(
      "SELECT grade, status FROM grade_badges WHERE note_id=$1 AND status='approved' ORDER BY created_at DESC LIMIT 1",
      [req.params.noteId]
    );
    res.json({ badge: result.rows[0] || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '서버 오류가 발생했어요.' });
  }
});

// ── POST /api/study/:noteId/grade-badge ──
// 성적 인증 신청 (인증 + 판매자)
router.post('/:noteId/grade-badge', authenticate, upload.single('screenshot'), async (req, res) => {
  try {
    const { noteId } = req.params;
    const { grade } = req.body;

    if (!grade) return res.status(400).json({ error: '학점을 입력해주세요.' });
    if (!req.file) return res.status(400).json({ error: '스크린샷 파일이 필요해요.' });

    // 판매자 확인
    const seller = await isSeller(noteId, req.user.id);
    if (!seller && req.user.role !== 'admin') {
      return res.status(403).json({ error: '본인의 노트에만 성적 인증을 신청할 수 있어요.' });
    }

    // R2 업로드
    const ext = (req.file.originalname || 'screenshot.jpg').split('.').pop();
    const key = `grade-badges/${req.user.id}/${noteId}/${Date.now()}.${ext}`;
    await r2.send(new PutObjectCommand({
      Bucket: process.env.R2_PRIVATE_BUCKET,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype || 'image/jpeg',
    }));

    await db.query(
      'INSERT INTO grade_badges (note_id, seller_id, screenshot_key, grade) VALUES ($1, $2, $3, $4)',
      [noteId, req.user.id, key, grade]
    );

    res.json({ success: true, message: '성적 인증 신청이 완료되었어요. 관리자 검토 후 승인됩니다.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '서버 오류가 발생했어요.' });
  }
});

module.exports = router;
