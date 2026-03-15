const express = require('express');
const bcrypt  = require('bcrypt');
const jwt     = require('jsonwebtoken');
const { db, authenticate } = require('../middleware/auth');
const router  = express.Router();

// ── 회원가입 ──
// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { email, password, name, school, department } = req.body;

    if (!email || !password || !name || !school || !department)
      return res.status(400).json({ error: '모든 항목을 입력해주세요.' });

    if (password.length < 6)
      return res.status(400).json({ error: '비밀번호는 6자 이상이어야 해요.' });

    // 이미 있는 이메일인지 확인
    const existing = await db.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0)
      return res.status(400).json({ error: '이미 사용 중인 이메일이에요.' });

    // 비밀번호 암호화 저장 (절대 평문 저장 금지!)
    const hash = await bcrypt.hash(password, 12);

    const result = await db.query(
      `INSERT INTO users (email, password_hash, name, school, department)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, email, role, school, department, balance`,
      [email, hash, name, school, department]
    );

    const user = result.rows[0];
    const token = generateToken(user);

    res.json({ token, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '서버 오류가 발생했어요.' });
  }
});

// ── 로그인 ──
// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const result = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];

    if (!user)
      return res.status(401).json({ error: '이메일 또는 비밀번호가 올바르지 않아요.' });

    if (user.status === 'suspended')
      return res.status(401).json({ error: '정지된 계정이에요. 관리자에게 문의해주세요.' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok)
      return res.status(401).json({ error: '이메일 또는 비밀번호가 올바르지 않아요.' });

    const token = generateToken(user);
    res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role, school: user.school, department: user.department, balance: user.balance }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '서버 오류가 발생했어요.' });
  }
});

// ── 내 정보 조회 ──
// GET /api/auth/me
router.get('/me', authenticate, async (req, res) => {
  res.json({ user: req.user });
});

// ── 비밀번호 변경 ──
// PUT /api/auth/password
router.put('/password', authenticate, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const result = await db.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    const ok = await bcrypt.compare(currentPassword, result.rows[0].password_hash);
    if (!ok) return res.status(400).json({ error: '현재 비밀번호가 올바르지 않아요.' });
    if (newPassword.length < 6) return res.status(400).json({ error: '비밀번호는 6자 이상이어야 해요.' });
    const hash = await bcrypt.hash(newPassword, 12);
    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '서버 오류가 발생했어요.' });
  }
});

function generateToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role },
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: '7d' }
  );
}

module.exports = router;
