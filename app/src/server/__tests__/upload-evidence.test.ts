import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
let actorRows: unknown[] = [{ id: 'guest1', eventId: 'event1' }];
let photoRows: unknown[] = [{ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }];
let journalRows: unknown[] = [];
let inserted: any[] = [];
let failInsert = false;
function chain(result: () => unknown): any {
  const c: any = {
    where: () => c, limit: () => c, orderBy: () => c, onConflictDoNothing: () => c, values: (v: any) => { c.v = v; return c; }, then: (yes: any, no: any) => Promise.resolve().then(() => result()).then(yes, no)
  };
  return c;
}
const dbPath = require.resolve('../db');
require(dbPath);
require.cache[dbPath]!.exports = { db: { select: () => ({ from: (t: any) => chain(() => t[Symbol.for('drizzle:Name')] === 'participants' ? actorRows : t[Symbol.for('drizzle:Name')] === 'photos' ? photoRows : journalRows) }), insert: () => { let c: any; c = chain(() => { if (failInsert)
      throw Error('db unavailable'); inserted.push(...c.v); return []; }); return c; } } };
const { parseClientEvidence, acceptClientEvidence, observeUpload, rejectionReason, evidenceForEvent, observeUploadParserError, replayedReceipt } = require('../upload-evidence') as typeof import('../upload-evidence');
const valid = {
  id: 'capture001:local_saved', captureId: 'capture001', stage: 'local_saved', at: 123
};
function request(body: any = {}, headers: Record<string, string> = {}, path = '/chunk'): any { return {
  body, path, get: (k: string) => headers[k]
}; }
function response(): any { return {
  statusCode: 200, body: null, set() { return this; }, status(s: number) { this.statusCode = s; return this; }, json(v: any) { this.body = v; return this; }
}; }
const tick = () => new Promise(r => setTimeout(r, 15));
beforeEach(() => { actorRows = [{ id: 'guest1', eventId: 'event1' }]; photoRows = [{ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }]; journalRows = []; inserted = []; failInsert = false; });
test('client validation excludes server stages, arbitrary strings, bad numbers, oversized batches, and payload data', () => {
  assert.equal(parseClientEvidence([{ ...valid, stage: 'server_stored' }]), null);
  assert.equal(parseClientEvidence([{ ...valid, reason: 'private error with token' }]), null);
  assert.equal(parseClientEvidence([{ ...valid, bytes: -1 }]), null);
  assert.equal(parseClientEvidence([{ ...valid, captureId: '../private' }]), null);
  assert.equal(parseClientEvidence(Array(51).fill(valid)), null);
  assert.deepEqual(parseClientEvidence([{
      ...valid, sessionToken: 'SECRET', message: 'PRIVATE'
    }]), [valid]);
  assert.ok(parseClientEvidence([{
      ...valid, reason: 'http_503', httpStatus: 503
    }]));
});
test('client claims derive identity from session and use participant/source/id dedup namespace', async () => {
  const res = response();
  await acceptClientEvidence(request({ events: [{
        ...valid, eventId: 'forged', participantId: 'forged'
      }] }, { 'x-session-token': 'session123' }), res, () => { });
  assert.deepEqual(res.body, { accepted: [valid.id] });
  assert.equal(inserted[0].participantId, 'guest1');
  assert.equal(inserted[0].eventId, 'event1');
  assert.equal(inserted[0].source, 'client');
  assert.equal(inserted[0].evidenceId, valid.id);
  assert.equal(JSON.stringify(inserted).includes('session123'), false);
});
test('unauthenticated evidence cannot create rows', async () => {
  actorRows = [];
  const res = response();
  await acceptClientEvidence(request({ events: [valid] }, { 'x-session-token': 'wrong123' }), res, () => { });
  assert.equal(res.statusCode, 403);
  assert.equal(inserted.length, 0);
});
test('chunk rejection retains exact bounded reason and correlation', async () => {
  const req = request({
    sessionToken: 'session123', captureId: 'capture001', uploadId: 'upload001', index: 2, total: 3
  });
  const res = response();
  observeUpload(req, res, () => { });
  res.status(400).json({ error: 'Bad chunk request' });
  await tick();
  assert.equal(inserted[1].stage, 'chunk_rejected');
  assert.equal(inserted[1].reason, 'bad_chunk_request');
  assert.equal(inserted[1].uploadId, 'upload001');
  assert.equal(inserted[1].chunkIndex, 2);
});
test('parser rejection can be attributed from headers before multipart fields exist', async () => {
  const req = request({}, {
    'x-session-token': 'session123', 'x-capture-id': 'capture001', 'x-upload-id': 'upload001'
  });
  const res = response();
  observeUpload(req, res, () => { });
  observeUploadParserError({ code: 'LIMIT_FILE_SIZE' }, req, res, () => { });
  res.status(413).json({ error: 'File too large' });
  await tick();
  assert.equal(inserted[1].reason, 'file_too_large');
  assert.equal(inserted[1].captureId, 'capture001');
});
test('server stored requires authoritative photo row, telemetry failure never changes response', async () => {
  const req = request({ sessionToken: 'session123', captureId: 'capture001' }, {}, '/');
  const res = response();
  observeUpload(req, res, () => { });
  res.json({ photoId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' });
  await tick();
  assert.equal(inserted[1].stage, 'server_stored');
  inserted = [];
  photoRows = [];
  const res2 = response();
  observeUpload(req, res2, () => { });
  res2.json({ photoId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' });
  await tick();
  assert.equal(inserted[1].stage, 'response_sent');
  failInsert = true;
  const res3 = response();
  observeUpload(req, res3, () => { });
  res3.json({ success: true });
  assert.deepEqual(res3.body, { success: true });
  await tick();
});
test('summary keeps client acknowledgements distinct and does not claim deleted photos are stored', async () => {
  journalRows = [{
      id: 'evidence1', source: 'client', stage: 'server_acknowledged', participantId: 'guest1', captureId: 'capture001', photoId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    }, {
      id: 'evidence2', source: 'server', stage: 'server_stored', participantId: 'guest1', captureId: 'capture001', photoId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    }];
  photoRows = [];
  const summary = await evidenceForEvent('event1', 50);
  assert.equal(summary.captures[0].clientAcknowledged, true);
  assert.deepEqual(summary.captures[0].storedPhotoIds, []);
  assert.equal(summary.clientClaimsAreUnverified, true);
});
test('rejection mapping never persists raw errors', () => { assert.equal(rejectionReason('postgres secret detail'), 'other_rejection'); assert.equal(rejectionReason('Missing chunks'), 'missing_chunks'); });
test('fully accepted batch can replay at the roll cap after a lost response', async () => {
  journalRows = Array.from({ length: 5000 }, (_, i) => ({ evidenceId: i === 0 ? valid.id : `existing:${i}` }));
  const res = response();
  await acceptClientEvidence(request({ events: [valid] }, { 'x-session-token': 'session123' }), res, () => { });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { accepted: [valid.id] });
});
test('conflicting header/body sessions cannot misattribute server evidence', async () => {
  const req = request({ sessionToken: 'session123', captureId: 'capture001' }, { 'x-session-token': 'different123' });
  const res = response();
  observeUpload(req, res, () => { });
  res.status(400).json({ error: 'Bad chunk request' });
  await tick();
  assert.equal(inserted.length, 0);
});
test('server correlation follows the body capture actually committed, rather than conflicting headers', async () => {
  const req = request({
    sessionToken: 'session123', captureId: 'capture001', uploadId: 'upload001', index: '2', total: '3'
  }, {
    'x-capture-id': 'capture999', 'x-upload-id': 'upload999', 'x-upload-index': '9'
  });
  const res = response();
  observeUpload(req, res, () => { });
  res.json({ photoId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' });
  await tick();
  assert.equal(inserted[1].captureId, 'capture001');
  assert.equal(inserted[1].uploadId, 'upload001');
  assert.equal(inserted[1].chunkIndex, 2);
});
test('canonical photo row proves storage when the server journal failed, without trusting client photoId', async () => {
  const { canonicalCapturePhotoId } = require('../capture-photo-id');
  journalRows = [{
      id: 'claim0001', source: 'client', stage: 'local_saved', participantId: 'guest1', captureId: 'capture001', photoId: 'ffffffff-ffff-ffff-ffff-ffffffffffff'
    }];
  const id = canonicalCapturePhotoId('capture001', { eventId: 'event1', id: 'guest1' });
  photoRows = [{ id, participantId: 'guest1' }];
  const summary = await evidenceForEvent('event1', 50);
  assert.deepEqual(summary.captures[0].storedPhotoIds, [id]);
  photoRows = [{ id, participantId: 'different-guest' }];
  const wrongOwner = await evidenceForEvent('event1', 50);
  assert.deepEqual(wrongOwner.captures[0].storedPhotoIds, []);
});
test('participant rate-limit keys separate guests behind one IP and require authentication', async () => {
  const { requireEvidenceParticipant, evidenceParticipantKey } = require('../upload-evidence');
  const a = request({}, { 'x-session-token': 'session123' });
  a.ip = '192.0.2.1';
  const b = request({}, { 'x-session-token': 'session456' });
  b.ip = a.ip;
  await requireEvidenceParticipant(a, response(), () => { });
  actorRows = [{ id: 'guest2', eventId: 'event1' }];
  await requireEvidenceParticipant(b, response(), () => { });
  assert.notEqual(evidenceParticipantKey(a), evidenceParticipantKey(b));
  assert.equal(evidenceParticipantKey(a), 'guest1');
  actorRows = [];
  const unauth = request({}, { 'x-session-token': 'unknown123' });
  const res = response();
  let next = false;
  await requireEvidenceParticipant(unauth, res, () => { next = true; });
  assert.equal(next, false);
  assert.equal(res.statusCode, 403);
  assert.throws(() => evidenceParticipantKey(unauth));
});

test('deleted upload acknowledgement cannot create replayed or current storage proof', async () => {
  photoRows = [];
  const req = request({ sessionToken: 'session123', captureId: 'capture001' }, {}, '/');
  const res = response();
  observeUpload(req, res, () => { });
  const receipt = replayedReceipt({ success: true, deleted: true, status: 'deleted',
    photoId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', photosRemaining: 12 });
  res.json(receipt);
  assert.equal(res.body, receipt, 'telemetry must preserve successful tombstone acknowledgement');
  await tick();
  assert.deepEqual(inserted.map(row => row.stage), ['received', 'response_sent']);
  assert.equal(inserted[1].photoId, null);
  journalRows = [...inserted, {
    id: 'old-storage', source: 'server', stage: 'server_stored', participantId: 'guest1', captureId: 'capture001',
    photoId: receipt.photoId,
  }, {
    id: 'old-replay', source: 'server', stage: 'server_replayed', participantId: 'guest1', captureId: 'capture001',
    photoId: receipt.photoId,
  }];
  const summary = await evidenceForEvent('event1', 50);
  assert.deepEqual(summary.captures[0].storedPhotoIds, []);
  assert.ok(summary.captures[0].stages.some(row => row.stage === 'server_replayed'),
    'historical replay is retained as historical evidence only');
});
