-- Click and lead history for the JAGG progress dashboard.
-- The Worker logs clicks here as they happen; leads are synced from AccuLynx.

CREATE TABLE IF NOT EXISTS clicks (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  slug      TEXT NOT NULL,
  ts        TEXT NOT NULL,            -- ISO8601 UTC
  day       TEXT NOT NULL,            -- YYYY-MM-DD, America/New_York
  city      TEXT,
  region    TEXT,
  country   TEXT,
  device    TEXT,                     -- mobile | desktop
  bot       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_clicks_day  ON clicks(day);
CREATE INDEX IF NOT EXISTS idx_clicks_slug ON clicks(slug);

CREATE TABLE IF NOT EXISTS leads (
  job_id      TEXT PRIMARY KEY,       -- AccuLynx job id
  created     TEXT NOT NULL,          -- ISO8601
  day         TEXT NOT NULL,
  lead_source TEXT,
  slug        TEXT,                   -- rtw_pid parsed from the job note
  town        TEXT,
  trade       TEXT,
  synced_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leads_day  ON leads(day);
CREATE INDEX IF NOT EXISTS idx_leads_slug ON leads(slug);
