# Snapdini 1.5.16 — finished rolls open your photos

This release changes what a guest sees when there is nothing left to shoot, and stops search
engine crawlers from filing error reports.

- A guest who comes back to a finished roll, or to an event that has ended or been locked, now
  lands on their own photos instead of the camera. A card at the top says why: "That's your roll"
  during the event, or "This event has ended" afterwards. The camera is not started at all, so a
  phone that would not start it no longer shows a camera error to someone with nothing left to
  shoot.
- During the event, that card offers "Ask the host for more" and "Get 12 more" when the host has
  turned those on. Once the host has opened the gallery, it also links to everyone's photos.
- In the camera, the "That's your roll" card now always appears when the roll runs out, even at
  events without top-ups or asking, and both it and the "event has ended" card have a "See your
  photos" button. The 📷 Camera button stays available from the photos view.
- Error reports from search engine and social media crawlers are no longer stored, so they do not
  appear in the site admin's Support tab. Reports from real browsers are kept as before.

No database migration or configuration change is introduced.

## Validation

- Backend suite (1,364 tests, including new checks that crawler reports are dropped and real
  phones, including model names containing "bot", are kept) and frontend typecheck (0 errors) and
  unit suite (1,621 tests).
- Dev deployment, in a browser with test guests: a finished roll at a running event and a guest at
  an ended event both open their photos without requesting the camera; a guest with shots left
  opens the camera; the round trip between camera and photos works; a crawler report is accepted
  and not stored.

## Upgrade

Use the normal upgrade procedure and version `1.5.16`. Replace both app and web images, and
refresh any separate guest-settings publisher and warm standby app images as for 1.5.15.
