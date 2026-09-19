-- The event's own gallery link gets its OWN pair of switches, like every other link.
--
-- 0063 let people react on `/gallery/<code>` and had that inherit `events.hearts_enabled` /
-- `comments_enabled`. Inheriting turned out to be the wrong call, because those two settings are
-- about GUESTS — the people who scanned the QR and are shooting — and the gallery link goes to a
-- different audience entirely. A host who wants their guests hearting each other's shots during the
-- event, but does NOT want the link they send round afterwards to be open to everybody who receives
-- it, had no way to say so: one setting was answering two different questions.
--
-- So the gallery link is now editable in the Shared links card exactly like a curated /s/ link, and
-- these two columns are what it edits. `events.hearts_enabled` / `comments_enabled` go back to
-- meaning only what they always meant: what GUESTS can do.
--
-- Defaults match the guest side rather than the curated-share side (both off there): hearts ON
-- because a heart only ever adds a number to a screen, comments OFF because a comment puts
-- somebody's words on another person's gallery under a name.
ALTER TABLE events ADD COLUMN IF NOT EXISTS gallery_hearts_enabled   boolean NOT NULL DEFAULT true;
ALTER TABLE events ADD COLUMN IF NOT EXISTS gallery_comments_enabled boolean NOT NULL DEFAULT false;

-- And a curated share starts the same way, for the same reasons — one answer to "what does a new
-- link do", rather than a different one depending on which kind of link it is. Existing shares keep
-- whatever they were set to; a DEFAULT only governs rows made from here on.
ALTER TABLE shares ALTER COLUMN hearts_enabled SET DEFAULT true;
