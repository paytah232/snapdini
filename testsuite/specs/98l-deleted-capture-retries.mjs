// Real dev API + PostgreSQL: intentional deletion must survive stale uploads and queue retries.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
assert.equal(process.argv[2] || 'http://localhost:3001', 'http://localhost:3001', 'dev-only spec');
assert.equal(process.env.SNAPDINI_DB || 'snapdini-dev-db', 'snapdini-dev-db', 'requires dev DB');
const { api, createEvent, dbq, group, ok, spec, img, join } = await import('../lib/harness.mjs');
const single = (sessionToken, captureId) => {
  const body = new FormData();
  body.append('sessionToken', sessionToken); body.append('captureId', captureId);
  body.append('photo', new Blob([img], { type: 'image/jpeg' }), 'capture.jpg');
  return api('POST', '/api/photos', { body });
};
const remove = (token, id) => api('DELETE', `/api/photos/${id}`, { body: { sessionToken: token } });
const complete = (sessionToken, captureId) => api('POST', '/api/photos/complete', {
  body: { sessionToken, captureId, uploadId: randomUUID(), total: 1, ext: 'jpg', mediaType: 'photo' },
});
await spec('98l-deleted-capture-retries', async () => {
  const event = await createEvent({ maxPhotos: 2 });
  const guest = await join(event.joinCode, 'Deletion owner');
  const other = await join(event.joinCode, 'Different guest');
  assert.equal(guest.status, 200); assert.equal(other.status, 200);
  const token = guest.json.sessionToken;
  const participant = guest.json.participant.id;
  const capture = randomUUID();
  const first = await single(token, capture);
  assert.equal(first.status, 200, first.text);
  group('Authorized intentional deletion keeps a durable non-media receipt');
  ok('another guest cannot delete the photo', (await remove(other.json.sessionToken, first.json.photoId)).status === 404);
  ok('unauthorized delete creates no tombstone', dbq(`SELECT count(*) FROM capture_upload_tombstones WHERE event_id='${event.id}'`) === '0');
  const deleted = await remove(token, first.json.photoId);
  ok('owner deletion returns the frame', deleted.status === 200 && deleted.json.photosRemaining === 2);
  ok('photo is removed', dbq(`SELECT count(*) FROM photos WHERE id='${first.json.photoId}'`) === '0');
  ok('tombstone has exact authenticated owner and event', dbq(`SELECT count(*) FROM capture_upload_tombstones WHERE photo_id='${first.json.photoId}' AND event_id='${event.id}' AND participant_id='${participant}'`) === '1');
  ok('double deletion cannot refund again', (await remove(token, first.json.photoId)).status === 404 && dbq(`SELECT photos_taken FROM participants WHERE id='${participant}'`) === '0');
  for (const retry of [single, complete]) {
    const result = await retry(token, capture);
    ok(`${retry.name} retry acknowledges deletion without needing old chunk parts`, result.status === 200 && result.json.deleted === true && result.json.status === 'deleted' && result.json.photoId === first.json.photoId && result.json.photosRemaining === 2);
  }
  ok('old retries leave no recreated photo or charged frame', dbq(`SELECT count(*) FROM photos WHERE event_id='${event.id}'`) === '0' && dbq(`SELECT photos_taken FROM participants WHERE id='${participant}'`) === '0');
  const differentOwner = await single(other.json.sessionToken, capture);
  ok('same raw capture id on another roll is independent', differentOwner.status === 200 && differentOwner.json.photoId !== first.json.photoId && !differentOwner.json.deleted);
  const freshCapture = randomUUID();
  const fresh = await single(token, freshCapture);
  ok('new capture can spend the returned frame', fresh.status === 200 && fresh.json.photosRemaining === 1);
  group('Concurrent requests serialize with deletion and preserve the final decision');
  const racing = await Promise.all([
    ...Array.from({ length: 6 }, () => single(token, freshCapture)),
    remove(token, fresh.json.photoId), remove(token, fresh.json.photoId),
  ]);
  ok('all racing upload retries succeed', racing.slice(0, 6).every(r => r.status === 200 && r.json.photoId === fresh.json.photoId));
  ok('one racing deletion wins and one observes absence', racing.slice(6).map(r => r.status).sort().join(',') === '200,404');
  const afterRace = await complete(token, freshCapture);
  ok('retry after delete race sees tombstone', afterRace.status === 200 && afterRace.json.deleted === true);
  ok('delete race gives back exactly one frame', dbq(`SELECT photos_taken FROM participants WHERE id='${participant}'`) === '0');
  ok('delete race leaves no photo', dbq(`SELECT count(*) FROM photos WHERE id='${fresh.json.photoId}'`) === '0');
  group('Deletion memory lives as long as its authenticated roll');
  dbq(`UPDATE capture_upload_tombstones SET deleted_at=1 WHERE participant_id='${participant}'`);
  dbq(`UPDATE events SET is_locked=true WHERE id='${event.id}'`);
  const old = await single(token, capture);
  ok('old tombstone remains replayable even when new admission is locked', old.status === 200 && old.json.deleted === true);
  ok('locked new capture still fails admission', (await single(token, randomUUID())).status === 403);
  dbq(`DELETE FROM participants WHERE id='${participant}'`);
  ok('participant removal cascades tombstones', dbq(`SELECT count(*) FROM capture_upload_tombstones WHERE participant_id='${participant}'`) === '0');
  ok('removed session cannot use a previous tombstone', (await complete(token, capture)).status === 403);
  dbq(`DELETE FROM events WHERE id='${event.id}'`);
  ok('event removal cascades all remaining receipts', dbq(`SELECT count(*) FROM capture_upload_tombstones WHERE event_id='${event.id}'`) === '0');
});
