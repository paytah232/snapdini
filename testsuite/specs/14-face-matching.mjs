// Snapdini integration spec — face matching.
//
// The assertions that matter are the GATES and the DELETION, not the recognition accuracy: no
// template may exist for anyone who did not consent, and withdrawing must actually undo it. The
// matching itself needs a live ML container, so those parts skip cleanly without one.
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

async function enrol(token, file, consent = 'true') {
  const fd = new FormData();
  fd.append('sessionToken', token);
  fd.append('consent', consent);
  if (file) fd.append('selfie', new Blob([fs.readFileSync(file)], { type: 'image/jpeg' }), 'selfie.jpg');
  return api('POST', '/api/faces/enrol', { body: fd });
}

await spec('14-face-matching', async () => {
  group('Face matching is off unless the host turns it on');
  const ev = await createEvent({ revealMode: 'instant', maxPhotos: 12 });
  ok('a new event has face matching OFF',
     dbq(`SELECT face_matching_enabled FROM events WHERE id='${ev.id}'`) === 'f',
     dbq(`SELECT face_matching_enabled FROM events WHERE id='${ev.id}'`));
  const tok = (await join(ev.joinCode, 'Face Guest')).json?.sessionToken;
  ok('guest joined', !!tok);

  const offRes = await enrol(tok, haveFaces ? FACE_A : null);
  ok('enrolling is refused while the host has it off', [403, 503].includes(offRes.status), `status ${offRes.status}`);
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
    ok('with no ML server, enrolling is refused even with the host toggle on',
       (await enrol(tok, haveFaces ? FACE_A : null)).status === 503);
    ok('and /mine is refused too', (await api('GET', '/api/faces/mine', { headers: { 'X-Session-Token': tok } })).status === 503);
  } else {
    ok('ML server present — kill-switch-off path covered by app unit tests', true);
    ok('ML server present — /mine reachable',
       [200, 400, 403].includes((await api('GET', '/api/faces/mine', { headers: { 'X-Session-Token': tok } })).status));
  }


  group('Consent is required, explicitly, every time');
  const noConsent = await enrol(tok, haveFaces ? FACE_A : null, 'false');
  ok('a selfie without consent is refused', [400, 503].includes(noConsent.status), `status ${noConsent.status}`);
  ok('consent alone with no selfie is refused', [400, 503].includes((await enrol(tok, null)).status));
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
    ok('enrolling with consent succeeds', res.status === 200, `status ${res.status} ${res.text?.slice(0, 90)}`);

    // A REAL phone selfie is portrait-by-EXIF, and the ML service ignores EXIF entirely — it scored
    // a pixel-rotated copy and an orientation=6 copy identically. Unstraightened, that costs enough
    // detection score to be rejected outright ("we couldn't find a face"), and any embedding that
    // does survive is of a sideways face and matches nothing upright. This is the case that failed
    // on a real handset, so it is pinned with a real EXIF-rotated fixture.
    if (fs.existsSync(FACE_A_PHONE)) {
      const pt = (await join(ev.joinCode, 'Phone Selfie')).json?.sessionToken;
      const rot = await enrol(pt, FACE_A_PHONE);
      ok('an EXIF-rotated phone selfie enrols instead of 422-ing',
         rot.status === 200, `status ${rot.status} ${rot.text?.slice(0, 90)}`);
      ok('and it still finds the photos that face is in',
         Number(rot.json?.matched || 0) > 0, JSON.stringify(rot.json));
      await api('DELETE', '/api/faces/enrol', { body: { sessionToken: pt } });
    } else {
      ok('rotated-selfie check skipped — fixture absent', true);
    }
    ok('it reports what it scanned and matched',
       typeof res.json?.matched === 'number' && typeof res.json?.scanned === 'number', JSON.stringify(res.json));

    // THE property: everyone else in those photos is compared and discarded, never stored.
    ok('exactly one participant has a template — the one who consented',
       Number(dbq(`SELECT count(*) FROM participants WHERE event_id='${ev.id}' AND face_embedding IS NOT NULL`)) === 1,
       dbq(`SELECT count(*) FROM participants WHERE event_id='${ev.id}' AND face_embedding IS NOT NULL`));
    ok('no template exists anywhere without a recorded consent',
       Number(dbq(`SELECT count(*) FROM participants WHERE face_embedding IS NOT NULL AND face_consent_at IS NULL`)) === 0);

    const mine = await api('GET', '/api/faces/mine', { headers: { 'X-Session-Token': tok } });
    ok('the guest can list their own matches', mine.json?.enrolled === true, JSON.stringify(mine.json));
    ok('the API never returns the template itself',
       !JSON.stringify(mine.json || {}).includes('embedding'), JSON.stringify(mine.json).slice(0, 80));

    group('Withdrawing actually undoes it');
    const del = await api('DELETE', '/api/faces/enrol', { body: { sessionToken: tok } });
    ok('withdrawal succeeds', del.status === 200, `status ${del.status}`);
    ok('the template is gone',
       dbq(`SELECT COALESCE(face_embedding,'none') FROM participants WHERE session_token='${tok}'`) === 'none');
    ok('and every link derived from it is gone too',
       Number(dbq(`SELECT count(*) FROM photo_faces pf JOIN photos ph ON ph.id=pf.photo_id WHERE ph.event_id='${ev.id}'`)) === 0,
       dbq(`SELECT count(*) FROM photo_faces pf JOIN photos ph ON ph.id=pf.photo_id WHERE ph.event_id='${ev.id}'`));
    ok('and /mine reports them as no longer enrolled',
       (await api('GET', '/api/faces/mine', { headers: { 'X-Session-Token': tok } })).json?.enrolled === false);
  }

  group('Face data dies with the event');
  ok('photo_faces cascades from photos',
     dbq(`SELECT confdeltype FROM pg_constraint WHERE conname LIKE 'photo_faces_photo_id%'`) === 'c',
     dbq(`SELECT confdeltype FROM pg_constraint WHERE conname LIKE 'photo_faces_photo_id%'`));
  ok('photo_faces cascades from participants',
     dbq(`SELECT confdeltype FROM pg_constraint WHERE conname LIKE 'photo_faces_participant_id%'`) === 'c');
  void BASE;
});
