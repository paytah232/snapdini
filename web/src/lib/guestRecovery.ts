import { writable } from 'svelte/store';
import { ApiError } from './api';
import { getEvent, getMe, joinEvent, setParticipantEmail, setPhotoOptIn, type PublicEvent } from './events';
import { serverNow } from './serverClock';

type Me = Awaited<ReturnType<typeof getMe>>;
export const recoveryState = writable(false);
const key = (kind: string, id: string) => `snap_recovery_${kind}_${id}`;
function read<T>(kind: string, id: string): T | null {
  try { return JSON.parse(localStorage.getItem(key(kind, id)) || 'null') as T | null; }
  catch { return null; }
}
function write(kind: string, id: string, value: unknown): void {
  localStorage.setItem(key(kind, id), JSON.stringify(value));
}
export function temporaryFailure(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 0 || error.status === 408 || error.status >= 500);
}

function currentEvent(ev: PublicEvent): PublicEvent {
  return { ...ev, isUpcoming: serverNow() < ev.startsAt, isExpired: serverNow() > ev.expiresAt };
}
function validEvent(ev: PublicEvent | null, identifier: string): ev is PublicEvent {
  return !!ev && typeof ev.joinCode === 'string'
    && (ev.joinCode === identifier.toUpperCase() || ev.slug === identifier.toLowerCase())
    && Number.isFinite(ev.startsAt) && Number.isFinite(ev.expiresAt)
    && Number.isInteger(ev.maxPhotos) && ev.maxPhotos > 0;
}
function cacheEvent(ev: PublicEvent): void {
  // Never persist organizer credentials, even for a demo. Cached metadata grants no API access.
  const { organizerCode, youManage, ...safe } = ev;
  try {
    write('event', ev.joinCode, safe);
    if (ev.slug) write('event', ev.slug, safe);
  } catch { /* The live app can still work without metadata caching. */ }
}

function cachedEvent(identifier: string): PublicEvent | null {
  const cached = read<PublicEvent>('event', identifier)
    ?? read<PublicEvent>('event', identifier.toUpperCase()) ?? read<PublicEvent>('event', identifier.toLowerCase());
  return validEvent(cached, identifier) ? cached : null;
}
export function savedRecoveryCode(identifier: string): string {
  return cachedEvent(identifier)?.joinCode ?? identifier.toUpperCase();
}

export async function recoveryEvent(identifier: string): Promise<PublicEvent> {
  try {
    const ev = await getEvent(identifier);
    cacheEvent(ev); recoveryState.set(false); return ev;
  } catch (error) {
    if (!temporaryFailure(error)) throw error; // Never override an authoritative refusal/deletion.
    recoveryState.set(true);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(identifier)) throw error;
    const snapshotKey = typeof location !== 'undefined' && location.pathname.startsWith('/guest/e/')
      ? identifier.toLowerCase() : identifier.toUpperCase();
    try {
      const response = await fetch(`/guest/events/${encodeURIComponent(snapshotKey)}.json`,
        { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        const snapshot = await response.json();
        if (snapshot.schema === 1 && validEvent(snapshot.event, identifier)) {
          cacheEvent(snapshot.event); return currentEvent(snapshot.event);
        }
      } else if (response.status === 410) {
        // An explicit withdrawal is final. A missing static file (404) can simply mean a
        // newly created event has not been published yet; its previously fetched settings
        // still permit local preservation. The primary API's own refusals never reach here.
        throw new ApiError('This event is no longer available.', response.status);
      }
    } catch (snapshotError) {
      if (snapshotError instanceof ApiError) throw snapshotError;
    }
    const cached = cachedEvent(identifier);
    if (cached) return currentEvent(cached);
    throw error;
  }
}

export function rememberGuest(token: string, me: Me, required = false): void {
  try { write('me', token, me); } catch (error) { if (required) throw error; /* Network operation remains usable. */ }
}
export function rememberRemaining(token: string, remaining: number): void {
  const me = read<Me>('me', token);
  if (me) rememberGuest(token, { ...me, photosRemaining: remaining });
}
export async function recoveryMe(token: string, joinCode: string): Promise<Me> {
  try {
    const me = await getMe(token);
    if (me.joinCode !== joinCode) throw new ApiError('That session belongs to another event.', 403);
    rememberGuest(token, me); recoveryState.set(false); return me;
  } catch (error) {
    if (!temporaryFailure(error)) throw error;
    const me = read<Me>('me', token);
    if (!me || me.joinCode !== joinCode || !Number.isFinite(me.photosRemaining)) throw error;
    recoveryState.set(true); return me;
  }
}

export interface ProvisionalGuest { nonce: string; name: string; set?: string; }
export function provisionalGuest(code: string): ProvisionalGuest | null {
  return read<ProvisionalGuest>('provisional', code);
}
export function createProvisional(code: string, name: string, set?: string): ProvisionalGuest {
  const existing = provisionalGuest(code);
  if (existing) return existing;
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
  const guest = { nonce, name: name.trim().slice(0, 40), set };
  // Must succeed before capture: this secret binds reconciliation retries to ONE server guest.
  write('provisional', code, guest);
  return guest;
}
export async function admitProvisional(code: string) {
  const guest = provisionalGuest(code);
  if (!guest) throw new Error('The saved guest could not be found. Keep your saved photos.');
  const contact = read<{ email: string }>('contact', code);
  return joinEvent(code, guest.name, contact?.email || undefined, guest.set, guest.nonce);
}
export function finishProvisional(code: string): void {
  try { localStorage.removeItem(key('provisional', code)); } catch { /* Retrying is idempotent. */ }
}

export function rememberRecoveryContact(code: string, email: string, wantsPhotos: boolean): void {
  if (email) write('contact', code, { email, wantsPhotos });
}
export async function syncRecoveryContact(code: string, token: string): Promise<void> {
  const contact = read<{ email: string; wantsPhotos: boolean }>('contact', code);
  if (!contact || token.startsWith('offline_')) return;
  try {
    await setParticipantEmail(token, contact.email);
    if (contact.wantsPhotos) await setPhotoOptIn(token, true, contact.email);
    localStorage.removeItem(key('contact', code));
  } catch { /* Keep the explicit request for the next upload or camera opening. */ }
}
