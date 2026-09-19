-- One address per guest list, whatever case it was typed in.
--
-- WHAT THIS OVERRIDES, AND WHY THAT IS NOT A DRIVE-BY. 0047 keyed idx_event_guests_event_email on
-- the raw columns and said so on purpose: "Stored already lower-cased and trimmed by the writer.
-- That is what makes the partial unique index below a real duplicate check… Normalising on write
-- rather than with a lower() expression index keeps the stored value and the indexed value the
-- same thing, so nothing can query one and miss the other."
--
-- The first half of that stands and this file does not touch it. routes/guests.ts still calls
-- normaliseAddress() on every write and still should: the value a host reads back, the value the
-- suppression list is checked against and the value the importer dedupes on all want to be the
-- one normalised form, and normalising once at the door is how that stays true.
--
-- What has not held up is treating the writer's discipline AS the constraint. Bypassing that one
-- toLowerCase() — nothing exotic; one new writer, one code path that builds a row itself — put
-- `MUM@Example.COM` and `mum@example.com` on the same event as two rows. That is precisely the
-- duplicate this index exists to refuse, and it went straight past it, because the index was
-- checking bytes that another line of code was responsible for normalising. An index that only
-- holds while every present and future writer remembers a call is a CONVENTION with an index
-- standing next to it. A constraint is a thing the database will not let you do.
--
-- And the cost 0047 was weighing — "nothing can query one and miss the other" — turns out not to
-- be a cost here at all, because NOTHING QUERIES THIS COLUMN. Every read of event_guests in the
-- tree filters on event_id or on id: listPayload's list, the import's existing-address scan, the
-- send's row fetch, and unsubscribe.ts's join on guest_id. This index has never once been a lookup
-- path; it has only ever been a rule. Moving the rule onto an expression takes no query plan with
-- it, and there is no read left that could see the raw value and miss the folded one.
--
-- THE REST OF THE SCHEMA HAD ALREADY DECIDED THIS TWICE, and the guest list was the straggler:
--   0031  participants  UNIQUE (event_id, lower(email))            WHERE email IS NOT NULL
--   0052  share_sends   UNIQUE (event_id, lower(btrim(email)))     WHERE share_id IS NULL
--                       UNIQUE (share_id,  lower(btrim(email)))    WHERE share_id IS NOT NULL
-- Three tables keyed on an address, two of them case-folded and one not, is worse than either
-- answer applied consistently — it is a rule a reader has to look up per table.
--
-- btrim() as well as lower(), matching 0052 rather than 0031's bare lower(): ' mum@x.com' is the
-- same inbox as 'mum@x.com', and a cell pasted out of a spreadsheet is exactly where a leading
-- space comes from. The writer trims too, which is the same argument as above and the same answer.

-- ── Deduplicate FIRST ────────────────────────────────────────────────────────
--
-- A unique index cannot be built over rows that violate it, and this key is STRICTER than the one
-- it replaces — data that satisfied the old index can still fail the new one, which is the whole
-- reason this half exists. 0051 and 0052 are the pattern. A migration that aborts halfway through
-- somebody's upgrade is what is being avoided.
--
-- Nothing is expected to be found, anywhere:
--   · PRODUCTION HAS NO SUCH TABLE. event_guests ships new in 1.5.0 (created by 0047); production
--     is on 1.4.3 at migration 0038, where `SELECT to_regclass('event_guests') IS NOT NULL`
--     returns f — re-verified read-only against a restored production dump before this file was
--     written, where the whole file is a no-op until 0047 creates the table seconds earlier.
--   · No released version has ever had this table, so no operator can be carrying rows in it.
--   · The only writer normalises, so even devel's fixtures collide only if something went around
--     it. A row this finds is a row written around routes/guests.ts.
-- It is here anyway, because "the writer always normalises" is the assumption this file exists to
-- stop relying on, and a dedupe that relied on it would be the same mistake one layer down.
--
-- WHICH ROW SURVIVES: THE EARLIEST. That is the row the host's list has been showing all along,
-- and the row the product's own duplicate rule already preserves — a second add of an address is
-- refused with "that email is already on this guest list", so the first one stays and the later
-- one never existed as far as the host is concerned. Ordering by created_at then id, because a
-- batch import writes its whole batch with one timestamp and the choice still has to be the same
-- on every run.
--
-- THE INVITES MOVE BEFORE THE DELETE rather than being cut loose by ON DELETE SET NULL. A case
-- collision is ONE PERSON by definition — same inbox, different shift key — so every invite
-- against a losing row was mailed to the guest who survives. SET NULL would keep the invite row
-- (0047 chose that deliberately, so a bounce outlives the guest it was sent to) but DETACH it from
-- the person, and the attachment is exactly what the guest-list screen reads to say "last invited:
-- bounced" next to Mum. Re-pointing keeps both facts. guest_invites.guest_id is not unique, so
-- several invites landing on one survivor is nothing to it.
--
-- Two statements, not one data-modifying CTE: inside a single statement the DELETE's foreign-key
-- action and the UPDATE are not ordered against each other, and this is not the file in which to
-- be clever about that.
WITH ranked AS (
  SELECT id, first_value(id) OVER w AS keeper
  FROM event_guests
  WINDOW w AS (PARTITION BY event_id, lower(btrim(email)) ORDER BY created_at, id)
)
UPDATE guest_invites gi
   SET guest_id = r.keeper
  FROM ranked r
 WHERE gi.guest_id = r.id AND r.keeper <> r.id;

WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY event_id, lower(btrim(email))
    ORDER BY created_at, id
  ) AS rn
  FROM event_guests
)
DELETE FROM event_guests WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- ── Then re-key the index ────────────────────────────────────────────────────
--
-- The same NAME, replaced rather than added alongside — as 0051 did to idx_survey_event. Two
-- unique indexes over one rule is two indexes to maintain and one more thing for the next reader
-- to reconcile.
--
-- The `WHERE email IS NOT NULL` predicate from 0047 goes with the rebuild. 0054 made it always
-- true when it set the column NOT NULL and deliberately did NOT rebuild the index just to delete a
-- dead predicate — correctly, since that is a lock and a risk bought for nothing. The index is
-- being rebuilt here regardless, so dropping it now is free, and a predicate that reads as a rule
-- but enforces nothing is worth removing the moment it is free.
DROP INDEX IF EXISTS idx_event_guests_event_email;
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_guests_event_email
  ON event_guests (event_id, lower(btrim(email)));
