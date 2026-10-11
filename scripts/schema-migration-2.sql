-- Stage 4 prep: additive columns + tables for the Convex->D1 parity work
ALTER TABLE movies ADD COLUMN downloads TEXT;   -- JSON [{label,url}]
ALTER TABLE movies ADD COLUMN imdb_id TEXT;     -- VidSrc "Server 1" embed
ALTER TABLE movies ADD COLUMN tmdb_id TEXT;

CREATE TABLE IF NOT EXISTS support_messages (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender        TEXT NOT NULL CHECK (sender IN ('user','admin')),
  text          TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  seen_by_user  INTEGER NOT NULL DEFAULT 0,
  seen_by_admin INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_support_user ON support_messages(user_id, created_at);

CREATE TABLE IF NOT EXISTS tv_categories (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL
);
