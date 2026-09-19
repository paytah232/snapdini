// Snapdini integration spec — face matching.
//
// The assertions that matter are the GATES and the DELETION, not the recognition accuracy: no
// template may exist for anyone who did not consent, and withdrawing must actually undo it. The
// matching itself needs a live ML container, so those parts skip cleanly without one.
//
// TEST ISOLATION — POST /api/faces/enrol is rate limited per IP (index.ts: FACE_ENROL_RATE_LIMIT,
// default 3 per 15 minutes) because one enrolment costs an ML round trip per photo in the event.
// This spec needs SIX enrol POSTs, so on the shipped default it passed once and then reported its
// own 429s as six product failures for the next fifteen minutes — i.e. the suite could not be run
// twice, which made every other result in the run suspect too.
//
// The fix is on the STACK, not in here: the dev compose file raises the limit (see
// docker-compose.dev.yml — production leaves the var unset and keeps the tight default of 3). A
// distinct client identity per run is NOT available: nginx sets `X-Forwarded-For: $remote_addr`,
// overwriting whatever the client sent, so req.ip cannot be varied from outside — which is the
// correct behaviour for a limiter and is not something to work around.
//
// The budget can still run out (ten runs inside one window), so every assertion that depends on an
// enrol POST being SERVED goes through okEnrol(), which reports a visible SKIPPED line instead of a
// failure the product did not cause. It never hides a refusal the product chose: 403/400/503 are
// asserted as normal — only a 429 from the limiter skips, and it says so loudly, once.
import fs from 'node:fs';
import path from 'node:path';
import { BASE, api, createEvent, dbq, group, join, ok, org, spec, upload } from '../lib/harness.mjs';

const FACE_A = path.join(import.meta.dirname, '..', '..', 'loadtest', 'face_a.jpg');
const FACE_B = path.join(import.meta.dirname, '..', '..', 'loadtest', 'face_b.jpg');
const FACE_A_PHONE = path.join(import.meta.dirname, '..', '..', 'loadtest', 'face_a_phone.jpg');
const haveFaces = fs.existsSync(FACE_A) && fs.existsSync(FACE_B);

async function mlUp() {
  try {
    const cfg = await api('GET', '/api/config');
    return !!cfg.json && (await api('GET', '/api/faces/mine')).status !== 404;
  } catch { return false; }
}

// Set the first time the enrol limiter refuses us; from then on the enrol-dependent assertions
// report SKIPPED rather than a failure this run cannot legitimately test.
let limited = false;
async function enrol(token, file, consent = 'true') {
  const fd = new FormData();
  fd.append('sessionToken', token);
  fd.append('consent', consent);
  if (file) fd.append('selfie', new Blob([fs.readFileSync(file)], { type: 'image/jpeg' }), 'selfie.jpg');
  const res = await api('POST', '/api/faces/enrol', { body: fd });
  if (res.status === 429 && !limited) {
    limited = true;
    // draft-7 header: `RateLimit: limit=3, remaining=0, reset=842`. Printed so the transcript says
    // what the budget actually was rather than leaving a reader to guess why things skipped.
    const hdr = res.headers?.get('ratelimit') || res.headers?.get('ratelimit-policy') || 'no RateLimit header';
    console.log(`\n[14] /api/faces/enrol is out of budget for this IP (${hdr}).`
      + `\n[14] The enrol assertions below report SKIPPED, not failed. Raise FACE_ENROL_RATE_LIMIT`
      + `\n[14] on the dev stack (docker-compose.dev.yml) or wait out the 15-minute window.`);
  }
  return res;
}
let skipped = 0;
/** ok(), except that an enrol POST the limiter never served is a SKIP, not a failure. */
const okEnrol = (name, cond, detail = '') =>
  (limited ? (skipped++, ok(`SKIPPED (face-enrol rate limit) — ${name}`, true)) : ok(name, cond, detail));

await spec('14-face-matching', async () => {
  group('Face matching is off unless the host turns it on');
  const ev = await createEvent({ revealMode: 'instant', maxPhotos: 12 });
  ok('a new event has face matching OFF',
     dbq(`SELECT face_matching_enabled FROM events WHERE id='${ev.id}'`) === 'f',
     dbq(`SELECT face_matching_enabled FROM events WHERE id='${ev.id}'`));
  const tok = (await join(ev.joinCode, 'Face Guest')).json?.sessionToken;
  ok('guest joined', !!tok);

  const offRes = await enrol(tok, haveFaces ? FACE_A : null);
  okEnrol('enrolling is refused while the host has it off', [403, 503].includes(offRes.status), `status ${offRes.status}`);
  // True whether or not the limiter served that request — a refusal of any kind stores nothing.
  ok('and no template was stored',
     dbq(`SELECT COALESCE(face_embedding,'none') FROM participants WHERE session_token='${tok}'`) === 'none');

  group('The server kill switch, not the host toggle, is what guests see');
  // The feature is built but held back pending legal review, so MACHINE_LEARNING_URL is the switch
  // that keeps it inert. A stale face_matching_enabled=true on an events row must not be able to
  // surface the UI on a server with no ML backend — that combination is the quiet failure.
  const adm = (await api('GET', `/api/events/${ev.joinCode}/admin`, { headers: org(ev.organizerCode) })).json || {};
  ok('the host payload reports server availability, not just the toggle',
     typeof adm.faceMatchingAvailable === 'boolean', JSON.stringify(adm.faceMatchingAvailable));
  const mlOn = adm.faceMatchingAvailable;

  dbq(`UPDATE events SET face_matching_enabled=true WHERE id='${ev.id}'`);
  const meOn = (await api('GET', '/api/participants/me', { headers: { 'X-Session-Token': tok } })).json || {};
  ok('the guest-facing flag agrees with the server switch',
     meOn.faceMatching === mlOn, `faceMatching=${meOn.faceMatching} available=${mlOn}`);
  const admOn = (await api('GET', `/api/events/${ev.joinCode}/admin`, { headers: org(ev.organizerCode) })).json || {};
  ok('and so does the host payload',
     admOn.faceMatchingEnabled === mlOn, `${admOn.faceMatchingEnabled}`);
  if (!mlOn) {
    const onRes = await enrol(tok, haveFaces ? FACE_A : null);
    okEnrol('with no ML server, enrolling is refused even with the host toggle on',
       onRes.status === 503, `status ${onRes.status}`);
    ok('and /mine is refused too', (await api('GET', '/api/faces/mine', { headers: { 'X-Session-Token': tok } })).status === 503);
  } else {
    ok('ML server present — kill-switch-off path covered by app unit tests', true);
    ok('ML server present — /mine reachable',
       [200, 400, 403].includes((await api('GET', '/api/faces/mine', { headers: { 'X-Session-Token': tok } })).status));
  }


  group('Consent is required, explicitly, every time');
  const noConsent = await enrol(tok, haveFaces ? FACE_A : null, 'false');
  okEnrol('a selfie without consent is refused', [400, 503].includes(noConsent.status), `status ${noConsent.status}`);
  const noSelfie = await enrol(tok, null);
  okEnrol('consent alone with no selfie is refused', [400, 503].includes(noSelfie.status), `status ${noSelfie.status}`);
  ok('still no template after either refusal',
     dbq(`SELECT COALESCE(face_embedding,'none') FROM participants WHERE session_token='${tok}'`) === 'none');

  group('Only the enrolled guest ever has a template');
  const live = await mlUp();
  if (!live || !haveFaces) {
    ok('matching skipped — no ML container or no face fixtures on this env', true);
  } else {
    const other = (await join(ev.joinCode, 'Bystander')).json?.sessionToken;
    if (other) await upload(other);                       // a photo from someone who never enrols
    const guestUp = await api('POST', '/api/photos', await (async () => {
      const fd = new FormData();
      fd.append('sessionToken', tok);
      fd.append('photo', new Blob([fs.readFileSync(FACE_A)], { type: 'image/jpeg' }), 'a.jpg');
      return { body: fd };
    })());
    ok('a photo of person A uploaded', guestUp.status === 200, `status ${guestUp.status}`);

    const res = await enrol(tok, FACE_A);
    okEnrol('enrolling with consent succeeds', res.status === 200, `status ${res.status} ${res.text?.slice(0, 90)}`);

    // A REAL phone selfie is portrait-by-EXIF, and the ML service ignores EXIF entirely — it scored
    // a pixel-rotated copy and an orientation=6 copy identically. Unstraightened, that costs enough
    // detection score to be rejected outright ("we couldn't find a face"), and any embedding that
    // does survive is of a sideways face and matches nothing upright. This is the case that failed
    // on a real handset, so it is pinned with a real EXIF-rotated fixture.
    if (fs.existsSync(FACE_A_PHONE)) {
      const pt = (await join(ev.joinCode, 'Phone Selfie')).json?.sessionToken;
      const rot = await enrol(pt, FACE_A_PHONE);
      okEnrol('an EXIF-rotated phone selfie enrols instead of 422-ing',
         rot.status === 200, `status ${rot.status} ${rot.text?.slice(0, 90)}`);
      okEnrol('and it still finds the photos that face is in',
         Number(rot.json?.matched || 0) > 0, JSON.stringify(rot.json));
      await api('DELETE', '/api/faces/enrol', { body: { sessionToken: pt } });
    } else {
      ok('rotated-selfie check skipped — fixture absent', true);
      ok('rotated-selfie match check skipped — fixture absent', true);
    }
    okEnrol('it reports what it scanned and matched',
       typeof res.json?.matched === 'number' && typeof res.json?.scanned === 'number', JSON.stringify(res.json));

    // THE property: everyone else in those photos is compared and discarded, never stored.
    okEnrol('exactly one participant has a template — the one who consented',
       Number(dbq(`SELECT count(*) FROM participants WHERE event_id='${ev.id}' AND face_embedding IS NOT NULL`)) === 1,
       dbq(`SELECT count(*) FROM participants WHERE event_id='${ev.id}' AND face_embedding IS NOT NULL`));
    // Global invariant, and it holds whether or not this run got to enrol anyone.
    ok('no template exists anywhere without a recorded consent',
       Number(dbq(`SELECT count(*) FROM participants WHERE face_embedding IS NOT NULL AND face_consent_at IS NULL`)) === 0);

    const mine = await api('GET', '/api/faces/mine', { headers: { 'X-Session-Token': tok } });
    okEnrol('the guest can list their own matches', mine.json?.enrolled === true, JSON.stringify(mine.json));
    ok('the API never returns the template itself',
       !JSON.stringify(mine.json || {}).includes('embedding'), JSON.stringify(mine.json).slice(0, 80));

    group('Withdrawing actually undoes it');
    // DELETE is deliberately NOT rate limited (index.ts skips non-POST) — a withdrawal that gets
    // refused is a withdrawal that did not happen — so this group is asserted for real either way.
    // What it can only PROVE after a served enrolment is that it undid something, hence okEnrol.
    const del = await api('DELETE', '/api/faces/enrol', { body: { sessionToken: tok } });
    ok('withdrawal succeeds', del.status === 200, `status ${del.status}`);
    okEnrol('the template is gone',
       dbq(`SELECT COALESCE(face_embedding,'none') FROM participants WHERE session_token='${tok}'`) === 'none');
    okEnrol('and every link derived from it is gone too',
       Number(dbq(`SELECT count(*) FROM photo_faces pf JOIN photos ph ON ph.id=pf.photo_id WHERE ph.event_id='${ev.id}'`)) === 0,
       dbq(`SELECT count(*) FROM photo_faces pf JOIN photos ph ON ph.id=pf.photo_id WHERE ph.event_id='${ev.id}'`));
    okEnrol('and /mine reports them as no longer enrolled',
       (await api('GET', '/api/faces/mine', { headers: { 'X-Session-Token': tok } })).json?.enrolled === false);
  }

  group('Face data dies with the event');
  ok('photo_faces cascades from photos',
     dbq(`SELECT confdeltype FROM pg_constraint WHERE conname LIKE 'photo_faces_photo_id%'`) === 'c',
     dbq(`SELECT confdeltype FROM pg_constraint WHERE conname LIKE 'photo_faces_photo_id%'`));
  ok('photo_faces cascades from participants',
     dbq(`SELECT confdeltype FROM pg_constraint WHERE conname LIKE 'photo_faces_participant_id%'`) === 'c');
  // Said again at the end, with a number: a skip is only honest if it is impossible to miss.
  if (skipped) console.log(`\n[14] ${skipped} enrol assertion(s) reported SKIPPED — /api/faces/enrol was rate limited, NOT tested.`);
  void BASE;
});
