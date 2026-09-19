-- Index and write-path hygiene. All three found by audit; none changes behaviour.
--
-- 1. Two indexes that are strict PREFIXES of a wider index beside them. Postgres serves a
--    prefix query from the wider one, so these answer no question the other cannot — while every
--    INSERT on the two hottest tables in the product maintains them. `photos` carries eight
--    indexes per upload and `photo_hearts` six per heart.
--
--    Kept deliberately: `photo_hearts_participant_idx` is NOT redundant (it leads on participant_id,
--    which no other index does) and it is the FK cascade path.
DROP INDEX IF EXISTS idx_photos_event;            -- prefix of idx_photos_event_taken (event_id, taken_at)
DROP INDEX IF EXISTS photo_hearts_photo_idx;      -- prefix of photo_hearts_photo_participant_uq

-- 2. `photos.view_count` / `download_count` are UPDATEd every 5 seconds across up to 20,000 rows by
--    the write-behind counter flush. The measured HOT-update rate on this table is 77.3%, and with
--    the default fillfactor of 100 there is no free space in a page for the other ~23% — so they
--    take a new page and every one of the table's indexes is touched. Leaving 10% free keeps far
--    more of those updates HOT, which is index maintenance not done at all rather than done fast.
--
--    This only governs pages written from here on; existing bloat needs a VACUUM FULL or REINDEX,
--    which is an owner decision on production and NOT done here.
ALTER TABLE photos SET (fillfactor = 90);
