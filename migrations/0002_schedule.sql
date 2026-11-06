-- Which placements have actually been queued in groupposting.com.
--
-- Shared rather than per-browser on purpose: Aaron and the VA work on
-- different machines, and the whole point is that each can see what the
-- other has already done.
CREATE TABLE IF NOT EXISTS placements_done (
  slug     TEXT PRIMARY KEY,
  done_at  TEXT NOT NULL,
  done_by  TEXT
);
