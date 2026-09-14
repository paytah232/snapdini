-- Per-ACCOUNT email opt-outs.
--
-- Australian Spam Act 2003 s18: the unsubscribe obligation is the RECIPIENT telling the SENDER to
-- stop sending that kind of message to that address. It is not scoped to one event. Keying this to
-- an event would mean a host who asked us to stop sending feedback requests got one again the
-- moment they ran their next event — which is precisely the request they made, ignored.
--
-- A row means OPTED OUT. There is no "subscribed" row and no boolean to get the wrong way round:
-- absence means send, so every account that already exists keeps receiving exactly what it received
-- before this table existed, and there is nothing to backfill.
--
-- `kind` is the camelCase builder name from lifecycle-emails.ts ('surveyEmail', …) rather than an
-- enum: the set of optional messages is a product decision that changes, and a CHECK constraint
-- here would turn adding one into a migration. Unknown kinds are ignored on read (email-prefs.ts),
-- so a row left behind by a retired message kind is inert rather than a fault.
--
-- Composite primary key, not a surrogate id: "this account, this kind" is the identity of the fact,
-- and it makes the double-save of a preference page a no-op instead of a second row saying the same
-- thing with a later date. The leading user_id also serves the only read there is — every opt-out
-- for one account — so no extra index is needed.
CREATE TABLE IF NOT EXISTS email_preferences (
  user_id      text   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         text   NOT NULL,
  opted_out_at bigint NOT NULL,
  PRIMARY KEY (user_id, kind)
);
