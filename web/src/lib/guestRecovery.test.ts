import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { ApiError } from './api';
import { getEvent, getMe, joinEvent, setParticipantEmail, setPhotoOptIn, type PublicEvent } from './events';
import {
  admitProvisional, createProvisional, finishProvisional, provisionalGuest,
  recoveryEvent, recoveryMe, recoveryState, rememberGuest, rememberRemaining,
  rememberRecoveryContact, syncRecoveryContact, savedRecoveryCode,
} from './guestRecovery';

vi.mock('./events', () => ({ getEvent: vi.fn(), getMe: vi.fn(), joinEvent: vi.fn(), setParticipantEmail: vi.fn(), setPhotoOptIn: vi.fn() }));
vi.mock('./serverClock', () => ({ serverNow: () => 1_000_000 }));

const code = 'ABCDEFGH';
const event = (overrides: Partial<PublicEvent> = {}): PublicEvent => ({
  id: 'event-one', name: 'A party', blurb: null, joinCode: code, slug: 'a-party',
  maxPhotos: 12, revealMode: 'instant', revealDelayHours: 0, timezone: 'UTC',
  aspectRatios: ['3:4'], videoSeconds: 0, startsAt: 900_000, expiresAt: 1_100_000,
  isDemo: false, isUpcoming: false, isExpired: false, isLocked: false, isRevealed: true,
  allowDownloads: true, noFlash: false, theme: null, participantCount: 1, photoCount: 0,
  ...overrides,
});
type Me = Awaited<ReturnType<typeof getMe>>;
const me = (overrides: Partial<Me> = {}): Me => ({
  participant: { id: 'guest-one', name: 'Guest', photosTaken: 3, email: null },
  photosRemaining: 9, eventName: 'A party', joinCode: code, slug: 'a-party',
  startsAt: 900_000, expiresAt: 1_100_000, isLocked: false, maxPhotos: 12,
  allowDownloads: true, noFlash: false, ...overrides,
});
const transient = () => new ApiError('Temporarily unavailable', 503);
const response = (status: number, body: unknown = null) => ({
  ok: status >= 200 && status < 300, status, json: async () => body,
});
const fetchMock = vi.fn();

beforeEach(() => {
  localStorage.clear();
  history.replaceState({}, '', '/guest/join/ABCDEFGH');
  vi.resetAllMocks();
  recoveryState.set(false);
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockRejectedValue(new TypeError('Network unavailable'));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function cacheLiveEvent(value = event()) {
  vi.mocked(getEvent).mockResolvedValueOnce(value);
  await recoveryEvent(value.joinCode);
}

describe('event recovery respects authoritative answers', () => {
  it.each([401, 403, 404, 410])('does not override live %i with an existing local snapshot', async status => {
    await cacheLiveEvent();
    const refusal = new ApiError('Refused', status);
    vi.mocked(getEvent).mockRejectedValueOnce(refusal);
    await expect(recoveryEvent(code)).rejects.toBe(refusal);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses a matching published snapshot during a temporary failure and recomputes event timing', async () => {
    vi.mocked(getEvent).mockRejectedValueOnce(transient());
    fetchMock.mockResolvedValueOnce(response(200, { schema: 1, publishedAt: 999_000,
      event: event({ startsAt: 1_050_000, isUpcoming: false, isExpired: true }) }));
    const recovered = await recoveryEvent(code);
    expect(recovered).toMatchObject({ joinCode: code, isUpcoming: true, isExpired: false });
    expect(fetchMock).toHaveBeenCalledWith(`/guest/events/${code}.json`, expect.objectContaining({ cache: 'no-store' }));
    expect(get(recoveryState)).toBe(true);
  });

  it('uses a matching local snapshot when both API and snapshot publisher are unavailable', async () => {
    await cacheLiveEvent();
    vi.mocked(getEvent).mockRejectedValueOnce(transient());
    fetchMock.mockResolvedValueOnce(response(503));
    await expect(recoveryEvent(code)).resolves.toMatchObject({ joinCode: code, maxPhotos: 12 });
  });

  it('honors an explicit publisher withdrawal', async () => {
    await cacheLiveEvent();
    vi.mocked(getEvent).mockRejectedValueOnce(transient());
    fetchMock.mockResolvedValueOnce(response(410));
    await expect(recoveryEvent(code)).rejects.toMatchObject({ status: 410 });
  });

  it('keeps known settings usable when a new event snapshot has not been published yet', async () => {
    await cacheLiveEvent();
    vi.mocked(getEvent).mockRejectedValueOnce(transient());
    fetchMock.mockResolvedValueOnce(response(404));
    await expect(recoveryEvent(code)).resolves.toMatchObject({ joinCode: code, maxPhotos: 12 });
  });

  it.each(['../other', 'a/b', '', 'x'.repeat(81)])('refuses invalid recovery identifier %j before fetching a manifest', async identifier => {
    const failure = transient();
    vi.mocked(getEvent).mockRejectedValueOnce(failure);
    await expect(recoveryEvent(identifier)).rejects.toBe(failure);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a manifest and cached entry belonging to another event', async () => {
    const other = event({ joinCode: 'DIFFERENT', slug: 'different-party' });
    localStorage.setItem(`snap_recovery_event_${code}`, JSON.stringify(other));
    const failure = transient();
    vi.mocked(getEvent).mockRejectedValueOnce(failure);
    fetchMock.mockResolvedValueOnce(response(200, { schema: 1, event: other }));
    await expect(recoveryEvent(code)).rejects.toBe(failure);
  });

  it('does not persist organizer credentials or manager access from a live demo', async () => {
    await cacheLiveEvent(event({ isDemo: true, organizerCode: 'secret-host-code', youManage: true }));
    for (const identifier of [code, 'a-party']) {
      const saved = JSON.parse(localStorage.getItem(`snap_recovery_event_${identifier}`)!);
      expect(saved).not.toHaveProperty('organizerCode');
      expect(saved).not.toHaveProperty('youManage');
    }
  });
});

describe('guest recovery binds cached counts to the correct session and event', () => {
  it.each([401, 403, 404, 410])('does not override live session %i with cached permission', async status => {
    rememberGuest('token-one', me());
    const refusal = new ApiError('Refused', status);
    vi.mocked(getMe).mockRejectedValueOnce(refusal);
    await expect(recoveryMe('token-one', code)).rejects.toBe(refusal);
  });

  it('rejects a live session belonging to another event', async () => {
    vi.mocked(getMe).mockResolvedValueOnce(me({ joinCode: 'DIFFERENT' }));
    await expect(recoveryMe('token-one', code)).rejects.toMatchObject({ status: 403 });
  });

  it('does not reuse a different token or an event mismatch from local storage', async () => {
    rememberGuest('token-one', me());
    vi.mocked(getMe).mockRejectedValue(transient());
    await expect(recoveryMe('token-two', code)).rejects.toMatchObject({ status: 503 });
    await expect(recoveryMe('token-one', 'DIFFERENT')).rejects.toMatchObject({ status: 503 });
    await expect(recoveryMe('token-one', code)).resolves.toMatchObject({ photosRemaining: 9 });
  });

  it('persists updated remaining counts so repeated recovery cannot reset the roll', async () => {
    rememberGuest('token-one', me());
    rememberRemaining('token-one', 4);
    vi.mocked(getMe).mockRejectedValue(transient());
    await expect(recoveryMe('token-one', code)).resolves.toMatchObject({ photosRemaining: 4 });
    await expect(recoveryMe('token-one', code)).resolves.toMatchObject({ photosRemaining: 4 });
    expect(JSON.parse(localStorage.getItem('snap_recovery_me_token-one')!).photosRemaining).toBe(4);
  });
});

describe('provisional admission is stable across network retries', () => {
  it('persists one nonce and reuses it for repeated join attempts', async () => {
    const guest = createProvisional(code, '  Guest  ', 'card-one');
    expect(guest.nonce).toMatch(/^[a-f0-9]{64}$/);
    expect(provisionalGuest(code)).toEqual(guest);
    expect(createProvisional(code, 'Changed name', 'card-two')).toEqual(guest);
    vi.mocked(joinEvent).mockRejectedValueOnce(transient());
    await expect(admitProvisional(code)).rejects.toMatchObject({ status: 503 });
    await admitProvisional(code);
    expect(joinEvent).toHaveBeenNthCalledWith(1, code, 'Guest', undefined, 'card-one', guest.nonce);
    expect(joinEvent).toHaveBeenNthCalledWith(2, code, 'Guest', undefined, 'card-one', guest.nonce);
    expect(provisionalGuest(code)).toEqual(guest);
  });

  it('only removes the pending identity after explicit completion', async () => {
    createProvisional(code, 'Guest');
    await admitProvisional(code);
    expect(provisionalGuest(code)).not.toBeNull();
    finishProvisional(code);
    expect(provisionalGuest(code)).toBeNull();
    await expect(admitProvisional(code)).rejects.toThrow(/saved guest could not be found/i);
  });

  it('refuses to create an identity if its durable nonce cannot be saved', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => { throw new DOMException('Full', 'QuotaExceededError'); });
    expect(() => createProvisional(code, 'Guest')).toThrow(/Full/);
    expect(provisionalGuest(code)).toBeNull();
  });
});


describe('normalized event recovery links', () => {
  it('finds the uppercase local join-code cache when reopening a mixed-case link', async () => {
    await cacheLiveEvent();
    vi.mocked(getEvent).mockRejectedValueOnce(transient());
    await expect(recoveryEvent('aBcDeFgH')).resolves.toMatchObject({ joinCode: code });
    expect(fetchMock).toHaveBeenCalledWith(`/guest/events/${code}.json`, expect.anything());
  });

  it('requests the lowercase slug manifest and finds its local cache from a mixed-case slug route', async () => {
    await cacheLiveEvent();
    history.replaceState({}, '', '/guest/e/A-PaRtY');
    vi.mocked(getEvent).mockRejectedValueOnce(transient());
    await expect(recoveryEvent('A-PaRtY')).resolves.toMatchObject({ joinCode: code });
    expect(fetchMock).toHaveBeenCalledWith('/guest/events/a-party.json', expect.anything());
  });
});

describe('explicit recovery contact preferences survive outages', () => {
  it('keeps contact preferences pending for an offline identity and syncs them with the admitted identity', async () => {
    rememberRecoveryContact(code, 'guest@example.test', true);
    await syncRecoveryContact(code, 'offline_nonce');
    expect(setParticipantEmail).not.toHaveBeenCalled();
    expect(setPhotoOptIn).not.toHaveBeenCalled();
    expect(localStorage.getItem(`snap_recovery_contact_${code}`)).not.toBeNull();
    await syncRecoveryContact(code, 'real-token');
    expect(setParticipantEmail).toHaveBeenCalledWith('real-token', 'guest@example.test');
    expect(setPhotoOptIn).toHaveBeenCalledWith('real-token', true, 'guest@example.test');
    expect(localStorage.getItem(`snap_recovery_contact_${code}`)).toBeNull();
  });

  it('retries the persisted preference after saving the email fails', async () => {
    rememberRecoveryContact(code, 'guest@example.test', true);
    vi.mocked(setParticipantEmail).mockRejectedValueOnce(transient());
    await syncRecoveryContact(code, 'real-token');
    expect(setPhotoOptIn).not.toHaveBeenCalled();
    expect(localStorage.getItem(`snap_recovery_contact_${code}`)).not.toBeNull();
    await syncRecoveryContact(code, 'real-token');
    expect(setParticipantEmail).toHaveBeenCalledTimes(2);
    expect(setPhotoOptIn).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(`snap_recovery_contact_${code}`)).toBeNull();
  });

  it('retains the requested opt-in when email saving succeeds but opt-in fails', async () => {
    rememberRecoveryContact(code, 'guest@example.test', true);
    vi.mocked(setPhotoOptIn).mockRejectedValueOnce(transient());
    await syncRecoveryContact(code, 'real-token');
    expect(localStorage.getItem(`snap_recovery_contact_${code}`)).not.toBeNull();
    await syncRecoveryContact(code, 'real-token');
    expect(setPhotoOptIn).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem(`snap_recovery_contact_${code}`)).toBeNull();
  });

  it('saves an email without opting the guest into photo delivery they did not request', async () => {
    rememberRecoveryContact(code, 'guest@example.test', false);
    await syncRecoveryContact(code, 'real-token');
    expect(setParticipantEmail).toHaveBeenCalledWith('real-token', 'guest@example.test');
    expect(setPhotoOptIn).not.toHaveBeenCalled();
    expect(localStorage.getItem(`snap_recovery_contact_${code}`)).toBeNull();
  });

  it("does not send another event's saved contact or invent one when no email was given", async () => {
    rememberRecoveryContact(code, 'guest@example.test', true);
    rememberRecoveryContact('NOEMAIL', '', true);
    await syncRecoveryContact('DIFFERENT', 'real-token');
    await syncRecoveryContact('NOEMAIL', 'real-token');
    expect(setParticipantEmail).not.toHaveBeenCalled();
    expect(setPhotoOptIn).not.toHaveBeenCalled();
  });
});


describe('admission cache durability', () => {
  it('uses the saved email when reconciling so an existing roll is recovered', async () => {
    const guest = createProvisional(code, 'Returning guest');
    rememberRecoveryContact(code, 'guest@example.test', false);
    await admitProvisional(code);
    expect(joinEvent).toHaveBeenCalledWith(code, 'Returning guest', 'guest@example.test', undefined, guest.nonce);
  });

  it('finds locally saved captures from a custom event link without contacting the API', async () => {
    await cacheLiveEvent();
    vi.mocked(getEvent).mockClear();
    expect(savedRecoveryCode('a-party')).toBe(code);
    expect(savedRecoveryCode(code.toLowerCase())).toBe(code);
    expect(getEvent).not.toHaveBeenCalled();
  });

  it('fails the required identity-cache write before callers switch away from the provisional token', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => { throw new DOMException('Full', 'QuotaExceededError'); });
    expect(() => rememberGuest('new-token', me(), true)).toThrow(/Full/);
    expect(localStorage.getItem('snap_recovery_me_new-token')).toBeNull();
  });

  it('keeps ordinary live operation usable if optional metadata caching fails', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => { throw new DOMException('Full', 'QuotaExceededError'); });
    expect(() => rememberGuest('existing-token', me())).not.toThrow();
  });
});
