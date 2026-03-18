const express  = require('express');
const multer   = require('multer');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { db, authenticate, requireAdmin } = require('../middleware/auth');
const router = express.Router();

const upload = multer({ storage: multer.memoryStorage() });

const https = require('https');
const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
  requestHandler: {
    httpsAgent: new https.Agent({ rejectUnauthorized: false })
  }
});


// ── 노트 목록 조회 (검색/필터) ──
// GET /api/notes?school=&dept=&kw=&sort=latest&page=1
router.get('/', async (req, res) => {
  try {
    const { school, dept, kw, sort = 'latest', page = 1 } = req.query;
    const limit = 20;
    const offset = (page - 1) * limit;

    let where = ["n.status = 'live'"];
    const params = [];
    let pi = 1;

    if (school) { where.push(`n.school ILIKE $${pi++}`); params.push(`%${school}%`); }
    if (dept)   { where.push(`n.department ILIKE $${pi++}`); params.push(`%${dept}%`); }
    if (kw)     {
      where.push(`(n.subject ILIKE $${pi} OR n.title ILIKE $${pi} OR n.professor ILIKE $${pi})`);
      params.push(`%${kw}%`); pi++;
    }

    const orderMap = {
      latest:   'n.created_at DESC',
      popular:  'n.download_count DESC',
      priceLow: 'n.price ASC',
    };
    const order = orderMap[sort] || 'n.created_at DESC';

    const sql = `
      SELECT n.*, u.name AS seller_name,
        COALESCE(AVG(r.rating), 0) AS avg_rating,
        COUNT(r.id) AS review_count
      FROM notes n
      JOIN users u ON u.id = n.seller_id
      LEFT JOIN reviews r ON r.note_id = n.id
      WHERE ${where.join(' AND ')}
      GROUP BY n.id, u.name
      ORDER BY ${order}
      LIMIT $${pi} OFFSET $${pi + 1}
    `;
    params.push(limit, offset);

    const result = await db.query(sql, params);
    res.json({ notes: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '서버 오류가 발생했어요.' });
  }
});

// ── 노트 상세 조회 ──
// GET /api/notes/:id
// 관리자는 삭제된 노트도 조회 가능
router.get('/:id', async (req, res) => {
  try {
    // 요청한 사람이 관리자인지 확인
    let isAdmin = false;
    const authHeader = req.headers.authorization;
    if (authHeader) {
      try {
        const jwt = require('jsonwebtoken');
        const decoded = jwt.verify(authHeader.replace('Bearer ', ''), process.env.JWT_ACCESS_SECRET);
        const userRes = await db.query('SELECT role FROM users WHERE id = $1', [decoded.id]);
        isAdmin = userRes.rows[0]?.role === 'admin';
      } catch {}
    }

    const statusFilter = isAdmin ? "n.status IN ('live','removed')" : "n.status = 'live'";

    const result = await db.query(`
      SELECT n.*, u.name AS seller_name, u.school AS seller_school,
        COALESCE(AVG(r.rating), 0) AS avg_rating,
        COUNT(DISTINCT r.id) AS review_count,
        COALESCE(
          JSON_AGG(
            JSON_BUILD_OBJECT('name', r.reviewer_name, 'rating', r.rating, 'content', r.content, 'created_at', r.created_at)
            ORDER BY r.created_at DESC
          ) FILTER (WHERE r.id IS NOT NULL), '[]'
        ) AS reviews
      FROM notes n
      JOIN users u ON u.id = n.seller_id
      LEFT JOIN reviews r ON r.note_id = n.id
      WHERE n.id = $1 AND ${statusFilter}
      GROUP BY n.id, u.name, u.school
    `, [req.params.id]);

    if (!result.rows[0]) return res.status(404).json({ error: '노트를 찾을 수 없어요.' });
    res.json({ note: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '서버 오류가 발생했어요.' });
  }
});

// ── PDF 업로드 URL 발급 ──
// POST /api/notes/upload-url
router.post('/upload', authenticate, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '파일을 선택해주세요.' });
    
    const key = `notes/${req.user.id}/${Date.now()}_${req.file.originalname}`;
    
    await r2.send(new PutObjectCommand({
      Bucket: process.env.R2_PRIVATE_BUCKET,
      Key: key,
      Body: req.file.buffer,
      ContentType: 'application/pdf',
    }));

    res.json({ key });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '파일 업로드 실패: ' + err.message });
  }
});

// ── 노트 등록 (업로드 완료 후 호출) ──
// POST /api/notes
router.post('/', authenticate, async (req, res) => {
  try {
    const { title, school, department, professor, subject, semester, price, description, file_key } = req.body;

    if (!title || !price || !file_key)
      return res.status(400).json({ error: '제목, 가격, 파일은 필수예요.' });

    const result = await db.query(`
      INSERT INTO notes (seller_id, title, school, department, professor, subject, semester, price, description, file_key, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'live')
      RETURNING *
    `, [req.user.id, title, school, department, professor, subject, semester, price, description, file_key]);

    res.json({ note: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '서버 오류가 발생했어요.' });
  }
});

// ── 내 노트 삭제 (본인만 가능) ──
// DELETE /api/notes/:id
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, seller_id FROM notes WHERE id = $1', [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: '노트를 찾을 수 없어요.' });
    if (result.rows[0].seller_id !== req.user.id && req.user.role !== 'admin')
      return res.status(403).json({ error: '삭제 권한이 없어요.' });

    await db.query("UPDATE notes SET status = 'removed' WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '서버 오류가 발생했어요.' });
  }
});

// ── 다운로드 URL 발급 (구매자 확인 후) ──
// GET /api/notes/:id/download
router.get('/:id/download', authenticate, async (req, res) => {
  try {
    // 구매 내역 확인
    const tx = await db.query(
      "SELECT id FROM transactions WHERE note_id=$1 AND buyer_id=$2 AND status='completed'",
      [req.params.id, req.user.id]
    );
    // 관리자는 구매 없이도 다운로드 가능
    if (!tx.rows[0] && req.user.role !== 'admin')
      return res.status(403).json({ error: '구매 후 다운로드할 수 있어요.' });

    const note = await db.query('SELECT file_key FROM notes WHERE id = $1', [req.params.id]);
    if (!note.rows[0]) return res.status(404).json({ error: '노트를 찾을 수 없어요.' });

    // 6시간 유효 다운로드 URL 발급
    const downloadUrl = await getSignedUrl(r2, new GetObjectCommand({
      Bucket: process.env.R2_PRIVATE_BUCKET,
      Key: note.rows[0].file_key,
    }), { expiresIn: 21600 });

    res.json({ downloadUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '서버 오류가 발생했어요.' });
  }
});

// ── 리뷰 작성 (구매자만 가능) ──
// POST /api/notes/:id/reviews
router.post('/:id/reviews', authenticate, async (req, res) => {
  try {
    const { rating, content } = req.body;
    if (!rating || rating < 1 || rating > 5)
      return res.status(400).json({ error: '평점은 1~5 사이여야 해요.' });

    // 구매 확인
    const tx = await db.query(
      "SELECT id FROM transactions WHERE note_id=$1 AND buyer_id=$2 AND status='completed'",
      [req.params.id, req.user.id]
    );
    if (!tx.rows[0]) return res.status(403).json({ error: '구매한 노트에만 리뷰를 작성할 수 있어요.' });

    // 중복 리뷰 방지
    const dup = await db.query('SELECT id FROM reviews WHERE note_id=$1 AND buyer_id=$2', [req.params.id, req.user.id]);
    if (dup.rows[0]) return res.status(400).json({ error: '이미 리뷰를 작성하셨어요.' });

    await db.query(
      'INSERT INTO reviews (note_id, buyer_id, reviewer_name, rating, content) VALUES ($1,$2,$3,$4,$5)',
      [req.params.id, req.user.id, req.user.name, rating, content]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '서버 오류가 발생했어요.' });
  }
});

// ── 노트 신고 ──
// POST /api/notes/:id/report
router.post('/:id/report', authenticate, async (req, res) => {
  try {
    const { type, detail } = req.body;
    if (!type) return res.status(400).json({ error: '신고 유형을 선택해주세요.' });

    // 중복 신고 방지
    const dup = await db.query(
      "SELECT id FROM reports WHERE note_id=$1 AND reporter_id=$2 AND status='pending'",
      [req.params.id, req.user.id]
    );
    if (dup.rows[0]) return res.status(400).json({ error: '이미 신고한 노트예요.' });

    const note = await db.query('SELECT title FROM notes WHERE id = $1', [req.params.id]);
    await db.query(
      'INSERT INTO reports (note_id, note_title, reporter_id, reporter_name, type, detail) VALUES ($1,$2,$3,$4,$5,$6)',
      [req.params.id, note.rows[0]?.title, req.user.id, req.user.name, type, detail]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '서버 오류가 발생했어요.' });
  }
});

// ── 내 판매 현황 ──
// GET /api/notes/seller/dashboard
router.get('/seller/dashboard', authenticate, async (req, res) => {
  try {
    const notes = await db.query(`
      SELECT n.*, COUNT(DISTINCT t.id) AS sale_count,
        COALESCE(SUM(t.net_amount) FILTER (WHERE t.status='completed'), 0) AS total_earned
      FROM notes n
      LEFT JOIN transactions t ON t.note_id = n.id
      WHERE n.seller_id = $1
      GROUP BY n.id
      ORDER BY n.created_at DESC
    `, [req.user.id]);

    const txs = await db.query(`
      SELECT t.*, n.title AS note_title
      FROM transactions t
      JOIN notes n ON n.id = t.note_id
      WHERE n.seller_id = $1
      ORDER BY t.created_at DESC
      LIMIT 20
    `, [req.user.id]);

    // 정산 가능 금액 (거래일로부터 7일 경과, 미정산)
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    const settleable = await db.query(`
      SELECT COALESCE(SUM(t.net_amount), 0) AS amount
      FROM transactions t
      JOIN notes n ON n.id = t.note_id
      WHERE n.seller_id=$1 AND t.status='completed' AND t.settled=false AND t.created_at < $2
    `, [req.user.id, cutoff]);

    const locked = await db.query(`
      SELECT COALESCE(SUM(t.net_amount), 0) AS amount
      FROM transactions t
      JOIN notes n ON n.id = t.note_id
      WHERE n.seller_id=$1 AND t.status='completed' AND t.settled=false AND t.created_at >= $2
    `, [req.user.id, cutoff]);

    res.json({
      notes: notes.rows,
      transactions: txs.rows,
      settleable_amount: parseInt(settleable.rows[0].amount),
      locked_amount: parseInt(locked.rows[0].amount),
      balance: req.user.balance,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '서버 오류가 발생했어요.' });
  }
});

module.exports = router;
