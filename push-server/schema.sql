CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reminders (
  device_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  fire_at INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (device_id, task_id)
);
CREATE INDEX IF NOT EXISTS reminders_fire_at ON reminders (fire_at);

-- 백업·동기화: 기기에서 암호화한 할 일 묶음 (서버는 내용을 읽을 수 없음)
CREATE TABLE IF NOT EXISTS spaces (
  id TEXT PRIMARY KEY,
  write_hash TEXT NOT NULL,
  blob TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Siri 단축어 등으로 들어온, 아직 앱이 가져가지 않은 할 일 문장
CREATE TABLE IF NOT EXISTS inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS inbox_space ON inbox (space_id);

CREATE TABLE IF NOT EXISTS ai_usage (
  device_id TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (device_id, day)
);
