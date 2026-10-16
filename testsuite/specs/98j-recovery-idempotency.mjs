// Real PostgreSQL + media-store regression for recovery retries. Deliberately dev-only: fixtures
// exercise admission/shot limits directly and are deleted through the owner API even on failure.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
assert.equal(process.argv[2] || 'http://localhost:3001', 'http://localhost:3001', 'this spec is dev-only');
assert.equal(process.env.SNAPDINI_DB || 'snapdini-dev-db', 'snapdini-dev-db', 'this spec requires dev DB');
const { api, createEvent, dbq, group, ok, spec, img, BASE, org } = await import('../lib/harness.mjs');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const nonce = () => randomBytes(32).toString('hex');
const join = (event, attempt) => api('POST', '/api/participants', {
  body: { joinCode: event.joinCode, name: 'Recovery retry', joinAttempt: attempt },
});
const send = (token, captureId) => {
  const body = new FormData();
  body.append('sessionToken', token); body.append('captureId', captureId);
  body.append('photo', new Blob([img], { type: 'image/jpeg' }), 'capture.jpg');
  return api('POST', '/api/photos', { body });
};
const photoBytes = async (filename) => {
  const response = await fetch(`${BASE}/uploads/${filename}?_cb=${randomUUID()}`);
  return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()) };
};

await spec('98j-recovery-idempotency', async () => {
  const fixtures = [];
  try {
    group('A lost join response and concurrent retries consume one guest seat');
    const event = await createEvent(); fixtures.push(event);
    dbq(`UPDATE events SET guest_cap=1,max_photos=1 WHERE id='${event.id}'`);
    const attempt = nonce();
    const joined = await Promise.all(Array.from({ length: 8 }, () => join(event, attempt)));
    ok('all duplicate join requests succeed', joined.every((r) => r.status === 200), JSON.stringify(joined.map((r) => r.status)));
    ok('all replies identify one participant', new Set(joined.map((r) => r.json?.participant?.id)).size === 1);
    ok('all replies return the same working session', new Set(joined.map((r) => r.json?.sessionToken)).size === 1);
    ok('database contains one participant', dbq(`SELECT count(*) FROM participants WHERE event_id='${event.id}'`) === '1');
    const token = joined[0].json?.sessionToken;
    assert.ok(token, 'fixture did not join');
    const me = await api('GET', '/api/participants/me', { headers: { 'x-session-token': token } });
    ok('returned session opens the roll', me.status === 200);
    const cfg = await api('GET', '/api/config');
    if (cfg.json?.billing?.billingEnabled)
      ok('a new nonce cannot bypass the full guest cap', (await join(event, nonce())).status === 403);
    const replay = await join(event, attempt);
    ok('replaying a discarded join response returns the original session', replay.status === 200 && replay.json?.sessionToken === token);

    group('Concurrent capture retries produce one photo, one charge and a surviving original');
    const captureId = randomUUID();
    const uploads = await Promise.all(Array.from({ length: 8 }, () => send(token, captureId)));
    ok('all concurrent same-capture uploads succeed', uploads.every((r) => r.status === 200), JSON.stringify(uploads.map((r) => r.status)));
    ok('all uploads acknowledge one photo id', new Set(uploads.map((r) => r.json?.photoId)).size === 1);
    ok('there is exactly one committed photo', dbq(`SELECT count(*) FROM photos WHERE event_id='${event.id}'`) === '1');
    ok('only one shot was charged', dbq(`SELECT photos_taken FROM participants WHERE event_id='${event.id}'`) === '1');
    const filename = dbq(`SELECT filename FROM photos WHERE event_id='${event.id}'`);
    assert.ok(filename, 'upload did not leave an original');
    const original = await photoBytes(filename);
    ok('winning original is still fetchable after loser cleanup', original.status === 200 && original.bytes.length > 0);
    const originalHash = digest(original.bytes);
    const lostResponse = await send(token, captureId);
    ok('lost upload response can be replayed after the roll fills', lostResponse.status === 200 && lostResponse.json?.photoId === uploads[0].json?.photoId);
    ok('receipt reports the full roll', lostResponse.json?.photosRemaining === 0);
    const completed = await api('POST', '/api/photos/complete', { body: {
      sessionToken: token, captureId, uploadId: `no-parts-${randomUUID()}`, total: 1,
      ext: 'jpg', mediaType: 'photo',
    } });
    ok('chunk completion replays without removed chunks even on a full roll', completed.status === 200 && completed.json?.photoId === lostResponse.json?.photoId);
    const after = await photoBytes(filename);
    ok('replays leave the winning original unchanged', after.status === 200 && digest(after.bytes) === originalHash);
    ok('a different capture cannot bypass the exhausted roll', (await send(token, randomUUID())).status === 403);
    ok('photo count and shot counter still agree at one', dbq(`SELECT count(*) FROM photos WHERE event_id='${event.id}'`) === '1'
      && dbq(`SELECT photos_taken FROM participants WHERE event_id='${event.id}'`) === '1');

    group('A provisional nonce can resume an existing email roll without creating a new guest');
    const emailed = await createEvent(); fixtures.push(emailed);
    const email = `recovery-${randomUUID()}@example.com`;
    const originalJoin = await api('POST', '/api/participants', { body: {
      joinCode: emailed.joinCode, name: 'Existing guest', email,
    } });
    assert.equal(originalJoin.status, 200);
    assert.equal((await send(originalJoin.json.sessionToken, randomUUID())).status, 200);
    const recoveryAttempt = nonce();
    const recoveryBody = { joinCode: emailed.joinCode, name: 'Existing guest', email, joinAttempt: recoveryAttempt };
    const recovery = await api('POST', '/api/participants', { body: recoveryBody });
    const recoveryReplay = await api('POST', '/api/participants', { body: recoveryBody });
    ok('email recovery with a nonce retains the original participant', recovery.status === 200
      && recovery.json?.participant?.id === originalJoin.json.participant.id);
    ok('email recovery rotates the old session normally', recovery.json?.sessionToken !== originalJoin.json.sessionToken);
    ok('replaying its lost response retains the recovered session', recoveryReplay.status === 200
      && recoveryReplay.json?.sessionToken === recovery.json?.sessionToken);
    ok('email recovery preserves photos and shot count', recoveryReplay.json?.participant?.photosTaken === 1
      && dbq(`SELECT photos_taken FROM participants WHERE event_id='${emailed.id}'`) === '1');
    ok('email recovery and replay still use one participant', dbq(`SELECT count(*) FROM participants WHERE event_id='${emailed.id}'`) === '1');

    group('Recovery receipts do not admit a fresh guest outside the event window');
    const gated = await createEvent(); fixtures.push(gated);
    dbq(`UPDATE events SET starts_at=${Date.now() + 3600_000} WHERE id='${gated.id}'`);
    ok('a fresh nonce cannot join before event start', (await join(gated, nonce())).status === 403);
    dbq(`UPDATE events SET starts_at=${Date.now() - 7200_000}, expires_at=${Date.now() - 3600_000} WHERE id='${gated.id}'`);
    ok('a fresh nonce cannot join after event end', (await join(gated, nonce())).status === 410);
    dbq(`UPDATE events SET expires_at=${Date.now() + 3600_000}, is_locked=true WHERE id='${gated.id}'`);
    ok('a fresh nonce cannot join a locked event', (await join(gated, nonce())).status === 403);
    ok('refused admissions created no participant', dbq(`SELECT count(*) FROM participants WHERE event_id='${gated.id}'`) === '0');
    dbq(`UPDATE events SET is_locked=true,expires_at=${Date.now() - 3600_000} WHERE id='${event.id}'`);
    const admittedReplay = await join(event, attempt);
    ok('an admitted nonce still retrieves its session after lock/end', admittedReplay.status === 200 && admittedReplay.json?.sessionToken === token);
    ok('existing photo receipt survives lock/end too', (await send(token, captureId)).status === 200);
  } finally {
    // The harness always removes DB fixtures; using the owner endpoint first also purges S3.
    for (const event of fixtures) {
      const deleted = await api('DELETE', `/api/events/${event.joinCode}`, { headers: org(event.organizerCode) });
      ok('fixture event and its media are deleted through the owner API', deleted.status === 200, String(deleted.status));
    }
  }
});
