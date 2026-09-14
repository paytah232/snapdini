import { api, postJson } from './api';
import type { GuestDelivery, GuestSendScope } from './guestDelivery';

export interface Photo {
  id: string;
  url: string;            // full-quality original (downloads, and the fallback for playback)
  /** Phone-decodable H.264 copy, present once built. Play THIS; download `url`. The original is
   *  often VP8/WebM, which phones software-decode (stutter) and Safari may refuse outright. */
  playUrl?: string;
  thumbUrl?: string;      // small fast thumbnail (grids); falls back to url if absent
  takenAt: number;
  participantName: string;
  participantId: string;
  /** The mission this shot was for, in the host's own wording — the photo's caption. Null when the
   *  guest just took a picture, which is most of them. */
  challenge?: string | null;
  /** The words written under this photo — by the guest who took it, or by the host. Shown AS the
   *  caption, with `challenge` demoted to a small label beneath when a photo has both. Null when
   *  nobody has written one. */
  caption?: string | null;
  isHighlighted: boolean;
  rating: number; // 0–5; 5 == favourite
  mediaType: 'photo' | 'video';
  status?: 'approved' | 'pending' | 'rejected';
  isOwn?: boolean;
  /** The phone was held sideways for this one. Only ever true — absent covers portrait, unknown,
   *  and every row taken before we recorded it, which are one answer as far as the UI goes.
   *
   *  Worth having because the picture itself cannot tell you: with rotation lock on, a landscape
   *  scene is written into a portrait-shaped file and nothing downstream can see the difference. */
  shotSideways?: boolean;
  sizeBytes?: number;
  width?: number;
  height?: number;
  durationMs?: number;
}

// Compact media stats for display (dimensions/length · size), mirroring the capture queue.
export function mediaMeta(p: { mediaType?: string; width?: number; height?: number; durationMs?: number; sizeBytes?: number }): string {
  const bits: string[] = [];
  if (p.mediaType === 'video' && p.durationMs) bits.push(`${Math.floor(p.durationMs / 60000)}:${String(Math.round((p.durationMs % 60000) / 1000)).padStart(2, '0')}`);
  if (p.mediaType !== 'video' && p.width && p.height) bits.push(`${p.width}×${p.height}`);
  if (p.sizeBytes) bits.push(p.sizeBytes < 1024 * 1024 ? `${Math.round(p.sizeBytes / 1024)} KB` : `${(p.sizeBytes / (1024 * 1024)).toFixed(1)} MB`);
  return bits.join(' · ');
}

export type RatingMode = 'favourite' | 'stars';

export interface EventTheme {
  bg?: string; surface?: string; surface2?: string; border?: string; text?: string;
  textMuted?: string; accent?: string; accentDark?: string;
  mode?: 'system' | 'light' | 'dark'; font?: string; customCss?: string; headerImage?: string; preset?: string;
}

export interface PublicEvent {
  id: string; name: string; blurb: string | null; joinCode: string; slug: string | null;
  maxPhotos: number; revealMode: string; revealDelayHours: number; timezone: string | null;
  /** The exact instant the host picked, overriding the delay. Optional so an older API (or a
   *  response already in a cache) simply falls back to the delay this screen has always used;
   *  null is the same thing said explicitly. */
  revealAt?: number | null;
  aspectRatios: string[]; videoSeconds: number; startsAt: number; expiresAt: number;
  isDemo: boolean; isUpcoming: boolean; isExpired: boolean; isLocked: boolean; isRevealed: boolean;
  /** Server-side reschedule eligibility (usage-based, not time-based). Optional so an older API
   *  simply falls back to the previous time check. */
  canReschedule?: boolean; rescheduleUntil?: number;
  allowDownloads: boolean; noFlash: boolean; theme: EventTheme | null; participantCount: number; photoCount: number;
  /** How many tricks are on a card — never WHICH ones. This payload is public: a join code
   *  must not hand someone the whole list before the event. 0 when the host set none. */
  challengeCount?: number;
  /** Present ONLY for a demo, which hands out its own code so any device that opens one can
   *  reach the host view. A real event never returns this. */
  organizerCode?: string;
}

export interface MyEvent {
  id: string; name: string; joinCode: string; slug: string | null; organizerCode: string;
  revealMode: string; startsAt: number; expiresAt: number; isLocked: boolean;
  isUpcoming: boolean; isExpired: boolean; participantCount: number; photoCount: number;
  coHost?: boolean;   // true when you co-host (don't own) this event
}

export interface AdminEvent extends Omit<PublicEvent, 'participantCount'>, GuestDeliveryFields {
  joinUrl: string; galleryUrl: string; revealedAt: number | null;
  moderationEnabled: boolean; ratingMode: RatingMode; pendingCount: number; participantCount: number;
  participants: { id: string; name: string; email: string | null; photosTaken: number; joinedAt: number;
                  /** Which trick card they were handed. Null when the event has no trick list. */
                  challengeSet?: string | null;
    /** Tricks this guest has pulled off on the card they currently hold. Absent/0 when the event
     *  has no trick list, or they have not done any. */
    tricksDone?: number }[];
  emailEnabled: boolean;
  // entitlement (upgrades)
  guestCap: number; videoSeconds: number; retentionDays: number; paid: boolean; amountPaidCents: number;
  posterConfig: Record<string, unknown> | null; purged: boolean;
  /** What kind of event the host chose in their theming. Null = they never said, which means
   *  the general mission pack. */
  eventType?: string | null;
  /** The host's photo-mission cards. Several exist so different tables get different lists. */
  challengeSets?: { key: string; label: string; items: { id: string; text: string }[] }[];
  /** The mark beside each trick, shared by the app and the printed card. */
  challengeTick?: string | null;
}

const org = (organizerCode: string) => ({ 'X-Organizer-Code': organizerCode });

export const getEvent = (id: string) => api<PublicEvent>(`/api/events/${id}`);
export const getMyEvents = () => api<{ events: MyEvent[] }>('/api/events/mine');
export const createEvent = (body: Record<string, unknown>) =>
  postJson<{ joinCode: string; slug: string | null; organizerCode: string; event: Record<string, unknown> }>('/api/events', body);
export const createDemo = () => postJson<{ joinCode: string; sessionToken: string; organizerCode: string }>('/api/events/demo', {});
export const getQr = (id: string) => api<{ qrCode: string; joinUrl: string }>(`/api/events/${id}/qr`);

export const getAdmin = (code: string, organizerCode: string) =>
  api<AdminEvent>(`/api/events/${code}/admin`, { headers: org(organizerCode) });

export interface SlideshowVersion {
  id: string;
  url: string;            // full-quality render — this is what downloads
  /** 1080p H.264 copy for in-browser preview; absent on 1080p renders and until the transcode ends. */
  playUrl?: string;
  favourite: boolean; label: string; resolution: string; createdAt: number;
}
// Friendly-named download (server sets <event>-<date>-snapdini.mp4); res='1080p' live-transcodes a 4K render.
export const slideshowDownloadUrl = (code: string, id: string, res?: '1080p') =>
  `/api/events/${code}/slideshow/${id}/download${res ? `?res=${res}` : ''}`;
/** Event start → end, or shuffled. There is no third option on purpose — see slideshow.ts. */
export type SlideshowOrder = 'chronological' | 'shuffled';
export interface SlideshowStatus {
  /** 1080p preview copy of the current render, when one has been built. */
  playUrl?: string;
  status: 'idle' | 'running' | 'done' | 'error';
  url?: string; error?: string;
  label?: string;
  progress?: number; phase?: 'collecting' | 'encoding';
  /** Renders waiting behind the running one — a render is queued, never cancelled, by a new one. */
  queued?: { id: string; label: string; queuedAt: number }[];
  maxQueue?: number;
  /** A render that failed and whose slot a queued render has since taken — so it isn't lost. */
  failed?: { label: string; error: string; at: number };
  /** secs comes from ffprobe on the server — never from the browser, see listMusic(). */
  music: { id: string; label: string; secs?: number }[];
  photoCount?: number; favouriteCount?: number; videoCount?: number; secondsPerDefault?: number;
  /** Favourites that are video clips — a favourites render drops them unless they're asked for. */
  favouriteVideoCount?: number;
  hasCustomAudio?: boolean; customAudioSecs?: number;
  /** Every source fits inside 1080p, so a 4K render would upscale and buy nothing. */
  sourcesFitIn1080?: boolean;
  recent?: SlideshowVersion[];
  qualities?: { id: string; label: string; kbps: number }[];
  /** renderScale: wall-clock seconds of rendering per second of finished video, learned server-side
   *  from real renders — what "this will take about six minutes" is actually built from. */
  resolutions?: { id: string; label: string; sizeScale: number; renderScale?: number; prepPerItem?: number }[];
  brandingRemovable?: boolean;   // can this event remove the Snapdini intro/outro for free (already entitled)?
  brandingPriceCents?: number;   // price to unlock removal otherwise
  billingEnabled?: boolean;
}
// Buy the $1 "remove Snapdini frames" add-on. Returns {url} (Stripe Checkout) or {entitled:true}.
export const buyBrandingRemoval = (code: string, organizerCode: string) =>
  postJson<{ url?: string; entitled?: boolean }>(`/api/billing/branding-removal`, { joinCode: code, organizerCode }, org(organizerCode));
export const getSlideshow = (code: string, organizerCode: string) =>
  api<SlideshowStatus>(`/api/events/${code}/slideshow`, { headers: org(organizerCode) });
export const favouriteSlideshow = (code: string, organizerCode: string, id: string) =>
  postJson<{ ok: boolean; favourite: boolean }>(`/api/events/${code}/slideshow/${id}/favourite`, {}, org(organizerCode));
export const deleteSlideshowVersion = (code: string, organizerCode: string, id: string) =>
  api(`/api/events/${code}/slideshow/${id}`, { method: 'DELETE', headers: org(organizerCode) });
export const startSlideshowJob = (code: string, organizerCode: string, body: { favouritesOnly: boolean; track?: string; tracks?: string[]; loopMusic?: boolean; secondsPer?: number; includeVideos?: boolean; keepVideoAudio?: boolean; quality?: string; resolution?: string; branding?: boolean; order?: SlideshowOrder }) =>
  api<SlideshowStatus & { queuedCount?: number; queueFull?: boolean }>(`/api/events/${code}/slideshow`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...org(organizerCode) }, body: JSON.stringify(body) });
// Upload the organizer's own backing track (FormData → no JSON content-type).
export const uploadSlideshowAudio = async (code: string, organizerCode: string, file: File) => {
  const fd = new FormData(); fd.append('audio', file);
  const r = await fetch(`/api/events/${code}/slideshow-audio`, { method: 'POST', headers: org(organizerCode), body: fd });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Upload failed');
  return r.json() as Promise<{ ok: boolean; filename: string }>;
};
// Share links — whole gallery ('all'), the favourites ('favourites'), or a hand-picked subset
// ('selected'). Each gets an editable pretty /s/<slug> URL the owner can rename or delete.
export type ShareKind = 'all' | 'favourites' | 'selected';
export interface ShareLink { id: string; kind: ShareKind; slug: string | null; label: string; count: number | null; url: string; createdAt: number; }
export type CreatedShare = { token: string; slug: string; label: string; kind: ShareKind; url: string };
export const createShare = (code: string, organizerCode: string, kind: ShareKind, photoIds?: string[], label?: string) =>
  postJson<CreatedShare>(`/api/events/${code}/shares`, { kind, photoIds, label }, org(organizerCode));
export const listShares = (code: string, organizerCode: string) =>
  api<{ shares: ShareLink[] }>(`/api/events/${code}/shares`, { headers: org(organizerCode) });
export const updateShare = (code: string, organizerCode: string, id: string, body: { label?: string; slug?: string }) =>
  api<{ ok: boolean; slug: string | null; label: string; url: string }>(`/api/events/${code}/shares/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...org(organizerCode) }, body: JSON.stringify(body) });
export const deleteShare = (code: string, organizerCode: string, id: string) =>
  api(`/api/events/${code}/shares/${id}`, { method: 'DELETE', headers: org(organizerCode) });
export interface ShareView {
  /** `aspectRatios` is optional so an older API (or a cached response) simply falls back to the
   *  square tiles this page has always drawn. */
  event: { name: string; theme: EventTheme | null; allowDownloads: boolean; aspectRatios?: string[] };
  kind: 'all' | 'selected';
  revealed: boolean;
  revealMode: string;
  revealAt: number | null;
  photoCount: number;
  photos: Photo[];
}
export const getShare = (token: string) => api<ShareView>(`/api/shares/${token}`);

// Co-hosts — invite by email, accept, manage. Co-hosts manage the event like the owner.
export interface Cohost { id: string; email: string; status: string; accepted: boolean; inviteUrl: string | null; createdAt: number; }
export interface CohostList { owner: { email: string; name: string } | null; youAreOwner: boolean; cohosts: Cohost[]; }
export const listCohosts = (code: string, organizerCode: string) =>
  api<CohostList>(`/api/events/${code}/cohosts`, { headers: org(organizerCode) });
export const inviteCohost = (code: string, organizerCode: string, email: string) =>
  postJson<{ ok: boolean; devLink?: string }>(`/api/events/${code}/cohosts`, { email }, org(organizerCode));
export const removeCohost = (code: string, organizerCode: string, id: string) =>
  api(`/api/events/${code}/cohosts/${id}`, { method: 'DELETE', headers: org(organizerCode) });
export interface CohostInvite { eventName: string; joinCode: string; inviter: string; email: string; status: string; loggedIn: boolean; verified: boolean; emailMatches: boolean; yourEmail: string | null; alreadyAccepted: boolean; }
export const getCohostInvite = (token: string) => api<CohostInvite>(`/api/cohosts/${token}`);
export const acceptCohost = (token: string) => postJson<{ ok: boolean; joinCode?: string }>(`/api/cohosts/${token}/accept`, {});
export interface MyCohostInvite { token: string; eventName: string; joinCode: string; inviter: string; }
export const listMyCohostInvites = () => api<{ invites: MyCohostInvite[] }>(`/api/cohosts`);

export const savePoster = (code: string, organizerCode: string, config: Record<string, unknown>) =>
  api(`/api/events/${code}/poster`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...org(organizerCode) }, body: JSON.stringify({ config }) });
export const saveSettings = (code: string, organizerCode: string, body: Record<string, unknown>) =>
  api<{ aspectsRefused?: boolean }>(`/api/events/${code}/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...org(organizerCode) }, body: JSON.stringify(body) });
export const setReveal = (code: string, organizerCode: string, on: boolean) =>
  postJson(`/api/events/${code}/${on ? 'reveal' : 'unreveal'}`, {}, org(organizerCode));
export const toggleLock = (code: string, organizerCode: string) => postJson(`/api/events/${code}/lock`, {}, org(organizerCode));
export const deleteEvent = (code: string, organizerCode: string) =>
  api(`/api/events/${code}`, { method: 'DELETE', headers: org(organizerCode) });
/** Hard cap the server applies (after trimming and collapsing whitespace). Mirrored here so an
 *  input stops the typing instead of silently losing the tail when it saves. */
// Caption length rules live in caption.ts — see it for why they are counted in graphemes.
export { CAPTION_MAX, CAPTION_MAX_RAW, clampCaption, captionLength, captionRemaining } from '../../../shared/caption';

// Reveal timing is a rule the server enforces and this side merely displays, so it is imported
// rather than reimplemented — see shared/reveal.ts for what goes wrong when the two disagree.
export { REVEAL_TICK_MS, REVEAL_CUSTOM, ceilToRevealTick, zonedWallTimeToMs, msToZonedWallTime, scheduledRevealAt } from '../../../shared/reveal';

/** A reveal instant written the way a host reads a time: "Sat 3 Oct, 7:15 pm AEST".
 *
 *  Always with the zone name, and always rendered in the EVENT's zone rather than the browser's.
 *  A host setting a Perth event's reveal from Sydney needs to see the Perth time they chose echoed
 *  back — the version of this that dropped the zone label was indistinguishable from a bug. */
export function revealMomentLabel(ms: number, timeZone: string | null): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'short', day: 'numeric', month: 'short',
      hour: 'numeric', minute: '2-digit',
      timeZone: timeZone || undefined, timeZoneName: 'short',
    }).format(new Date(ms));
  } catch {
    return '';   // an unknown zone — the caller shows nothing rather than a wrong time
  }
}

/** Write, edit or clear the caption on one photo. Exactly one credential: a guest's session token
 *  (their OWN photos only) or the organizer code (anything in their event). An empty string clears
 *  it — there is no separate delete call.
 *
 *  Returns what was STORED, not what was sent: the server trims, collapses runs of whitespace and
 *  cuts at CAPTION_MAX, so render the value that comes back or the caption changes under the
 *  writer on their next load. A photo they may not touch answers 404, never 403 — the API declines
 *  to confirm that someone else's photo id exists. */
export const savePhotoCaption = (photoId: string, caption: string,
                                 who: { sessionToken: string } | { organizerCode: string }) =>
  api<{ success: boolean; id: string; caption: string | null }>(`/api/photos/${photoId}/caption`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...('organizerCode' in who ? org(who.organizerCode) : {}) },
    body: JSON.stringify({ caption, ...('sessionToken' in who ? { sessionToken: who.sessionToken } : {}) }),
  });

export const setHighlights = (code: string, organizerCode: string, photoIds: string[], highlight: boolean) =>
  postJson(`/api/events/${code}/highlights`, { photoIds, highlight }, org(organizerCode));
export const moderate = (code: string, organizerCode: string, photoIds: string[], action: 'approve' | 'reject' | 'restore') =>
  postJson(`/api/events/${code}/moderate`, { photoIds, action }, org(organizerCode));
export const ratePhoto = (code: string, organizerCode: string, photoId: string, rating: number) =>
  postJson<{ success: boolean; photoId: string; rating: number; isHighlighted: boolean }>(
    `/api/events/${code}/rate`, { photoId, rating }, org(organizerCode));
export const saveTheme = (code: string, organizerCode: string, theme: EventTheme) =>
  api(`/api/events/${code}/theme`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...org(organizerCode) }, body: JSON.stringify({ theme }) });
/** Email a link to a list of addresses. Omit shareId for the event's standing gallery link; pass
 *  one to send a curated share instead. Every attempt is recorded server-side — see linkSends. */
export const emailLink = (code: string, organizerCode: string, emails: string[], shareId?: string | null) =>
  postJson<{ sent: number; errors: number }>(
    `/api/events/${code}/email-link`, { emails, shareId: shareId ?? null }, org(organizerCode));

export interface LinkSend { shareId: string | null; email: string; ok: boolean; sentAt: number; }
/** Every address this event's links have been emailed to, newest first, across all links. */
export const linkSends = (code: string, organizerCode: string) =>
  api<{ sends: LinkSend[] }>(`/api/events/${code}/link-sends`, { headers: org(organizerCode) });
// Remove a participant (e.g. a duplicate join). Their uploads are deleted too — returns the count.
export const deleteParticipant = (code: string, organizerCode: string, id: string) =>
  api<{ ok: boolean; removedPhotos: number }>(`/api/events/${code}/participants/${id}`, { method: 'DELETE', headers: org(organizerCode) });
/** Move a guest to a different trick card. Nothing is destroyed — progress is derived from photos
 *  and scoped to the card held, so ticks come back if they are moved back. */
export const setParticipantCard = (code: string, organizerCode: string, id: string, set: string) =>
  api<{ ok: boolean; challengeSet: string; label: string; tricks: number }>(
    `/api/events/${code}/participants/${id}/card`,
    { method: 'PUT', headers: { 'Content-Type': 'application/json', ...org(organizerCode) }, body: JSON.stringify({ set }) });
/** Attach an email to a roll already in progress, so it survives a move to another browser.
 *  409 when someone else at the event already uses that address. */
export const setParticipantEmail = (sessionToken: string, email: string) =>
  api<{ ok: boolean; email: string }>('/api/participants/email', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionToken, email }),
  });

/** What the opt-in call answers with. */
export interface PhotoOptIn {
  ok: boolean;
  /** The flag as it now stands on this guest's row — render THIS, never what was asked for. */
  wantsPhotos: boolean;
  /** The address stored against the roll afterwards, or null when none is. Null is also what the
   *  collision below answers with, so it must never be read as "the opt-in did not take". */
  email: string | null;
  /** The address given already belongs to another guest at this event. (event_id, lower(email)) is
   *  UNIQUE, so it cannot be written twice — the server opts THIS guest in and will send there
   *  anyway, it simply does not store the address. A flag rather than a 409 precisely because it
   *  is not a failure: the guest gets their photos either way and must not be shown an error. */
  emailTaken?: boolean;
  /** They said yes and we have nowhere to send it. The opt-in IS recorded — so this is a prompt for
   *  an address, never a failure to report. */
  needsEmail?: boolean;
}

/** Ask to be emailed the photos when the event ends, or take it back (wantsPhotos: false).
 *
 *  Pass `email` only when the guest has just typed one; omit it to use whatever is already on
 *  their row. Registering an address is folded into this call rather than left to a separate
 *  setParticipantEmail() because two calls can half-apply on party wifi — opted in with nowhere
 *  to send to, or an address stored for someone who never got opted in.
 *
 *  `needsEmail` is the server telling us they said yes and we have nowhere to send it — the opt-in
 *  is still recorded, so the UI must ask for an address rather than report a failure. */
export const setPhotoOptIn = async (sessionToken: string, wantsPhotos: boolean, email?: string): Promise<PhotoOptIn> => {
  const r = await api<{ ok: boolean; wantsPhotos: boolean; email: string | null;
                        emailStored: boolean; duplicateEmail: boolean; needsEmail: boolean }>(
    '/api/participants/wants-photos', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionToken, wantsPhotos, email: email || undefined }),
    });
  // `emailTaken` is this client's name for it; the server says `duplicateEmail`. Translated once,
  // here, so the component's tested vocabulary does not have to move to meet the route.
  return { ok: r.ok, wantsPhotos: r.wantsPhotos, email: r.email, emailTaken: r.duplicateEmail, needsEmail: r.needsEmail };
};
export const setAllowDownloads = (code: string, organizerCode: string, allowDownloads: boolean) =>
  postJson(`/api/events/${code}/allow-downloads`, { allowDownloads }, org(organizerCode));

export interface PhotosResponse {
  revealed: boolean; photoCount?: number; revealMode?: string; revealAt?: number | null;
  hasHighlights?: boolean; allowDownloads?: boolean; moderationEnabled?: boolean;
  myParticipantId?: string; photos?: Photo[];
}
export const getPhotosBySession = (code: string, sessionToken: string, highlightsOnly = false) =>
  api<PhotosResponse>(`/api/photos/${code}${highlightsOnly ? '?highlightsOnly=true' : ''}`, { headers: { 'X-Session-Token': sessionToken } });
export const getPhotosByOrganizer = (code: string, organizerCode: string) =>
  api<PhotosResponse>(`/api/photos/${code}`, { headers: org(organizerCode) });
export const getGalleryPhotos = (code: string, highlightsOnly = false) =>
  api<PhotosResponse>(`/api/photos/${code}?gallery=true${highlightsOnly ? '&highlightsOnly=true' : ''}`);

/** The missions on THIS guest's card, and the ids they have already captured. A guest is handed
 *  one card of possibly several, so this is per-participant, never the event's whole list. */
export type GuestMissions = {
  challenges?: { id: string; text: string }[];
  challengesDone?: string[];
  challengeSet?: string | null;
  challengeTick?: string | null;
};

export const joinEvent = (joinCode: string, name: string, email?: string) =>
  postJson<{ participant: { id: string; name: string }; sessionToken: string; joinCode: string; photosRemaining: number; eventName: string; noFlash?: boolean; recovered?: boolean; canBuyShots?: boolean; canAskHost?: boolean; faceMatching?: boolean; faceEnrolled?: boolean; feedbackGiven?: boolean; emailFromPayment?: boolean; wantsPhotos?: boolean } & GuestMissions>(
    '/api/participants', { joinCode, name, email: email || undefined });
export const getMe = (sessionToken: string) =>
  api<{ participant: { id: string; name: string; photosTaken: number; email: string | null }; photosRemaining: number; eventName: string; joinCode: string; slug: string | null; startsAt: number; expiresAt: number; isLocked: boolean; maxPhotos: number; extraPhotos?: number; allowDownloads: boolean; noFlash: boolean; canBuyShots?: boolean; canAskHost?: boolean; faceMatching?: boolean; faceEnrolled?: boolean; feedbackGiven?: boolean; emailFromPayment?: boolean; wantsPhotos?: boolean } & GuestMissions>(
    '/api/participants/me', { headers: { 'X-Session-Token': sessionToken } });

// ── Getting the photos to the guests ────────────────────────────────────────
//
// The host decides how and when their guests get the photos. The rules behind the question (the
// 24-hour reminder gate, the never-before-the-reveal floor) live in ./guestDelivery — this is only
// the shape the API speaks in.

/** An event's guest-delivery settings as the admin API reports them.
 *
 *  Every field is optional so an API that does not serve them yet — or a response already sitting
 *  in a cache — reads as an event on the defaults, which is exactly what such an event is. */
export interface GuestDeliveryFields {
  guestDelivery?: GuestDelivery;
  guestSendScope?: GuestSendScope;
  /** The instant a 'scheduled' send goes out, already on the reveal grid. Null on every other
   *  setting, and on a scheduled one the host has not finished picking. */
  guestSendAt?: number | null;
  /** Set once the live email has actually gone. A host who cannot see this has no way to tell a
   *  send that worked from one that never ran, and the obvious next move is to send it again. */
  guestsSentAt?: number | null;
  guestMailThanks?: boolean;
  guestMailReminder?: boolean;
  guestMailLive?: boolean;
  /** Guests who asked for their photos. Deliberately NOT derived from the participant list here:
   *  an address on a row is not consent to be emailed, and a count built from one would overstate
   *  what a send will actually do. Absent until the API reports it, and simply not shown. */
  guestOptInCount?: number;
}

export interface GuestSendResult {
  sent: number;
  /** Opted-in guests who got nothing because there was nothing to send them. */
  skipped?: number;
  scope: GuestSendScope;
  sentAt: number;
  /** Why nothing went out — present when `sent` is 0, and shown to the host verbatim rather than
   *  flattened into a cheerful "sent to 0 guests". */
  reason?: string;
}

/** Send the gallery link to the opted-in guests right now.
 *
 *  The server answers a refusal as a 409 with a `reason` — empty_scope, not_revealed — rather than
 *  a cheerful "sent to 0". The caller surfaces whichever it gets. */
export const sendGuestPhotos = (code: string, organizerCode: string, scope: GuestSendScope) =>
  postJson<GuestSendResult>(`/api/events/${code}/send-guest-link`, { scope }, org(organizerCode));
// ── Guest list + invites ─────────────────────────────────────────────────────
// A host's list of who they mean to invite, and what became of each email we sent them.

/** What we know about one message. 'sent' is the interesting one: on a deployment with Mailgun
 *  delivery tracking it means "in flight, ask again shortly"; without it, it is the FINAL state and
 *  means "we handed it over and will never know". `GuestListPayload.deliveryTracking` says which
 *  of those a given screen is looking at — never assume. */
export type InviteStatus = 'sent' | 'delivered' | 'bounced' | 'complained' | 'unsubscribed' | 'failed';

export interface InviteState {
  status: InviteStatus;
  /** The receiving server's own words, when there were any ("550 no such user", "mailbox full").
   *  Shown verbatim: those two call for completely different actions from the host. */
  reason: string | null;
  provider: string | null;
  sentAt: number;
  updatedAt: number;
}

/** Why an address is blocked from further sends. Global to the deployment, not to this event —
 *  a hard bounce anywhere means the address is dead everywhere. */
export interface Suppression { reason: string; detail: string | null; since: number }

export interface EventGuest {
  id: string;
  name: string | null;
  /** Null is normal, not an error: a guest may be on the list for their phone number, or be a
   *  plus-one whose address nobody has. They simply are not part of an email send. */
  email: string | null;
  phone: string | null;
  notes: string | null;
  createdAt: number;
  lastInvite: InviteState | null;
  suppressed: Suppression | null;
}

export interface GuestListPayload {
  guests: EventGuest[];
  invites: (InviteState & { id: string; guestId: string | null; email: string })[];
  emailEnabled: boolean;
  /** Whether a 'sent' on this deployment will ever become anything else. */
  deliveryTracking: boolean;
}

export type GuestField = 'name' | 'email' | 'phone' | 'notes' | 'ignore';

/** One line of the file as the preview shows it. `action: 'skip'` rows are rendered greyed rather
 *  than hidden — a file where 40 of 200 rows are duplicates is a file the host needs to look at. */
export interface ImportRow {
  line: number;
  guest: { name: string | null; email: string | null; phone: string | null; notes: string | null };
  action: 'add' | 'skip';
  problems: string[];
}

export interface ImportPreview {
  headers: string[];
  /** True when the first row held data rather than column names (someone pasted a selection
   *  without the header). Worth telling them, since it changes what every column means. */
  headerless: boolean;
  delimiter: string;
  mapping: GuestField[];
  counts: { add: number; skip: number; duplicate: number; invalid: number };
  fatal: string | null;
  rows: ImportRow[];
  truncated: boolean;
  total: number;
}

export const listGuests = (code: string, organizerCode: string) =>
  api<GuestListPayload>(`/api/events/${code}/guests`, { headers: org(organizerCode) });

export const addGuest = (code: string, organizerCode: string, guest: Partial<EventGuest>) =>
  postJson<GuestListPayload>(`/api/events/${code}/guests`, guest, org(organizerCode));

export const updateGuest = (code: string, organizerCode: string, id: string, guest: Partial<EventGuest>) =>
  api<GuestListPayload>(`/api/events/${code}/guests/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', ...org(organizerCode) },
    body: JSON.stringify(guest) });

export const removeGuest = (code: string, organizerCode: string, id: string) =>
  api<GuestListPayload>(`/api/events/${code}/guests/${id}`, { method: 'DELETE', headers: org(organizerCode) });

/** What the import WOULD do. Writes nothing — the host approves this before anything is committed. */
export const previewGuestImport = (code: string, organizerCode: string, text: string, mapping?: GuestField[]) =>
  postJson<ImportPreview>(`/api/events/${code}/guests/import/preview`, { text, mapping }, org(organizerCode));

/** Commit it. The same text and mapping go back, so the server re-runs the identical computation
 *  rather than acting on a draft it was holding — what the host approved is what happens. */
export const commitGuestImport = (code: string, organizerCode: string, text: string, mapping: GuestField[]) =>
  postJson<{ imported: number; skipped: number } & GuestListPayload>(
    `/api/events/${code}/guests/import`, { text, mapping }, org(organizerCode));

/** Send the Snapdini invite. Omit `guestIds` to mail everyone on the list who has an address.
 *
 *  `skipped` is the part that matters: addresses that were NOT mailed because they are suppressed,
 *  with the reason. A count of successes alone is how a guest ends up never invited. */
export const sendInvites = (code: string, organizerCode: string, guestIds?: string[]) =>
  postJson<{ sent: number; failed: number; noAddress: number;
             skipped: { email: string; name: string | null; reason: string }[] } & GuestListPayload>(
    `/api/events/${code}/guests/invite`, { guestIds }, org(organizerCode));
