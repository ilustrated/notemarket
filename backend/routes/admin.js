const express = require('express');
const { db, authenticate, requireAdmin } = require('../middleware/auth');
const router = express.Router();

// 모든 admin 라우트는 로그인 + 관리자 권한 필요
router.use(authenticate, requireAdmin);

// ── 대시보드 통계 ──
// GET /api/admin/dashboard
router.get('/dashboard', async (req, res) => {
  try {
    const [users, notes, reports, revenue, monthlyRevenue] = await Promise.all([
      db.query("SELECT COUNT(*) FROM users WHERE role != 'admin'"),
      db.query("SELECT COUNT(*) FILTER (WHERE status='live') AS live, COUNT(*) FILTER (WHERE status='removed') AS removed FROM notes"),
      db.query("SELECT COUNT(*) FILTER (WHERE status='pending') AS pending FROM reports"),
      db.query("SELECT COALESCE(SUM(fee),0) AS total FROM transactions WHERE status='completed'"),
      // 최근 6개월 수익
      db.query(`
        SELECT TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS month,
               COALESCE(SUM(fee), 0) AS fee
        FROM transactions
        WHERE status='completed' AND created_at > NOW() - INTERVAL '6 months'
        GROUP BY month ORDER BY month
      `),
    ]);

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    const totalSettleable = await db.query(`
      SELECT COALESCE(SUM(net_amount),0) AS amount
      FROM transactions
      WHERE status='completed' AND settled=false AND created_at < $1
    `, [cutoff]);

    res.json({
      stats: {
        users: parseInt(users.rows[0].count),
        live_notes: parseInt(notes.rows[0].live),
        removed_notes: parseInt(notes.rows[0].removed),
        pending_reports: parseInt(reports.rows[0].pending),
        total_revenue: parseInt(revenue.rows[0].total),
        total_settleable: parseInt(totalSettleable.rows[0].amount),
      },
      monthly_revenue: monthlyRevenue.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '서버 오류가 발생했어요.' });
  }
});

// ─────────────────────────────────────────
// 구매 로그
// ─────────────────────────────────────────

// GET /api/admin/transactions?filter=all|refundable|settled|refunded&q=
router.get('/transactions', async (req, res) => {
  try {
    const { filter = 'all', q = '', page = 1 } = req.query;
    const limit = 50;
    const offset = (page - 1) * limit;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);

    let where = [];
    const params = [];
    let pi = 1;

    if (filter === 'refundable') {
      where.push(`t.status='completed' AND t.settled=false`);
    } else if (filter === 'settled') {
      where.push(`t.settled=true AND t.status='completed'`);
    } else if (filter === 'refunded') {
      where.push(`t.status='refunded'`);
    } else if (filter === 'completed') {
      where.push(`t.status='completed'`);
    }

    if (q) {
      where.push(`(t.buyer_name ILIKE $${pi} OR n.title ILIKE $${pi} OR t.seller_name ILIKE $${pi})`);
      params.push(`%${q}%`); pi++;
    }

    const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

    const result = await db.query(`
      SELECT t.*, n.title AS note_title,
        CASE WHEN t.status='completed' AND t.settled=false THEN true ELSE false END AS is_refundable,
        CASE WHEN t.status='completed' AND t.settled=false AND t.created_at >= $${pi} THEN true ELSE false END AS is_locked
      FROM transactions t
      JOIN notes n ON n.id = t.note_id
      ${whereClause}
      ORDER BY t.created_at DESC
      LIMIT $${pi + 1} OFFSET $${pi + 2}
    `, [...params, cutoff, limit, offset]);

    res.json({ transactions: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '서버 오류가 발생했어요.' });
  }
});

// ── 환불 처리 ──
// POST /api/admin/transactions/:id/refund
router.post('/transactions/:id/refund', async (req, res) => {
  try {
    const tx = await db.query('SELECT * FROM transactions WHERE id=$1', [req.params.id]);
    if (!tx.rows[0]) return res.status(404).json({ error: '거래를 찾을 수 없어요.' });
    const t = tx.rows[0];
    if (t.status !== 'completed') return res.status(400).json({ error: '완료된 거래만 환불 가능해요.' });
    if (t.settled) return res.status(400).json({ error: '이미 정산된 거래는 환불 불가해요.' });

    await db.query('BEGIN');
    try {
      await db.query("UPDATE transactions SET status='refunded' WHERE id=$1", [req.params.id]);
      // 판매자 잔액 차감
      await db.query('UPDATE users SET balance = GREATEST(0, balance - $1) WHERE id=$2', [t.net_amount, t.seller_id]);
      await db.query('COMMIT');
    } catch (e) {
      await db.query('ROLLBACK');
      throw e;
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '서버 오류가 발생했어요.' });
  }
});

// ─────────────────────────────────────────
// 정산 관리
// ─────────────────────────────────────────

// GET /api/admin/settlement
router.get('/settlement', async (req, res) => {
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);

    const sellers = await db.query(`
      SELECT u.id, u.name, u.email, u.school, u.balance,
        COALESCE(SUM(t.net_amount) FILTER (WHERE t.status='completed' AND t.settled=false AND t.created_at < $1), 0) AS settleable,
        COALESCE(SUM(t.net_amount) FILTER (WHERE t.status='completed' AND t.settled=false AND t.created_at >= $1), 0) AS locked
      FROM users u
      LEFT JOIN transactions t ON t.seller_id = u.id
      WHERE u.role != 'admin'
      GROUP BY u.id
      HAVING COUNT(t.id) > 0
      ORDER BY settleable DESC
    `, [cutoff]);

    res.json({ sellers: sellers.rows, cutoff_days: 7 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '서버 오류가 발생했어요.' });
  }
});

// ── 판매자 정산 처리 ──
// POST /api/admin/settlement/:userId/process
router.post('/settlement/:userId/process', async (req, res) => {
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);

    const txs = await db.query(`
      SELECT t.id, t.net_amount
      FROM transactions t
      JOIN notes n ON n.id = t.note_id
      WHERE n.seller_id=$1 AND t.status='completed' AND t.settled=false AND t.created_at < $2
    `, [req.params.userId, cutoff]);

    if (!txs.rows.length) return res.status(400).json({ error: '정산 가능한 금액이 없어요.' });

    const totalAmount = txs.rows.reduce((s, t) => s + t.net_amount, 0);
    const txIds = txs.rows.map(t => t.id);

    await db.query('BEGIN');
    try {
      await db.query('UPDATE transactions SET settled=true WHERE id = ANY($1)', [txIds]);
      await db.query('UPDATE users SET balance = GREATEST(0, balance - $1) WHERE id=$2', [totalAmount, req.params.userId]);
      await db.query('COMMIT');
    } catch (e) {
      await db.query('ROLLBACK');
      throw e;
    }

    res.json({ success: true, settled_amount: totalAmount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '서버 오류가 발생했어요.' });
  }
});

// ─────────────────────────────────────────
// 신고 관리
// ─────────────────────────────────────────

// GET /api/admin/reports?status=pending|resolved
router.get('/reports', async (req, res) => {
  try {
    const { status } = req.query;
    let where = status ? `WHERE r.status = $1` : '';
    const params = status ? [status] : [];

    const result = await db.query(`
      SELECT r.*, n.title AS note_title, n.status AS note_status
      FROM reports r
      LEFT JOIN notes n ON n.id = r.note_id
      ${where}
      ORDER BY r.created_at DESC
    `, params);

    res.json({ reports: result.rows });
  } catch (err) {
    res.status(500).json({ error: '서버 오류가 발생했어요.' });
  }
});

// ── 신고 처리 ──
// PATCH /api/admin/reports/:id
// action: 'delete_note' | 'dismiss'
router.patch('/reports/:id', async (req, res) => {
  try {
    const { action } = req.body;
    const report = await db.query('SELECT * FROM reports WHERE id=$1', [req.params.id]);
    if (!report.rows[0]) return res.status(404).json({ error: '신고를 찾을 수 없어요.' });

    if (action === 'delete_note') {
      // 노트 삭제 + 관련 신고 모두 처리
      await db.query("UPDATE notes SET status='removed' WHERE id=$1", [report.rows[0].note_id]);
      await db.query("UPDATE reports SET status='resolved' WHERE note_id=$1", [report.rows[0].note_id]);
    } else if (action === 'dismiss') {
      await db.query("UPDATE reports SET status='resolved' WHERE id=$1", [req.params.id]);
    } else {
      return res.status(400).json({ error: '올바른 action을 입력해주세요.' });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '서버 오류가 발생했어요.' });
  }
});

// ─────────────────────────────────────────
// 노트 관리
// ─────────────────────────────────────────

// GET /api/admin/notes?status=live|removed&q=
router.get('/notes', async (req, res) => {
  try {
    const { status, q } = req.query;
    let where = [];
    const params = [];
    let pi = 1;
    if (status) { where.push(`n.status=$${pi++}`); params.push(status); }
    if (q)      { where.push(`n.title ILIKE $${pi++}`); params.push(`%${q}%`); }
    const wc = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const result = await db.query(`
      SELECT n.*, u.name AS seller_name,
        COUNT(r.id) FILTER (WHERE r.status='pending') AS pending_reports
      FROM notes n
      JOIN users u ON u.id = n.seller_id
      LEFT JOIN reports r ON r.note_id = n.id
      ${wc}
      GROUP BY n.id, u.name
      ORDER BY n.created_at DESC
    `, params);

    res.json({ notes: result.rows });
  } catch (err) {
    res.status(500).json({ error: '서버 오류가 발생했어요.' });
  }
});

// ── 노트 강제 삭제 ──
// DELETE /api/admin/notes/:id
router.delete('/notes/:id', async (req, res) => {
  try {
    await db.query("UPDATE notes SET status='removed' WHERE id=$1", [req.params.id]);
    await db.query("UPDATE reports SET status='resolved' WHERE note_id=$1", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '서버 오류가 발생했어요.' });
  }
});

// ─────────────────────────────────────────
// 사용자 관리
// ─────────────────────────────────────────

// GET /api/admin/users?q=
router.get('/users', async (req, res) => {
  try {
    const { q } = req.query;
    const params = [];
    let where = "WHERE u.role != 'admin'";
    if (q) { where += ` AND (u.name ILIKE $1 OR u.email ILIKE $1)`; params.push(`%${q}%`); }

    const result = await db.query(`
      SELECT u.id, u.name, u.email, u.role, u.status, u.school, u.department, u.balance, u.created_at,
        COUNT(DISTINCT n.id) AS note_count,
        COUNT(DISTINCT t.id) AS sale_count
      FROM users u
      LEFT JOIN notes n ON n.seller_id = u.id AND n.status = 'live'
      LEFT JOIN transactions t ON t.seller_id = u.id AND t.status = 'completed'
      ${where}
      GROUP BY u.id
      ORDER BY u.created_at DESC
    `, params);

    res.json({ users: result.rows });
  } catch (err) {
    res.status(500).json({ error: '서버 오류가 발생했어요.' });
  }
});

// ── 사용자 상태 변경 ──
// PATCH /api/admin/users/:id/status
router.patch('/users/:id/status', async (req, res) => {
  try {
    const { status } = req.body; // 'active' | 'suspended'
    await db.query('UPDATE users SET status=$1 WHERE id=$2', [status, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '서버 오류가 발생했어요.' });
  }
});

module.exports = router;
