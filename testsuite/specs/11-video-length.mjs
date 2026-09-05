// Snapdini integration spec — video LENGTH policy.
//
// An event's purchased videoSeconds is a PRICE tier (10s $2 … 90s $12), not a technical limit.
// Enforcing it to the second punished the people who paid: a phone clip reading 11.4s against a 10s
// plan is container rounding, and a guest who filmed the speeches cannot re-trim it at 1am. So an
// event that bought video keeps over-length clips, up to an absolute ceiling. Buying video AT ALL is
// still required — that is the fee, and it is still enforced.
import fs from 'node:fs';
import path from 'node:path';
import { api, createEvent, dbq, group, join, ok, spec } from '../lib/harness.mjs';

const clip = (name) => fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'loadtest', name));
async function uploadClip(token, file, source) {
  const fd = new FormData();
  fd.append('sessionToken', token);
  if (source) fd.append('source', source);        // omitted entirely = an old client
  fd.append('photo', new Blob([clip(file)], { type: 'video/mp4' }), file);
  return api('POST', '/api/photos', { body: fd });
}

await spec('11-video-length', async () => {
  group('Video length: a paid tier is a price, not a hard cutoff');

  // Free tier (<=10 guests) includes video, so videoSeconds is honoured without a payment step.
  const ev = await createEvent({ revealMode: 'instant', videoSeconds: 10 });
  ok('event bought a 10s video tier',
     Number(dbq(`SELECT video_seconds FROM events WHERE id='${ev.id}'`)) === 10,
     dbq(`SELECT video_seconds FROM events WHERE id='${ev.id}'`));
  const tok = (await join(ev.joinCode, 'Videographer')).json?.sessionToken;
  ok('guest joined', !!tok);

  const under = await uploadClip(tok, 'clip_4s.mp4', 'upload');
  ok('a clip inside the tier uploads', under.status === 200, `status ${under.status} ${under.text?.slice(0, 80)}`);

  // The headline change: 20.2s against a 10s tier is double the limit, and is KEPT.
  const over = await uploadClip(tok, 'clip_20s.mp4', 'upload');
  ok('a clip well OVER the tier is kept, not rejected', over.status === 200, `status ${over.status} ${over.text?.slice(0, 80)}`);
  const durs = dbq(`SELECT round(duration_ms/1000.0) FROM photos WHERE event_id='${ev.id}' AND media_type='video' ORDER BY duration_ms`).split('\n').filter(Boolean);
  ok('both clips stored with their real durations', durs.length === 2 && Number(durs[1]) >= 20,
     `durations: ${durs.join(', ')}`);

  // The evidence the leniency is measurable at all — no schema change, duration_ms vs video_seconds.
  ok('the overage is queryable for tracking',
     Number(dbq(`SELECT count(*) FROM photos p JOIN events e ON e.id=p.event_id
                  WHERE p.event_id='${ev.id}' AND p.media_type='video'
                    AND p.duration_ms > (e.video_seconds + 3) * 1000`)) === 1,
     'expected exactly the 20s clip to count as over');

  group('Video length: buying video at all is still required (no fee bypass)');
  const noVid = await createEvent({ revealMode: 'instant', videoSeconds: 0 });
  ok('event has no video entitlement',
     Number(dbq(`SELECT video_seconds FROM events WHERE id='${noVid.id}'`)) === 0);
  const tok2 = (await join(noVid.joinCode, 'Chancer')).json?.sessionToken;
  const blocked = await uploadClip(tok2, 'clip_4s.mp4', 'upload');
  ok('video upload is refused outright when video was never bought', blocked.status === 403,
     `status ${blocked.status}`);
  ok('and nothing was stored for it',
     Number(dbq(`SELECT count(*) FROM photos WHERE event_id='${noVid.id}'`)) === 0);


  group('An in-app capture that overshoots is kept too, but flagged as a defect');
  // The recorder stops itself at the limit; if it ever fails to, the guest must not pay for our bug
  // by losing the clip. Kept — but recorded as source='capture' so it is chaseable, not invisible.
  const evC = await createEvent({ revealMode: 'instant', videoSeconds: 10 });
  const tokC = (await join(evC.joinCode, 'Overshooter')).json?.sessionToken;
  const shot = await uploadClip(tokC, 'clip_20s.mp4', 'capture');
  ok('an overshooting in-app capture is still kept', shot.status === 200, `status ${shot.status}`);
  ok('it is recorded as an in-app capture, not a camera-roll upload',
     dbq(`SELECT source FROM photos WHERE event_id='${evC.id}' AND media_type='video'`) === 'capture',
     dbq(`SELECT COALESCE(source,'(null)') FROM photos WHERE event_id='${evC.id}'`));
  ok('camera-roll clips are recorded as uploads',
     dbq(`SELECT DISTINCT source FROM photos WHERE event_id='${ev.id}' AND media_type='video'`) === 'upload',
     dbq(`SELECT DISTINCT COALESCE(source,'(null)') FROM photos WHERE event_id='${ev.id}'`));

  group('Video overages are reported to the operator');
  const admLogin = process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD
    ? await api('POST', '/api/auth/login', { body: { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD } })
    : { status: 0 };
  if (admLogin.status === 200) {
    const ov = await api('GET', '/api/admin/overview');
    ok('overview counts videos over their tier', Number(ov.json?.stats?.videos_over_limit) >= 2,
       JSON.stringify(ov.json?.stats?.videos_over_limit));
    ok('in-app overshoots are counted SEPARATELY from camera-roll overages',
       Number(ov.json?.stats?.capture_overshoots) >= 1
         && Number(ov.json?.stats?.capture_overshoots) < Number(ov.json?.stats?.videos_over_limit),
       `capture_overshoots=${ov.json?.stats?.capture_overshoots} of ${ov.json?.stats?.videos_over_limit}`);
    const rows = ov.json?.videoOverages || [];
    const mine = rows.find((r) => r.join_code === ev.joinCode);
    ok('the overage detail names the event and how far over it went',
       !!mine && Number(mine.purchased_secs) === 10 && Number(mine.over_by_secs) >= 9,
       JSON.stringify(mine || rows.slice(0, 2)));
  } else {
    ok('overage reporting skipped — no admin creds on this env', true);
  }
});
