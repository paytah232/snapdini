-- What the SITE OPERATOR changed on somebody else's event, and what it was before he changed it.
--
-- A site admin can drill into any customer's event and manage it exactly as the host would, and a
-- good part of that surface saves the instant it is toggled — no form, no Save, no confirmation.
-- That is the right shape for the host, who is looking at their own event and knows what they
-- meant. It is the wrong shape for somebody else's live wedding: one stray tap on the reveal
-- switch during the reception and there is no record anywhere that it was us, let alone what the
-- setting had been. The server logs a 200 and the host finds out from their guests.
--
-- THIS TABLE DOES NOT UNDO ANYTHING, and that is a decision rather than an omission. An automated
-- revert has to answer "what if the host has since changed it themselves?", which is a merge, and
-- a merge on settings nobody is watching resolves itself wrong about as often as it resolves
-- itself right. Recording the before-value costs one row and leaves the judgement with a person,
-- who can put it back through the same UI the host uses. There is deliberately no revert endpoint.
--
-- ONLY THE OPERATOR'S WORK ON OTHER PEOPLE'S EVENTS LANDS HERE. Not the host's own saves, and not
-- the operator's saves on his own events — see youManage() in auth.ts. A log that also collected
-- routine work would be mostly routine work, and the one entry that mattered would be on page
-- forty. The filter is the feature.

CREATE TABLE IF NOT EXISTS admin_actions (
  -- bigserial, not a uuid, unlike almost every other table here. Two reasons and both are about
  -- reading: it is a total order that agrees with `at` even when two actions land in the same
  -- millisecond (a settings save and the toggle beside it), which is what makes "newest first"
  -- pageable without rows shuffling between pages — the defect the user and survey listings in
  -- routes/admin.ts both had. And nothing outside the database ever names a row, so there is no
  -- id to mint client-side or carry in a URL. site_events (0037) is bigserial for the same reason.
  id              bigserial PRIMARY KEY,
  at              bigint NOT NULL,

  -- WHO, denormalised. The join to users would work today, and would stop telling the truth the
  -- day an operator account is renamed or removed — at which point the log says a deleted user id
  -- did something to a customer's wedding. The id is kept so two entries can still be tied to one
  -- person; the email and name are a snapshot of who that was AT THE TIME, which is what an audit
  -- trail is for. Same reasoning as guest_invites.email next to guest_invites.guest_id (0047).
  admin_user_id   text NOT NULL,
  admin_email     text NOT NULL,
  admin_name      text,

  -- WHICH EVENT. NO FOREIGN KEY, deliberately, and this is the column where it matters most:
  -- `event.delete` is one of the actions being recorded, so a cascade would erase the entry for
  -- the single most destructive thing an operator can do, at the exact moment it was written.
  -- ON DELETE SET NULL is no better — it keeps the row and throws away the only thing that says
  -- which event it was about. site_events makes the same call for the same shape of reason (it
  -- has to outlive the retention purge). The read endpoint LEFT JOINs events to report whether
  -- the event is still there, so a dangling id renders as "deleted" rather than as a broken link.
  event_id        text NOT NULL,
  event_name      text NOT NULL,
  event_join_code text NOT NULL,

  -- WHAT, as verb and noun. `action` is the thing done ('event.settings', 'photo.rotate',
  -- 'photo.moderate'); target_type/target_id is the object it was done to. They overlap, and the
  -- overlap is worth the column: one bulk moderation covers many photos, so target_id is NULL and
  -- the ids live in the value maps below — a reader that only had `action` could not tell that
  -- case from a single-photo one.
  action          text NOT NULL,
  target_type     text NOT NULL,
  target_id       text,

  -- THE SHAPE OF THE BEFORE/AFTER PAIR, which is the whole design of this table.
  --
  -- Both are JSON OBJECTS WITH THE SAME KEYS, holding only what actually changed. A key is a
  -- field name for a single object, and a target id when one action covered a set:
  --
  --   settings save   before {"revealMode":"manual","moderationEnabled":false}
  --                   after  {"revealMode":"instant","moderationEnabled":true}
  --   photo rotation  before {"captureRotation":0,"filename":"ev/a.jpg"}
  --                   after  {"captureRotation":90,"filename":"ev/b.jpg"}
  --   bulk moderation before {"ph_1":"pending","ph_2":"rejected"}
  --                   after  {"ph_1":"approved","ph_2":"approved"}
  --
  -- One representation rather than a column per feature, because the alternative was tried on
  -- paper and does not survive the third feature: a `was_revealed`/`now_revealed` pair is useless
  -- to a rotation, a rotation's pair is useless to a moderation decision, and every new toggle
  -- would need a migration before it could be logged — which in practice means it does not get
  -- logged. jsonb costs one generic renderer in the UI ("key: before → after") and covers
  -- everything, including the toggle nobody has written yet.
  --
  -- NULL is meaningful and is not the same as {}. `after_value` NULL means the object stopped
  -- existing (a delete, where `before_value` holds the snapshot that is now the only copy);
  -- `before_value` NULL would mean it did not exist before. {} never appears: an action that
  -- changed nothing writes no row at all, which is what keeps a host's own re-save of an
  -- unchanged form out of an operator's audit trail.
  --
  -- Not indexed, and should not be. Nothing searches inside these — the two reads are "recently"
  -- and "this event", both served below — and a GIN index on a column written by every operator
  -- action and read by one person would be maintenance in exchange for nothing.
  before_value    jsonb,
  after_value     jsonb
);

-- The two reads that will actually happen, and only those.
--
-- `id DESC` is on both because `at` is not unique: an operator flipping three toggles in one
-- second gives Postgres a tie it may break differently per query, and under LIMIT/OFFSET that
-- means consecutive pages overlap — a row shown twice while another is never shown at all. Same
-- defect, same fix, as the user and survey-response listings.
CREATE INDEX IF NOT EXISTS admin_actions_at_idx    ON admin_actions (at DESC, id DESC);
CREATE INDEX IF NOT EXISTS admin_actions_event_idx ON admin_actions (event_id, at DESC, id DESC);
