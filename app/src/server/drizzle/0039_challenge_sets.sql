-- Which mission card a guest was handed.
--
-- An event can carry several sets so the host hands out different cards — table A gets one list,
-- table B another — which spreads coverage across the evening instead of producing forty photos of
-- the same cake. A guest is tied to one set for the life of their roll, so it is stored rather than
-- recomputed: a guest returning on a new device must get the card they have been ticking off, not
-- whichever one the round-robin lands on next.
ALTER TABLE participants ADD COLUMN IF NOT EXISTS challenge_set text;
