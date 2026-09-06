-- The site-admin event list orders by created_at DESC and takes 200 rows. Without an index that is
-- a full scan plus a sort of every event on the instance; with one it reads exactly the rows it
-- returns. Measured on 50k events / 400k photos / 150k participants: the list query went from
-- 327ms to 2.4ms once this index existed AND the page was selected before the counts were joined.
CREATE INDEX IF NOT EXISTS idx_events_created ON events (created_at DESC);
