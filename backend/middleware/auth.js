const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const db = new Pool({ connectionString: process.env.DATABASE_URL });

// 로그인 확인 미들웨어
// API에서 authenticate를 붙이면 로그인한 사용자만 접근 가능해져요
const authenticate = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '로그인이 필요해요.' });
  }

  const token = authHeader.replace('Bearer ', '');
  try {
    const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    // DB에서 최신 사용자 정보 확인 (정지된 계정 차단)
    const result = await db.query(
      'SELECT id, name, email, role, status, school, department, balance FROM users WHERE id = $1',
      [decoded.id]
    );
    if (!result.rows[0] || result.rows[0].status === 'suspended') {
      return res.status(401).json({ error: '접근 권한이 없어요.' });
    }
    req.user = result.rows[0];
    next();
  } catch (err) {
    return res.status(401).json({ error: '토큰이 유효하지 않아요. 다시 로그인해주세요.' });
  }
};

// 관리자 전용 미들웨어
const requireAdmin = (req, res, next) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: '관리자만 접근 가능해요.' });
  }
  next();
};

module.exports = { authenticate, requireAdmin, db };
