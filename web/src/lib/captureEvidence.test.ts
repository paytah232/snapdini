import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { acknowledgeCapture, delCapture, getProgress, listCaptures, putCapture, saveProgress, type StoredCapture } from './captureStore';
import { appendCaptureEvidence, flushCaptureEvidence, persistCaptureEvidence, remapCaptureEvidence, type CaptureEvidenceRecord } from './captureEvidence';
const item = (id = 'capture-1', token = 'guest-token'): StoredCapture => ({ id, joinCode: 'TEST1234', sessionToken: token, blob: new Blob(['photobytes']), mediaType: 'photo', ext: 'jpg', createdAt: 1000 });
async function dbOpen(name: string, version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => { const r = version ? indexedDB.open(name, version) : indexedDB.open(name); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}
async function journal(): Promise<CaptureEvidenceRecord[]> {
  const db = await dbOpen('snapdini-capture-evidence');
  try { return await new Promise((resolve, reject) => { const r = db.transaction('events').objectStore('events').getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); }
  finally { db.close(); }
}
function acceptingFetch() { return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body));
  return new Response(JSON.stringify({ accepted: body.events.map((e: { id: string }) => e.id) }));
}); }
beforeEach(() => { vi.stubGlobal('indexedDB', new IDBFactory()); vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('durable capture evidence', () => {
  it('preserves legacy v1 blobs and upgrades progress without breaking v2 camera connections', async () => {
    await new Promise<void>((resolve, reject) => {
      const r = indexedDB.open('snapdini-captures', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('queue', { keyPath: 'id' });
      r.onsuccess = () => { const db = r.result; const t = db.transaction('queue', 'readwrite'); t.objectStore('queue').put(item()); t.oncomplete = () => { db.close(); resolve(); }; t.onerror = () => reject(t.error); };
    });
    expect(await listCaptures('TEST1234')).toHaveLength(1);
    await saveProgress({ id: 'capture-1', uploadId: 'upload-1', doneChunks: [0] });
    await appendCaptureEvidence(item(), 'local_saved');
    const old = await dbOpen('snapdini-captures', 2); expect(old.version).toBe(2); old.close();
    expect((await getProgress('capture-1'))?.doneChunks).toEqual([0]);
  });
  it('keeps stable saved IDs/timestamps across retry and ownership reconciliation', async () => {
    await putCapture(item('capture-1', 'offline_nonce')); const first = (await journal())[0];
    await putCapture(item('capture-1', 'offline_nonce'));
    await remapCaptureEvidence('TEST1234', 'offline_nonce', 'real-token');
    await putCapture(item('capture-1', 'real-token'));
    const rows = await journal(); expect(rows).toHaveLength(1); expect(rows[0].id).toBe(first.id); expect(rows[0].at).toBe(first.at); expect(rows[0].sessionToken).toBe('real-token');
  });
  it('durably journals the receipt then deletes both blob and chunk progress', async () => {
    await putCapture(item()); await saveProgress({ id: 'capture-1', uploadId: 'upload-1', doneChunks: [0, 1] });
    await acknowledgeCapture(item(), '00000000-0000-4000-a000-000000000001');
    expect(await listCaptures('TEST1234')).toEqual([]); expect(await getProgress('capture-1')).toBeNull();
    expect((await journal()).find(r => r.stage === 'server_acknowledged')?.photoId).toBe('00000000-0000-4000-a000-000000000001');
    await acknowledgeCapture(item(), '00000000-0000-4000-a000-000000000001'); expect((await journal()).filter(r => r.stage === 'server_acknowledged')).toHaveLength(1);
  });
  it('survives a crash after durable receipt but before queue cleanup', async () => {
    await putCapture(item()); const original = indexedDB.open.bind(indexedDB);
    const failure = vi.spyOn(indexedDB, 'open').mockImplementation((name: string, version?: number) => {
      if (name === 'snapdini-captures') throw new Error('interrupted cleanup');
      return original(name, version);
    });
    await expect(acknowledgeCapture(item(), '00000000-0000-4000-a000-000000000001')).rejects.toThrow('interrupted cleanup');
    expect((await journal()).filter(r => r.stage === 'server_acknowledged')).toHaveLength(1);
    failure.mockRestore(); expect(await listCaptures('TEST1234')).toHaveLength(1);
    await acknowledgeCapture(item(), '00000000-0000-4000-a000-000000000001');
    expect(await listCaptures('TEST1234')).toEqual([]);
    expect((await journal()).filter(r => r.stage === 'server_acknowledged')).toHaveLength(1);
  });
  it('retains the blob when receipt persistence fails and permits explicit removal despite telemetry failure', async () => {
    await putCapture(item()); const realOpen = indexedDB.open.bind(indexedDB);
    vi.spyOn(indexedDB, 'open').mockImplementation((name: string, version?: number) => { if (name === 'snapdini-capture-evidence') throw new Error('QuotaExceededError'); return realOpen(name, version); });
    await expect(acknowledgeCapture(item(), '00000000-0000-4000-a000-000000000001')).rejects.toThrow('QuotaExceededError'); expect(await listCaptures('TEST1234')).toHaveLength(1);
    await putCapture(item('capture-2')); expect(await listCaptures('TEST1234')).toHaveLength(2);
    await delCapture('capture-1'); expect((await listCaptures('TEST1234'))[0].id).toBe('capture-2');
  });
  it('records explicit removal separately from server delivery', async () => {
    await putCapture(item()); await delCapture('capture-1');
    expect((await journal()).map(r => r.stage).sort()).toEqual(['local_removed', 'local_saved']);
  });
  it('retries the same event IDs after a lost response and never puts credentials/blobs in JSON', async () => {
    await putCapture(item()); await appendCaptureEvidence(item(), 'upload_failed', { reason: 'network', httpStatus: 503 });
    const ids = (await journal()).map(r => r.id);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('lost response')));
    await flushCaptureEvidence(); expect((await journal()).map(r => r.id)).toEqual(ids);
    const send = acceptingFetch(); vi.stubGlobal('fetch', send); await flushCaptureEvidence();
    const payload = JSON.parse(String(send.mock.calls[0][1]?.body)); expect(payload.events.map((e: { id: string }) => e.id)).toEqual(ids);
    expect(JSON.stringify(payload)).not.toContain('guest-token'); expect(JSON.stringify(payload)).not.toContain('TEST1234'); expect(payload.events[0].blob).toBeUndefined();
    expect(send.mock.calls[0][1]?.headers).toMatchObject({ 'X-Session-Token': 'guest-token' }); expect(await journal()).toEqual([]);
  });
  it('isolates guests and defers provisional sessions until matching event/token reconciliation', async () => {
    await putCapture(item('capture-first', 'guest-one')); await putCapture(item('capture-second', 'guest-two')); await putCapture(item('capture-third', 'offline_nonce'));
    const send = acceptingFetch(); vi.stubGlobal('fetch', send); await flushCaptureEvidence(); expect(send).toHaveBeenCalledTimes(2);
    for (const [, init] of send.mock.calls) expect(JSON.parse(String(init?.body)).events).toHaveLength(1);
    expect((await journal())[0].captureId).toBe('capture-third');
    await remapCaptureEvidence('WRONG', 'offline_nonce', 'real'); await flushCaptureEvidence(); expect(send).toHaveBeenCalledTimes(2);
    await remapCaptureEvidence('TEST1234', 'offline_nonce', 'real'); await flushCaptureEvidence(); expect(send).toHaveBeenCalledTimes(3); expect(await journal()).toEqual([]);
  });
  it('does not delete unaccepted or concurrently remapped evidence', async () => {
    await putCapture(item());
    vi.stubGlobal('fetch', vi.fn(async () => { await remapCaptureEvidence('TEST1234', 'guest-token', 'rotated'); return new Response(JSON.stringify({ accepted: ['capture-1:saved'] })); }));
    await flushCaptureEvidence(); expect((await journal())[0].sessionToken).toBe('rotated');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ accepted: [] })))); await flushCaptureEvidence(); expect(await journal()).toHaveLength(1);
  });
  it('suppresses offline requests and bounds singleflight batches to 50', async () => {
    for (let i = 0; i < 53; i++) await persistCaptureEvidence(item(`capture-${i}`), 'local_saved');
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false); const send = acceptingFetch(); vi.stubGlobal('fetch', send);
    await flushCaptureEvidence(); expect(send).not.toHaveBeenCalled();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true); await Promise.all([flushCaptureEvidence(), flushCaptureEvidence()]); expect(send).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(send.mock.calls[0][1]?.body)).events).toHaveLength(50); expect(JSON.parse(String(send.mock.calls[1][1]?.body)).events).toHaveLength(3);
  });
  it('rejects blocked evidence opens promptly and closes late successful connections', async () => {
    await putCapture(item());
    const request = { onblocked: null, onsuccess: null, onerror: null, result: { close: vi.fn() } } as unknown as IDBOpenDBRequest;
    const original = indexedDB.open.bind(indexedDB);
    vi.spyOn(indexedDB, 'open').mockImplementation((name: string, version?: number) => {
      if (name !== 'snapdini-capture-evidence') return original(name, version);
      queueMicrotask(() => request.onblocked?.call(request, new Event('blocked') as IDBVersionChangeEvent));
      return request;
    });
    await expect(acknowledgeCapture(item())).rejects.toThrow('blocked');
    expect(await listCaptures('TEST1234')).toHaveLength(1);
    request.onsuccess?.call(request, new Event('success')); expect(request.result.close).toHaveBeenCalledOnce();
  });
  it('times out an unresponsive journal open and allows capture persistence to finish', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(indexedDB, 'open').mockReturnValue({} as IDBOpenDBRequest);
      const saving = appendCaptureEvidence(item(), 'local_saved');
      await vi.advanceTimersByTimeAsync(2001); await saving;
    } finally { vi.useRealTimers(); }
  });
  it('excludes unsafe raw error strings and invalid numeric fields', async () => {
    await appendCaptureEvidence(item(), 'upload_failed', { reason: 'Authorization: Bearer secret', httpStatus: -1, bytes: Number.NaN });
    const row = (await journal())[0]; expect(row.reason).toBeUndefined(); expect(row.httpStatus).toBeUndefined(); expect(row.bytes).toBe(10);
  });
});
