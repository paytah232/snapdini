// A separate database deliberately leaves old camera tabs (queue DB version 2) compatible.
// No blobs, image names, email addresses, or session credentials are sent in event JSON.
const DB = 'snapdini-capture-evidence';
const STORE = 'events';
export type CaptureEvidenceStage = 'local_saved' | 'upload_started' | 'upload_failed' | 'server_acknowledged' | 'local_removed';
export interface CaptureMetadata { id: string; joinCode: string; sessionToken: string; blob?: Blob }
export interface CaptureEvidenceFields {
  uploadId?: string; chunkIndex?: number; chunkTotal?: number; bytes?: number;
  httpStatus?: number; reason?: string; photoId?: string;
}
export interface CaptureEvidenceRecord extends CaptureEvidenceFields {
  id: string; captureId: string; joinCode: string; sessionToken: string; stage: CaptureEvidenceStage; at: number;
}
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let request: IDBOpenDBRequest;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true; clearTimeout(timeout); reject(error);
    };
    const timeout = setTimeout(() => fail(new Error('Capture evidence storage timed out')), 2000);
    try { request = indexedDB.open(DB, 1); }
    catch (error) { fail(error); return; }
    request.onupgradeneeded = () => {
      if (settled) { request.transaction?.abort(); return; }
      request.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    request.onblocked = () => fail(new Error('Capture evidence storage is blocked'));
    request.onsuccess = () => {
      if (settled) { request.result.close(); return; }
      settled = true; clearTimeout(timeout); resolve(request.result);
    };
    request.onerror = () => fail(request.error);
  });
}
function transactionDone(t: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = t.onabort = () => reject(t.error || new Error('Capture evidence could not be saved'));
  });
}
function safeFields(fields: CaptureEvidenceFields): CaptureEvidenceFields {
  const result: CaptureEvidenceFields = {};
  const bounds = { chunkIndex: 10000, chunkTotal: 10000, bytes: 16 * 1024 ** 3, httpStatus: 599 };
  for (const key of ['chunkIndex', 'chunkTotal', 'bytes', 'httpStatus'] as const) {
    const value = fields[key];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= bounds[key]) result[key] = value;
  }
  if (typeof fields.uploadId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(fields.uploadId)) result.uploadId = fields.uploadId;
  if (typeof fields.photoId === 'string' && /^[a-fA-F0-9-]{36}$/.test(fields.photoId)) result.photoId = fields.photoId;
  // Only application-defined codes, never a raw response/error potentially containing secrets.
  if (typeof fields.reason === 'string' && (['network','timeout','http_error','storage_error','storage_unavailable','user_removed','uploaded','unknown'].includes(fields.reason) || /^http_[1-5][0-9]{2}$/.test(fields.reason))) result.reason = fields.reason;
  return result;
}
/** Strict persistence: receipt evidence must land BEFORE a queued blob can be removed. */
export async function persistCaptureEvidence(c: CaptureMetadata, stage: CaptureEvidenceStage, fields: CaptureEvidenceFields = {}): Promise<void> {
  if (typeof indexedDB === 'undefined') throw new Error('Capture evidence storage unavailable');
  const stable = stage === 'local_saved' ? 'saved' : stage === 'server_acknowledged' ? 'ack' : stage === 'local_removed' ? 'removed' : null;
  const row: CaptureEvidenceRecord = {
    id: stable ? `${c.id}:${stable}` : (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)),
    captureId: c.id, joinCode: c.joinCode, sessionToken: c.sessionToken, stage, at: Date.now(),
    ...(c.blob ? { bytes: c.blob.size } : {}), ...safeFields(fields)
  };
  const db = await open();
  try {
    const t = db.transaction(STORE, 'readwrite');
    const done = transactionDone(t);
    const store = t.objectStore(STORE);
    // Preserve the first timestamp and stable event ID through retries and ownership remapping.
    const previous = store.get(row.id);
    previous.onsuccess = () => {
      const old = previous.result as CaptureEvidenceRecord | undefined;
      store.put(old ? { ...old, sessionToken: c.sessionToken, ...safeFields(fields) } : row);
    };
    await done;
  } finally { db.close(); }
}
/** Attempt telemetry must never prevent a capture or upload. */
export async function appendCaptureEvidence(c: CaptureMetadata, stage: CaptureEvidenceStage, fields: CaptureEvidenceFields = {}): Promise<void> {
  try { await persistCaptureEvidence(c, stage, fields); } catch { /* Local capture/receipt durability is handled separately. */ }
}
export async function remapCaptureEvidence(joinCode: string, oldToken: string, newToken: string): Promise<void> {
  if (typeof indexedDB === 'undefined' || oldToken === newToken) return;
  const db = await open();
  try {
    const t = db.transaction(STORE, 'readwrite');
    const done = transactionDone(t);
    const store = t.objectStore(STORE);
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      const row = cursor.result;
      if (!row) return;
      if (row.value.joinCode === joinCode && row.value.sessionToken === oldToken) row.update({ ...row.value, sessionToken: newToken });
      row.continue();
    };
    await done;
  } finally { db.close(); }
}
async function list(): Promise<CaptureEvidenceRecord[]> {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const r = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  } finally { db.close(); }
}
async function removeAccepted(rows: CaptureEvidenceRecord[], accepted: Set<string>): Promise<void> {
  const db = await open();
  try {
    const t = db.transaction(STORE, 'readwrite');
    const done = transactionDone(t);
    const store = t.objectStore(STORE);
    for (const row of rows) {
      if (!accepted.has(row.id)) continue;
      const request = store.get(row.id);
      request.onsuccess = () => {
        // A concurrent ownership reconciliation must not have its journal deleted by an old request.
        const current = request.result as CaptureEvidenceRecord | undefined;
        if (current?.sessionToken === row.sessionToken && current.at === row.at) store.delete(row.id);
      };
    }
    await done;
  } finally { db.close(); }
}
let flushing: Promise<void> | null = null;
/** Called on reconnect/foreground and periodically. A failed response retains the same dedup IDs. */
export function flushCaptureEvidence(): Promise<void> {
  if (flushing) return flushing;
  flushing = flush().catch(() => {}).finally(() => { flushing = null; });
  return flushing;
}
async function flush(): Promise<void> {
  if (typeof indexedDB === 'undefined' || (typeof navigator !== 'undefined' && navigator.onLine === false)) return;
  const rows = await list();
  const groups = new Map<string, CaptureEvidenceRecord[]>();
  for (const row of rows) {
    if (!row.sessionToken || row.sessionToken.startsWith('offline_') || !/^[A-Za-z0-9_-]{8,128}$/.test(row.captureId)) continue;
    const key = JSON.stringify([row.joinCode, row.sessionToken]);
    const group = groups.get(key) || [];
    group.push(row); groups.set(key, group);
  }
  // At most 20 small requests per invocation; pending evidence is never age-evicted before delivery.
  let budget = 20;
  for (const group of groups.values()) {
    for (let offset = 0; offset < group.length && budget > 0; offset += 50) {
      budget--;
      const batch = group.slice(offset, offset + 50);
      const events = batch.map(({ sessionToken: _secret, joinCode: _localEvent, ...record }) => record);
      try {
        const response = await fetch('/api/photos/evidence', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Session-Token': batch[0].sessionToken },
          body: JSON.stringify({ events }), signal: AbortSignal.timeout(15000)
        });
        if (!response.ok) break;
        const result = await response.json();
        if (!Array.isArray(result.accepted)) break;
        await removeAccepted(batch, new Set(result.accepted.filter((id: unknown): id is string => typeof id === 'string')));
      } catch { break; }
    }
  }
}
