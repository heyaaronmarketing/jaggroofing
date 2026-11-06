-- Keep the user agent. A bot flag alone cannot distinguish Facebook's preview
-- crawler from a link checker, which is exactly what you need to know when a
-- post is sitting in an approval queue and you are asking whether it went out.
ALTER TABLE clicks ADD COLUMN ua TEXT;
