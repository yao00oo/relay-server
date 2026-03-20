CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  task_type TEXT NOT NULL,
  content TEXT NOT NULL,
  from_nickname TEXT DEFAULT '',
  ts INTEGER NOT NULL,
  delivered INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS devices (
  user_id TEXT PRIMARY KEY,
  version TEXT DEFAULT 'unknown',
  last_seen INTEGER NOT NULL,
  first_seen INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bottles (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL,
  from_nickname TEXT DEFAULT '',
  content TEXT NOT NULL,
  ts INTEGER NOT NULL,
  picked INTEGER DEFAULT 0,
  picked_by TEXT
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_id, delivered);
CREATE INDEX IF NOT EXISTS idx_bottles_pick ON bottles(picked, from_id);
