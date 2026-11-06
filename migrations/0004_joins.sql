-- Which groups the VA has sent a join request to. Shared, like the posting
-- checklist, so two people working the list do not duplicate each other.
CREATE TABLE IF NOT EXISTS group_joins (
  gid      TEXT PRIMARY KEY,
  status   TEXT NOT NULL,
  done_at  TEXT NOT NULL,
  done_by  TEXT
);
