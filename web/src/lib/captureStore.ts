// Offline-durable capture queue. Photos/videos are stored in IndexedDB the moment they're
// taken, so they survive a flaky connection, a server outage, OR a page reload/close — they
// upload (or retry) when the connection + server come back. Nothing relies on the network at
// capture time, so "captured moments" aren't lost.

const DB = 'snapdini-captures';
const STORE = 'queue';
// Small side-store for chunked-upload resume state, keyed by capture id. Kept separate from the
// blob so we can update progress after every chunk WITHOUT re-writing the (potentially huge) blob.
const PROGRESS = 'progress';

export interface StoredCapture {
  id: string;
  joinCode: string;
  sessionToken: string;
  blob: Blob;
  mediaType: 'photo' | 'video';
  ext: string;
  createdAt: number;
}

// Resume state for a chunked upload: the server-side upload id and which chunk indices already landed.
export interface UploadProgress {
  id: string;        // capture id
  uploadId: string;  // server reassembly id (stable across reloads)
  doneChunks: number[];
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 2);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(PROGRESS)) db.createObjectStore(PROGRESS, { keyPath: 'id' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

const available = () => typeof indexedDB !== 'undefined';

export async function putCapture(c: StoredCapture): Promise<void> {
  if (!available()) return;
  const db = await open();
  await new Promise<void>((res, rej) => {
    const t = db.transaction(STORE, 'readwrite');
    t.objectStore(STORE).put(c);
    t.oncomplete = () => res(); t.onerror = () => rej(t.error);
  });
  db.close();
}

export async function delCapture(id: string): Promise<void> {
  if (!available()) return;
  const db = await open();
  await new Promise<void>((res, rej) => {
    const t = db.transaction([STORE, PROGRESS], 'readwrite');
    t.objectStore(STORE).delete(id);
    t.objectStore(PROGRESS).delete(id);   // uploaded/dropped → clear any resume state too
    t.oncomplete = () => res(); t.onerror = () => rej(t.error);
  });
  db.close();
}

// Persist chunked-upload progress so a suspended/reloaded tab RESUMES from the last landed chunk
// instead of restarting the whole upload. Cheap: writes only the id + chunk list, never the blob.
export async function saveProgress(p: UploadProgress): Promise<void> {
  if (!available()) return;
  const db = await open();
  await new Promise<void>((res, rej) => {
    const t = db.transaction(PROGRESS, 'readwrite');
    t.objectStore(PROGRESS).put(p);
    t.oncomplete = () => res(); t.onerror = () => rej(t.error);
  });
  db.close();
}

export async function getProgress(id: string): Promise<UploadProgress | null> {
  if (!available()) return null;
  const db = await open();
  const p = await new Promise<UploadProgress | null>((res, rej) => {
    const t = db.transaction(PROGRESS, 'readonly');
    const req = t.objectStore(PROGRESS).get(id);
    req.onsuccess = () => res((req.result as UploadProgress) || null);
    req.onerror = () => rej(req.error);
  });
  db.close();
  return p;
}

export async function listCaptures(joinCode: string): Promise<StoredCapture[]> {
  if (!available()) return [];
  const db = await open();
  const all = await new Promise<StoredCapture[]>((res, rej) => {
    const t = db.transaction(STORE, 'readonly');
    const req = t.objectStore(STORE).getAll();
    req.onsuccess = () => res((req.result as StoredCapture[]) || []);
    req.onerror = () => rej(req.error);
  });
  db.close();
  return all.filter((c) => c.joinCode === joinCode).sort((a, b) => a.createdAt - b.createdAt);
}
