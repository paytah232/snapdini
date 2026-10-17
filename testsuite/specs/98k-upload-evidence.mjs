// Real dev-only upload evidence: client claims, rejected chunks, committed receipts and retention.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
assert.equal(process.argv[2] || 'http://localhost:3001', 'http://localhost:3001', 'dev-only spec');
assert.equal(process.env.SNAPDINI_DB || 'snapdini-dev-db', 'snapdini-dev-db', 'requires dev DB');
const { api, createEvent, dbq, group, ok, spec, img, org, join, session, adminLogin, waitFor } = await import('../lib/harness.mjs');
const headersFor = (token, captureId, uploadId) => ({ 'x-session-token': token, 'x-capture-id': captureId, ...(uploadId ? { 'x-upload-id': uploadId } : {}) });
const journalCount = (event, clause = 'true') => Number(dbq(`SELECT count(*) FROM capture_evidence WHERE event_id='${event.id}' AND (${clause})`));
const journalHas = (event, capture, stage) => journalCount(event, `capture_id='${capture}' AND source='server' AND stage='${stage}'`) > 0;
const batch = (token, rows) => api('POST', '/api/photos/evidence', { headers: { 'x-session-token': token }, body: { events: rows } });
const single = (token, captureId, badFile = false) => {
  const body = new FormData();
  body.append('sessionToken', token); body.append('captureId', captureId);
  body.append('photo', new Blob([badFile ? 'not a picture' : img], { type: badFile ? 'text/plain' : 'image/jpeg' }), badFile ? 'reject.txt' : 'capture.jpg');
  return api('POST', '/api/photos', { headers: headersFor(token, captureId), body });
};
const chunk = (token, captureId, uploadId, index) => {
  const body = new FormData();
  for (const [k, v] of Object.entries({ sessionToken: token, captureId, uploadId, index: String(index), total: '1' })) body.append(k, v);
  body.append('chunk', new Blob([img], { type: 'application/octet-stream' }), 'chunk.bin');
  return api('POST', '/api/photos/chunk', { headers: { ...headersFor(token, captureId, uploadId), 'x-upload-index': String(index), 'x-upload-total': '1' }, body });
};
await spec('98k-upload-evidence', async () => {
  const fixtures = [];
  const ownerCookie = session.cookie;
  try {
    const event = await createEvent(); fixtures.push(event);
    const joined = await join(event.joinCode, 'Evidence guest');
    assert.equal(joined.status, 200);
    const token = joined.json.sessionToken;
    const participantId = joined.json.participant.id;
    const capture = randomUUID();
    const claim = { id: `${capture}:saved`, captureId: capture, stage: 'local_saved', at: Date.now(), bytes: img.length };
    group('Authenticated bounded metadata and real deduplication');
    ok('unauthenticated evidence rejected', (await batch('not-a-session', [claim])).status === 403);
    ok('client cannot forge server storage stage', (await batch(token, [{ ...claim, stage: 'server_stored' }])).status === 400);
    ok('metadata rejects raw error text', (await batch(token, [{ ...claim, reason: 'private browser error text' }])).status === 400);
    ok('metadata rejects invalid capture identifiers', (await batch(token, [{ ...claim, captureId: '../private' }])).status === 400);
    const fifty = Array.from({ length: 50 }, (_, i) => ({ ...claim, id: `${capture}:batch:${i}` }));
    ok('51 events rejected atomically', (await batch(token, [...fifty, { ...claim, id: `${capture}:overflow` }])).status === 400 && journalCount(event) === 0);
    const accepted = await batch(token, fifty);
    ok('50 events accepted and returned', accepted.status === 200 && accepted.json?.accepted?.length === 50);
    const replayBatch = await batch(token, fifty);
    ok('replayed batch returns all acknowledgements without duplicates', replayBatch.status === 200 && replayBatch.json?.accepted?.length === 50 && journalCount(event) === 50);
    ok('journal attributes authenticated participant and client source', journalCount(event, `participant_id='${participantId}' AND source='client'`) === 50);

    group('Single upload storage and replay after a discarded response');
    const singleCapture = randomUUID();
    const first = await single(token, singleCapture);
    assert.equal(first.status, 200);
    ok('single upload committed evidence arrives asynchronously', await waitFor(() => journalHas(event, singleCapture, 'server_stored'), 'single storage evidence'));
    const replayed = await single(token, singleCapture);
    ok('retry returns original photo after a discarded response', replayed.status === 200 && replayed.json?.photoId === first.json.photoId);
    ok('replay is distinguished from a new stored capture', await waitFor(() => journalHas(event, singleCapture, 'server_replayed'), 'replay evidence'));
    ok('replayed single request consumes exactly one shot', dbq(`SELECT photos_taken FROM participants WHERE id='${participantId}'`) === '1');

    group('Rejected chunk and parser attempt recover to the same committed capture');
    const chunkCapture = randomUUID();
    const uploadId = randomUUID();
    const rejected = await chunk(token, chunkCapture, uploadId, 'bogus');
    ok('invalid index returns ordinary chunk 400', rejected.status === 400 && rejected.json?.error === 'Bad chunk request');
    ok('invalid index has exact server rejection reason', await waitFor(() => journalCount(event, `capture_id='${chunkCapture}' AND stage='chunk_rejected' AND reason='invalid_chunk_index' AND upload_id='${uploadId}'`) === 1, 'chunk rejection evidence'));
    const parserRejected = await single(token, chunkCapture, true);
    ok('unsupported file is rejected before handler', parserRejected.status === 400);
    ok('parser failure is attributed using headers', await waitFor(() => journalCount(event, `capture_id='${chunkCapture}' AND reason='unsupported_media' AND source='server'`) === 1, 'parser evidence'));
    ok('corrected chunk accepted', (await chunk(token, chunkCapture, uploadId, 0)).status === 200);
    const completed = await api('POST', '/api/photos/complete', { headers: headersFor(token, chunkCapture, uploadId), body: { sessionToken: token, captureId: chunkCapture, uploadId, total: 1, ext: 'jpg', mediaType: 'photo' } });
    assert.equal(completed.status, 200, completed.text);
    ok('same capture contains rejection, accepted chunk and stored evidence', await waitFor(() => journalHas(event, chunkCapture, 'chunk_accepted') && journalHas(event, chunkCapture, 'server_stored'), 'completed chunk evidence'));
    const completeReplay = await api('POST', '/api/photos/complete', { headers: headersFor(token, chunkCapture, uploadId), body: { sessionToken: token, captureId: chunkCapture, uploadId, total: 1, ext: 'jpg', mediaType: 'photo' } });
    ok('completion can replay after parts have been removed', completeReplay.status === 200 && completeReplay.json?.photoId === completed.json.photoId);
    ok('completion replay has server evidence', await waitFor(() => journalHas(event, chunkCapture, 'server_replayed'), 'completion replay evidence'));
    ok('two unique captures mean two photos and two charged shots', dbq(`SELECT count(*) FROM photos WHERE event_id='${event.id}'`) === '2' && dbq(`SELECT photos_taken FROM participants WHERE id='${participantId}'`) === '2');

    group('Admin-only summaries distinguish client claims and current photo authority');
    const claimedCapture = randomUUID();
    const acknowledgement = { id: `${claimedCapture}:ack`, captureId: claimedCapture, stage: 'server_acknowledged', at: Date.now(), photoId: first.json.photoId };
    ok('client receipt claims accepted as claims', (await batch(token, [acknowledgement])).status === 200);
    const path = `/api/admin/upload-evidence?eventCode=${event.joinCode}`;
    ok('event owner is not automatically an evidence admin', (await api('GET', path)).status === 403);
    session.cookie = '';
    ok('anonymous evidence reader rejected', [401, 403].includes((await api('GET', path)).status));
    const admin = await adminLogin();
    assert.equal(admin.status, 200, 'orchestrator must provide development admin credentials');
    const adminCookie = session.cookie;
    // Simulate exactly one best-effort server journal outage, without touching the committed photo.
    const retainedClient = { id: `${chunkCapture}:saved`, captureId: chunkCapture, stage: 'local_saved', at: Date.now() };
    ok('capture metadata survives a simulated server journal outage', (await batch(token, [retainedClient])).status === 200);
    dbq(`DELETE FROM capture_evidence WHERE event_id='${event.id}' AND capture_id='${chunkCapture}' AND source='server'`);
    const summary = await api('GET', path);
    assert.equal(summary.status, 200, summary.text);
    const find = (r, c) => r.json?.captures?.find(x => x.captureId === c);
    ok('server confirmed stored photo appears in capture summary', find(summary, singleCapture)?.storedPhotoIds.includes(first.json.photoId));
    ok('forged client acknowledgement cannot create storage proof', find(summary, claimedCapture)?.clientAcknowledged === true && find(summary, claimedCapture)?.storedPhotoIds.length === 0 && summary.json?.clientClaimsAreUnverified === true);
    ok('canonical committed photo remains provable without server journal', find(summary, chunkCapture)?.storedPhotoIds.includes(completed.json.photoId));
    ok('summary is private and not cached', summary.headers.get('cache-control')?.includes('no-store'));
    session.cookie = ownerCookie;
    const deleted = await api('DELETE', `/api/photos/${first.json.photoId}`, { body: { sessionToken: token } });
    assert.equal(deleted.status, 200, deleted.text);
    session.cookie = adminCookie;
    const afterDelete = await api('GET', path);
    ok('deleted photo retains evidence but is no longer reported stored', find(afterDelete, singleCapture)?.stages.some(s => s.stage === 'server_stored') && find(afterDelete, singleCapture)?.storedPhotoIds.length === 0);

    group('Guests behind one network have independent evidence budgets');
    session.cookie = ownerCookie;
    const rateGuestA = await join(event.joinCode, 'Evidence rate A');
    const rateGuestB = await join(event.joinCode, 'Evidence rate B');
    assert.equal(rateGuestA.status, 200); assert.equal(rateGuestB.status, 200);
    const rateCapture = randomUUID();
    const rateClaim = { id: `${rateCapture}:saved`, captureId: rateCapture, stage: 'local_saved', at: Date.now() };
    const rateReplies = [];
    for (let i = 0; i < 31; i++) rateReplies.push(await batch(rateGuestA.json.sessionToken, [rateClaim]));
    ok('one guest has a 30-batch limit', rateReplies.slice(0, 30).every(r => r.status === 200) && rateReplies[30].status === 429);
    ok('invalid authentication cannot consume another guest budget', (await batch('unknown-session', [rateClaim])).status === 403);
    ok('another guest on the same network remains accepted', (await batch(rateGuestB.json.sessionToken, [rateClaim])).status === 200);
    session.cookie = adminCookie;

    group('Thirty-day metadata retention and event cascade');
    const agedId = fifty[0].id;
    dbq(`UPDATE capture_evidence SET received_at=${Date.now() - 31 * 24 * 3600_000} WHERE event_id='${event.id}' AND evidence_id='${agedId}' AND source='client'`);
    ok('admin diagnostic retention sweep succeeds', (await api('POST', '/api/admin/run-sweep')).status === 200);
    ok('old metadata removed while current evidence survives', journalCount(event, `evidence_id='${agedId}'`) === 0 && journalCount(event, `evidence_id='${fifty[1].id}'`) === 1);
    session.cookie = ownerCookie;
    ok('event removal succeeds', (await api('DELETE', `/api/events/${event.joinCode}`, { headers: org(event.organizerCode) })).status === 200);
    ok('event deletion cascades metadata evidence', journalCount(event) === 0);
    fixtures.length = 0;
  } finally {
    session.cookie = ownerCookie;
    for (const event of fixtures) await api('DELETE', `/api/events/${event.joinCode}`, { headers: org(event.organizerCode) });
  }
});
