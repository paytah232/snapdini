// Snapdini integration spec — a guest taking back their own shot inside the 60s window.
//
// The rule: delete refunds the frame, but ONLY inside the window. A long window would turn a
// 12-shot roll into unlimited retries, which is the one thing the product cannot afford — so the
// "too late" path matters as much as the happy one.
import fs from 'node:fs';
import path from 'node:path';
import { POOL, api, createEvent, dbq, group, join, ok, spec, upload } from '../lib/harness.mjs';

const photosOf = (eventId) => Number(dbq(`SELECT count(*) FROM photos WHERE event_id='${eventId}'`));
const takenBy  = (pid) => Number(dbq(`SELECT photos_taken FROM participants WHERE id='${pid}'`));

await spec('12-guest-delete', async () => {
  group('A guest can take back a shot they just fluffed');
  const ev = await createEvent({ revealMode: 'instant', maxPhotos: 12 });
  const tok = (await join(ev.joinCode, 'Butterfingers')).json?.sessionToken;
  ok('guest joined', !!tok);
  await upload(tok);
  const pid = dbq(`SELECT id FROM participants WHERE session_token='${tok}'`);
  const photoId = dbq(`SELECT id FROM photos WHERE participant_id='${pid}'`);
  const file = dbq(`SELECT filename FROM photos WHERE id='${photoId}'`);
  ok('the shot landed', !!photoId && takenBy(pid) === 1, `taken=${takenBy(pid)}`);

  const del = await api('DELETE', `/api/photos/${photoId}`, { body: { sessionToken: tok } });
  ok('delete inside the window succeeds', del.status === 200, `status ${del.status} ${del.text?.slice(0,80)}`);
  ok('the row is gone', photosOf(ev.id) === 0, `${photosOf(ev.id)} left`);
  ok('the frame is back on their roll', takenBy(pid) === 0, `taken=${takenBy(pid)}`);
  ok('the response reports the restored count', del.json?.photosRemaining === 12, JSON.stringify(del.json));

  group('Delete is not a way around the roll');
  // Backdate a shot past the window — the same call must now be refused, and the count must NOT move.
  await upload(tok);
  const oldId = dbq(`SELECT id FROM photos WHERE participant_id='${pid}'`);
  dbq(`UPDATE photos SET taken_at = taken_at - 120000 WHERE id='${oldId}'`);
  const before = takenBy(pid);
  const late = await api('DELETE', `/api/photos/${oldId}`, { body: { sessionToken: tok } });
  ok('a shot older than the window is refused with 410', late.status === 410, `status ${late.status}`);
  ok('and it is still there', photosOf(ev.id) === 1, `${photosOf(ev.id)}`);
  ok('and the roll was NOT refunded', takenBy(pid) === before, `${takenBy(pid)} vs ${before}`);

  group('You can only delete your own');
  const other = (await join(ev.joinCode, 'Someone Else')).json?.sessionToken;
  ok('second guest joined', !!other);
  const theirs = await api('DELETE', `/api/photos/${oldId}`, { body: { sessionToken: other } });
  ok('another guest gets 404, not a hint that it exists', theirs.status === 404, `status ${theirs.status}`);
  ok('the photo survived', photosOf(ev.id) === 1);
  const noSession = await api('DELETE', `/api/photos/${oldId}`, { body: {} });
  ok('no session token is a 400', noSession.status === 400, `status ${noSession.status}`);
  const bogus = await api('DELETE', '/api/photos/does-not-exist', { body: { sessionToken: tok } });
  ok('an unknown photo id is a 404', bogus.status === 404, `status ${bogus.status}`);

  group('The files go too, not just the row');
  const tok2 = (await join(ev.joinCode, 'Tidy')).json?.sessionToken;
  if (tok2) {
    await upload(tok2);
    const p2 = dbq(`SELECT id FROM participants WHERE session_token='${tok2}'`);
    const ph2 = dbq(`SELECT id FROM photos WHERE participant_id='${p2}'`);
    const fn2 = dbq(`SELECT filename FROM photos WHERE id='${ph2}'`);
    const d2 = await api('DELETE', `/api/photos/${ph2}`, { body: { sessionToken: tok2 } });
    ok('delete succeeded for the file check', d2.status === 200, `status ${d2.status}`);
    const gone = !fs.existsSync(path.join(POOL, fn2));
    ok('the original is removed from disk', gone, `still present: ${fn2}`);
  }
  void file;
});
