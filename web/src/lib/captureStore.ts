// Offline-durable capture queue. Photos/videos are stored in IndexedDB the moment they're
// taken, so they survive a flaky connection, a server outage, OR a page reload/close — they
// upload (or retry) when the connection + server come back. Nothing relies on the network at
// capture time, so "captured moments" aren't lost.

const DB = 'snapdini-captures';
const STORE = 'queue';

export interface StoredCapture {
  id: string;
  joinCode: string;
  sessionToken: string;
  blob: Blob;
  mediaType: 'photo' | 'video';
  ext: string;
  createdAt: number;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
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
    const t = db.transaction(STORE, 'readwrite');
    t.objectStore(STORE).delete(id);
    t.oncomplete = () => res(); t.onerror = () => rej(t.error);
  });
  db.close();
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
