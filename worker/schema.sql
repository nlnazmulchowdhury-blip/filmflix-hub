-- FilmFlix on Cloudflare D1 (SQLite)
-- Apply:  npx wrangler d1 execute filmflix-hub --remote --file=./worker/schema.sql

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE,
  name          TEXT,
  role          TEXT,               -- 'admin' | 'member' | NULL
  is_anonymous  INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,     -- sha256 of the raw bearer token
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS otp_codes (
  email       TEXT NOT NULL,
  code        TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  used        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS categories (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS movies (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  description   TEXT,
  poster_url    TEXT,
  backdrop_url  TEXT,
  video_url     TEXT,
  genre         TEXT,
  category      TEXT,               -- legacy mirror of the first category
  categories    TEXT,               -- JSON array of names
  year          INTEGER,
  rating        REAL,
  kind          TEXT,               -- 'movie' | 'series'
  qualities     TEXT,               -- JSON [{label, videoUrl}]
  subtitles     TEXT,               -- JSON [{label, url}]
  episodes      TEXT,               -- JSON [{id,title,videoUrl,durationSec}]
  dubs          TEXT,               -- JSON [{label, videoUrl}]
  seasons       TEXT,               -- JSON [{id,title,episodes[]}]
  sort_order    INTEGER,
  contributor_id TEXT,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS screenings (
  id            TEXT PRIMARY KEY,
  movie_id      TEXT NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scheduled_for INTEGER NOT NULL,
  note          TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_screenings_user ON screenings(user_id);

CREATE TABLE IF NOT EXISTS comments (
  id          TEXT PRIMARY KEY,
  movie_id    TEXT NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_movie ON comments(movie_id);

CREATE TABLE IF NOT EXISTS orders (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan         TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  created_at   INTEGER NOT NULL,
  paid_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);

CREATE TABLE IF NOT EXISTS watchlist (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  movie_id    TEXT NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  UNIQUE(user_id, movie_id)
);

CREATE TABLE IF NOT EXISTS tv_channels (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  logo_url    TEXT,
  stream_url  TEXT NOT NULL,
  backup_urls TEXT,                 -- JSON array
  categories  TEXT,                 -- JSON array
  sort_order  INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS page_views (
  id          TEXT PRIMARY KEY,
  path        TEXT NOT NULL,
  movie_id    TEXT,
  user_id     TEXT,
  referrer    TEXT,
  device      TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_views_created ON page_views(created_at);
CREATE INDEX IF NOT EXISTS idx_views_path ON page_views(path);
CREATE INDEX IF NOT EXISTS idx_views_movie ON page_views(movie_id);

CREATE TABLE IF NOT EXISTS dub_jobs (
  id          TEXT PRIMARY KEY,
  movie_id    TEXT NOT NULL,
  movie_title TEXT NOT NULL,
  target_lang TEXT NOT NULL,
  status      TEXT NOT NULL,
  dubbing_id  TEXT,
  error       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dubs_movie ON dub_jobs(movie_id);

CREATE TABLE IF NOT EXISTS link_health (
  url         TEXT PRIMARY KEY,
  status      TEXT NOT NULL,        -- 'ok' | 'fail'
  http_status INTEGER,
  error       TEXT,
  checked_at  INTEGER NOT NULL,
  targets     TEXT NOT NULL         -- JSON [{kind,name,movieId,channelId}]
);

CREATE TABLE IF NOT EXISTS shortlinks (
  short_url   TEXT PRIMARY KEY,
  real_url    TEXT NOT NULL,
  resolved_at INTEGER NOT NULL
);