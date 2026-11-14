-- How far each visit got through the quote form.
--
-- 76 people clicked through from Facebook and none submitted, and we could not
-- say whether they bounced on sight or gave up at the address field. One row
-- per visit per step reached, upserted so a visit that reaches step 4 leaves
-- four rows and not forty.
--
-- Deliberately holds NO field values: not the name, phone, email or address.
-- Only which step number was reached. A funnel table that collected the
-- answers would be a second copy of the customer's personal details living
-- outside the CRM, which is not a trade worth making to learn where people stop.
CREATE TABLE IF NOT EXISTS funnel (
  sid     TEXT NOT NULL,          -- random per-visit id, not a person
  step    INTEGER NOT NULL,       -- 0..4 = form step reached, 99 = submitted
  slug    TEXT,                   -- which group post brought them
  mobile  INTEGER NOT NULL DEFAULT 0,
  ts      TEXT NOT NULL,
  day     TEXT NOT NULL,
  PRIMARY KEY (sid, step)
);
CREATE INDEX IF NOT EXISTS funnel_day  ON funnel (day);
CREATE INDEX IF NOT EXISTS funnel_slug ON funnel (slug);
