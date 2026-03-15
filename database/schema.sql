-- =====================================================
-- 노트마켓 데이터베이스 스키마
-- Supabase SQL Editor에 이 내용을 전체 복붙하고 실행하세요
-- =====================================================

-- 사용자 테이블
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name          VARCHAR(100) NOT NULL,
  role          VARCHAR(20)  DEFAULT 'user',      -- 'user' 또는 'admin'
  status        VARCHAR(20)  DEFAULT 'active',    -- 'active', 'suspended'
  school        VARCHAR(100),
  department    VARCHAR(100),
  balance       INTEGER      DEFAULT 0,           -- 정산 대기 잔액 (원)
  created_at    TIMESTAMPTZ  DEFAULT now()
);

-- 노트 테이블
CREATE TABLE IF NOT EXISTS notes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id      UUID NOT NULL REFERENCES users(id),
  title          VARCHAR(200) NOT NULL,
  school         VARCHAR(100),
  department     VARCHAR(100),
  professor      VARCHAR(100),
  subject        VARCHAR(100),
  semester       VARCHAR(50),
  price          INTEGER      NOT NULL CHECK (price >= 1000),
  description    TEXT,
  file_key       VARCHAR(500),                    -- R2 원본 PDF 경로
  preview_key    VARCHAR(500),                    -- R2 미리보기 이미지 경로
  status         VARCHAR(20)  DEFAULT 'live',     -- 'live', 'removed'
  download_count INTEGER      DEFAULT 0,
  created_at     TIMESTAMPTZ  DEFAULT now()
);

-- 검색 성능을 위한 인덱스
CREATE INDEX IF NOT EXISTS idx_notes_school      ON notes(school);
CREATE INDEX IF NOT EXISTS idx_notes_department  ON notes(department);
CREATE INDEX IF NOT EXISTS idx_notes_subject     ON notes(subject);
CREATE INDEX IF NOT EXISTS idx_notes_status      ON notes(status);
CREATE INDEX IF NOT EXISTS idx_notes_seller      ON notes(seller_id);

-- 거래 테이블
CREATE TABLE IF NOT EXISTS transactions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     VARCHAR(100) UNIQUE,               -- 토스 주문 ID
  payment_key  VARCHAR(200),                      -- 토스 결제 키
  buyer_id     UUID NOT NULL REFERENCES users(id),
  buyer_name   VARCHAR(100),
  note_id      UUID NOT NULL REFERENCES notes(id),
  seller_id    UUID NOT NULL REFERENCES users(id),
  seller_name  VARCHAR(100),
  amount       INTEGER NOT NULL,                  -- 결제 금액
  fee          INTEGER NOT NULL,                  -- 플랫폼 수수료 (20%)
  net_amount   INTEGER NOT NULL,                  -- 판매자 정산액 (80%)
  status       VARCHAR(20) DEFAULT 'pending',     -- 'pending', 'completed', 'failed', 'refunded'
  settled      BOOLEAN     DEFAULT false,         -- 정산 처리 여부
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tx_buyer    ON transactions(buyer_id);
CREATE INDEX IF NOT EXISTS idx_tx_note     ON transactions(note_id);
CREATE INDEX IF NOT EXISTS idx_tx_seller   ON transactions(seller_id);
CREATE INDEX IF NOT EXISTS idx_tx_status   ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_tx_settled  ON transactions(settled);

-- 리뷰 테이블
CREATE TABLE IF NOT EXISTS reviews (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id       UUID NOT NULL REFERENCES notes(id),
  buyer_id      UUID NOT NULL REFERENCES users(id),
  reviewer_name VARCHAR(100),
  rating        INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  content       TEXT,
  created_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE(note_id, buyer_id)                       -- 1인 1리뷰
);

-- 신고 테이블
CREATE TABLE IF NOT EXISTS reports (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id       UUID NOT NULL REFERENCES notes(id),
  note_title    VARCHAR(200),
  reporter_id   UUID NOT NULL REFERENCES users(id),
  reporter_name VARCHAR(100),
  type          VARCHAR(50) NOT NULL,             -- 'copyright', 'lowquality', 'inappropriate', 'duplicate', 'other'
  detail        TEXT,
  status        VARCHAR(20) DEFAULT 'pending',    -- 'pending', 'resolved'
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reports_note   ON reports(note_id);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);

-- =====================================================
-- 관리자 계정 생성
-- 아래 비밀번호 해시는 "admin1234"의 bcrypt 해시예요
-- 실제 서비스에서는 반드시 변경하세요!
-- =====================================================
INSERT INTO users (email, password_hash, name, role, status)
VALUES (
  'admin@notemarket.kr',
  '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewdBPj/QUBo9FJIG',
  '관리자',
  'admin',
  'active'
)
ON CONFLICT (email) DO NOTHING;

-- =====================================================
-- 완료! Table Editor에서 users, notes, transactions,
-- reviews, reports 테이블이 보이면 성공이에요.
-- =====================================================
