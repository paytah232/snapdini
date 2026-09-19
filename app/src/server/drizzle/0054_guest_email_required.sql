-- An email address is REQUIRED on the guest list.
--
-- WHY. event_guests exists for one job: let a host send a lot of people one join link. A row with
-- no address is a row that job can never touch — it cannot be invited, cannot be nudged, cannot be
-- sent the gallery — so a list that accepts one is a list that answers "who have I invited?" with
-- names that were never reachable. The host already has a better answer for those people than a
-- database row: print them a card, or message them directly. This is not an invitation planner.
--
-- WHAT IT REPLACES. While an address was optional the importer needed a SECOND identity to dedupe
-- on (identityKey() in csv.ts: name + note), because the email check had nothing to compare for a
-- plus-one — and that fallback carried a real trade-off about two guests genuinely called "John
-- Smith". With an address on every row it has nothing left to do, so it is gone, and duplicate
-- detection is now exactly this table's own unique index on (event_id, email). One rule, in one
-- place, agreed on by the preview and the database.
--
-- THE DELETE IS SAFE, AND IT IS NOT A DATA LOSS EVENT.
--   · PRODUCTION HAS NO SUCH TABLE. event_guests ships new in 1.5.0 (created by 0047); production
--     is on 1.4.3 at migration 0038, where `SELECT to_regclass('event_guests') IS NOT NULL` returns
--     f — verified read-only against the production database before this file was written. On the
--     upgrade to 1.5.0 the chain runs 0039 … 0047 (CREATE TABLE) … 0054, so this statement meets a
--     table that was created empty seconds earlier and deletes nothing.
--   · No released version has ever had this table, so no operator can be carrying rows in it. The
--     only rows this can find anywhere are dev fixtures.
--   · guest_invites.guest_id is ON DELETE SET NULL, so even in the impossible case the record of
--     what was mailed survives the guest row. Nothing here can have been mailed regardless: there
--     was no address to mail.
-- It runs BEFORE the SET NOT NULL rather than after, so the constraint cannot fail on data it was
-- always going to be applied over. A migration that can abort halfway is the thing to avoid.
DELETE FROM event_guests WHERE email IS NULL;

ALTER TABLE event_guests ALTER COLUMN email SET NOT NULL;

-- The unique index from 0047 is left exactly as it is: `... WHERE email IS NOT NULL`. That
-- predicate is now always true, which makes it a plain unique index in everything but its text.
-- Rebuilding an index to delete a `WHERE true` costs a lock and can fail; it buys nothing. The
-- drizzle schema keeps the same `.where()` so the two stay in step.
