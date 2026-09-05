-- Buying and asking are separate decisions for a host, and the four combinations are all real:
--   buy on  + ask on   the default — a guest can pay, or ask, whichever suits
--   buy on  + ask off  "take their money if they want, but don't pester me mid-event"
--   buy off + ask on   "I keep control of the roll, but I'm happy to be asked"
--   buy off + ask off  full control — the roll is the roll
-- Defaults to true so nothing changes for existing events.
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS guest_may_request boolean NOT NULL DEFAULT true;
