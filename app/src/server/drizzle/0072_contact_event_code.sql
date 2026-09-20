-- Which event a contact message or feedback report came from.
--
-- The join code was already reaching us, but only inside the free-text `context` ("Camera (ABC123)"),
-- which is a sentence written for a human to read. Answering "show me everything from this event"
-- meant pattern-matching prose, and the subject line of the support email could not name the event
-- at all without doing the same.
--
-- Nullable and never backfilled: the marketing contact form has no event, and a message sent before
-- this existed has an event we cannot now recover — which is different from having none.
ALTER TABLE contact_messages ADD COLUMN IF NOT EXISTS event_code text;
