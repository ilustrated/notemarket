const express = require('express');
const { db, authenticate } = require('../middleware/auth');
const router = express.Router();

// ── 결제 준비 (나이스페이 결제창 열기 전) ──
// POST /api/payment/prepare
router.post('/prepare', authenticate, async (req, res) => {
  try {
    const { noteId } = req.body;

    const note = await db.query("SELECT * FROM notes WHERE id=$1 AND status='live'", [noteId]);
    if (!note.rows[0]) return res.status(404).json({ error: '노트를 찾을 수 없어요.' });

    // 이미 구매한 노트인지 확인
    const dup = await db.query(
      "SELECT id FROM transactions WHERE note_id=$1 AND buyer_id=$2 AND status='completed'",
      [noteId, req.user.id]
    );
    if (dup.rows[0]) return res.status(400).json({ error: '이미 구매한 노트예요.' });

    const n = note.rows[0];
    const orderId = 'order_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const fee = Math.round(n.price * 0.1);
    const netAmount = n.price - fee;

    // 결제 전 DB에 pending 상태로 저장 (금액 위변조 방지)
    await db.query(`
      INSERT INTO transactions (order_id, buyer_id, buyer_name, note_id, seller_id, amount, fee, net_amount, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending')
    `, [orderId, req.user.id, req.user.name, noteId, n.seller_id, n.price, fee, netAmount]);

    res.json({
      orderId,
      amount: n.price,
      orderName: n.title,
      customerName: req.user.name,
      clientId: process.env.NICEPAY_CLIENT_ID,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '서버 오류가 발생했어요.' });
  }
});

// ── 결제 최종 승인 (나이스페이) ──
// POST /api/payment/confirm
router.post('/confirm', authenticate, async (req, res) => {
  try {
    const { tid, authToken, orderId, amount } = req.body;

    // DB에서 주문 확인 (금액 위변조 방지)
    const order = await db.query(
      "SELECT * FROM transactions WHERE order_id=$1 AND buyer_id=$2 AND status='pending'",
      [orderId, req.user.id]
    );
    if (!order.rows[0]) return res.status(400).json({ error: '주문 정보를 찾을 수 없어요.' });
    if (order.rows[0].amount !== amount)
      return res.status(400).json({ error: '결제 금액이 맞지 않아요.' });

    // 나이스페이 서버에 최종 승인 요청
    const niceResponse = await fetch(`https://api.nicepay.co.kr/v1/payments/${tid}`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(process.env.NICEPAY_CLIENT_ID + ':' + process.env.NICEPAY_SECRET_KEY).toString('base64'),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ authToken, amount }),
    });

    const niceResult = await niceResponse.json();
    if (niceResult.resultCode !== '0000') {
      await db.query("UPDATE transactions SET status='failed' WHERE order_id=$1", [orderId]);
      return res.status(400).json({ error: niceResult.resultMsg || '결제 승인에 실패했어요.' });
    }

    // 원자적 DB 업데이트 (트랜잭션)
    await db.query('BEGIN');
    try {
      await db.query(
        "UPDATE transactions SET status='completed', payment_key=$1 WHERE order_id=$2",
        [tid, orderId]
      );
      await db.query(
        'UPDATE notes SET download_count = download_count + 1 WHERE id=$1',
        [order.rows[0].note_id]
      );
      await db.query(
        'UPDATE users SET balance = balance + $1 WHERE id=$2',
        [order.rows[0].net_amount, order.rows[0].seller_id]
      );
      await db.query('COMMIT');
    } catch (e) {
      await db.query('ROLLBACK');
      throw e;
    }

    res.json({ success: true, transactionId: order.rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '서버 오류가 발생했어요.' });
  }
});

// ── 내 구매 내역 ──
// GET /api/payment/my
router.get('/my', authenticate, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT t.*, n.title AS note_title, n.school, n.subject
      FROM transactions t
      JOIN notes n ON n.id = t.note_id
      WHERE t.buyer_id=$1 AND t.status='completed'
      ORDER BY t.created_at DESC
    `, [req.user.id]);
    res.json({ transactions: result.rows });
  } catch (err) {
    res.status(500).json({ error: '서버 오류가 발생했어요.' });
  }
});

// ── NicePay 콜백 (결제 후 NicePay가 POST로 호출) ──
// POST /api/payment/nicepay-callback
router.post('/nicepay-callback', (req, res) => {
  const { authResultCode, authResultMsg, tid, orderId, amount, authToken } = req.body;
  const params = new URLSearchParams({
    authResultCode: authResultCode || '',
    authResultMsg: authResultMsg || '',
    tid: tid || '',
    orderId: orderId || '',
    amount: amount || 0,
    authToken: authToken || '',
  });
  res.redirect(303, `/payment-success.html?${params.toString()}`);
});

module.exports = router;
