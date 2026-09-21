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
  /** How many guests have hearted this. Absent when the host has hearts off — absent, not zero, so
   *  the UI can tell "nobody yet" from "not a thing here". */
  hearts?: number;
  /** Whether YOU have. Only ever present on a per-viewer reply: the public gallery payload is
   *  shared-cacheable, so it carries counts and never this. See the hearts endpoint. */
  hearted?: boolean;
  /** How many comments this photo carries. Absent when the host has comments off — which is most
   *  events, so most galleries never see this field. */
  comments?: number;
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
  /** The untouched upload `headerImage` was cut from, and where the cut was taken ("sx,sy,sw,sh"
   *  in the original's own 0–1 coordinates). Both optional: an event whose image predates them has
   *  the crop and nothing to re-cut, and renders exactly as it always did. */
  imageOriginal?: string; imageCrop?: string;
}

export interface PublicEvent {
  id: string; name: string; blurb: string | null; joinCode: string; slug: string | null;
  maxPhotos: number; revealMode: string; revealDelayHours: number; timezone: string | null;
  /** The exact instant the host picked, overriding the delay. Optional so an older API (or a
   *  response already in a cache) simply falls back to the delay this screen has always used;
   *  null is the same thing said explicitly. */
  revealAt?: number | null;
  /** The explicit "Hide photos" override, which beats every other reveal rule including instant.
   *  Optional so an older API simply behaves as it did. Host-only — never on the public event. */
  revealHidden?: boolean;
  aspectRatios: string[]; videoSeconds: number; startsAt: number; expiresAt: number;
  isDemo: boolean; isUpcoming: boolean; isExpired: boolean; isLocked: boolean; isRevealed: boolean;
  /** Only the host can open the gallery from here — a manual event, or photos explicitly hidden.
   *  False for a timed reveal, where waiting is the answer. Optional: an older API says nothing. */
  awaitingHost?: boolean;
  /** Does the signed-in account own or co-host THIS event? Identity, not the organizer code — and
   *  not merely "somebody is signed in". False for a guest, and false when signed in as anyone
   *  other than this event's host. */
  youManage?: boolean;
  /** Whether the event belongs to an account at all — not who. Lets the organizer-code wall
   *  tell "log in as the owner" apart from "no account exists on this event". */
  hasOwner?: boolean;
  /** Whether guests can heart photos on this event. Host opt-out; on by default. */
  heartsEnabled?: boolean;
  /** What the event's own `/gallery/<code>` link allows — separate from the guest pair above,
   *  because it reaches a different audience. See 0064. */
  galleryHeartsEnabled?: boolean;
  galleryCommentsEnabled?: boolean;
  /** Whether guests can comment. Opt-IN, off by default — a comment puts one guest's words on
   *  somebody else's gallery, which is not a default to make on a host's behalf. */
  commentsEnabled?: boolean;
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
/** The visitor's own zone goes with it: a demo with no timezone stores an ambiguous wall clock,
 *  which is what let the admin settings form read a start as UTC and write it back as local. */
export const demoTimezone = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
};
export const createDemo = () => postJson<{ joinCode: string; sessionToken: string; organizerCode: string }>('/api/events/demo', { timezone: demoTimezone() });
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
export interface ShareLink { id: string; kind: ShareKind; slug: string | null; label: string; count: number | null; url: string; createdAt: number;
  /** Reactions are per LINK: one event can have a family gallery that wants comments and a client
   *  gallery that must not. Both default off. */
  heartsEnabled?: boolean; commentsEnabled?: boolean; }
export type CreatedShare = { token: string; slug: string; label: string; kind: ShareKind; url: string;
  heartsEnabled?: boolean; commentsEnabled?: boolean };
export const createShare = (code: string, organizerCode: string, kind: ShareKind, photoIds?: string[], label?: string) =>
  postJson<CreatedShare>(`/api/events/${code}/shares`, { kind, photoIds, label }, org(organizerCode));
export const listShares = (code: string, organizerCode: string) =>
  api<{ shares: ShareLink[] }>(`/api/events/${code}/shares`, { headers: org(organizerCode) });
export const updateShare = (code: string, organizerCode: string, id: string,
                            body: { label?: string; slug?: string; heartsEnabled?: boolean; commentsEnabled?: boolean }) =>
  api<{ ok: boolean; slug: string | null; label: string; url: string; heartsEnabled?: boolean; commentsEnabled?: boolean }>(`/api/events/${code}/shares/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...org(organizerCode) }, body: JSON.stringify(body) });
/** Every written line in the event — captions and comments together, newest first — so the host has
 *  one place to read and remove what people have written. Capped server-side; `capped` says so. */
export interface HostWord {
  kind: 'caption' | 'comment';
  /** For a comment, the comment id. For a caption, the PHOTO id — a caption is cleared by saving an
   *  empty one, which is what the host's own caption editor already does. */
  id: string;
  photoId: string; thumbUrl: string; text: string;
  author: string;
  /** 'visitor' = someone who only ever held a share link. Worth saying: a name typed into a
   *  forwarded link is not the same claim as a guest who joined the event. */
  authorKind: 'guest' | 'visitor' | 'host';
  createdAt: number; status: string;
  /** Hearts on the comment itself. Always 0 for a caption — nobody can heart one. */
  hearts?: number;
}
export const getWords = (code: string, organizerCode: string) =>
  api<{ words: HostWord[]; captionTotal: number; commentTotal: number; total: number; capped: boolean }>(
    `/api/events/${code}/words`, { headers: org(organizerCode) });

export const deleteShare = (code: string, organizerCode: string, id: string) =>
  api(`/api/events/${code}/shares/${id}`, { method: 'DELETE', headers: org(organizerCode) });
export interface ShareView {
  /** `aspectRatios` is optional so an older API (or a cached response) simply falls back to the
   *  square tiles this page has always drawn. */
  event: { name: string; theme: EventTheme | null; allowDownloads: boolean; aspectRatios?: string[] };
  /** The host's own name for THIS link — "For the family", "Work lot". The server has always sent
   *  it; the page never read it. Null on a share that was never named. */
  label?: string | null;
  kind: 'all' | 'selected';
  revealed: boolean;
  revealMode: string;
  revealAt: number | null;
  photoCount: number;
  photos: Photo[];
  /** Whether THIS link lets the people who hold it react. Per link, not per event — see the shares
   *  table. Absent on an older API, which is read as both off. */
  reactions?: { hearts: boolean; comments: boolean };
  /** Who this browser already is on this link, echoed back so a returning visitor is greeted rather
   *  than asked their name a second time. */
  visitor?: { name: string } | null;
  /** Photo id → total. The PHOTO's total: a heart left by a guest during the event counts here too. */
  hearts?: Record<string, number>;
  comments?: Record<string, number>;
  /** Which of them this visitor left, so the tiles come back already filled in. */
  myHearts?: string[];
}
const vis = (t?: string | null): Record<string, string> => (t ? { 'X-Visitor-Token': t } : {});
export const getShare = (token: string, visitorToken?: string | null) =>
  api<ShareView>(`/api/shares/${token}`, { headers: vis(visitorToken) });

// ── Reacting with nothing but the link ──────────────────────────────────────
//
// A share visitor is not a participant: no join code, no roll, no seat against the guest cap. All
// they have is a name and a token scoped to this one link, carried in `X-Visitor-Token` the same
// way a guest carries `X-Session-Token`.


/** Give a name (or change one you already gave) and get the token back. */
export const shareVisitorJoin = (token: string, name: string, visitorToken?: string | null) =>
  postJson<{ token: string; name: string }>(`/api/shares/${token}/visitor`, { name }, vis(visitorToken));

/** Explicit `heart`, never a toggle — a retried request has to land on what was asked for. */
export const shareHeart = (token: string, photoId: string, visitorToken: string, heart: boolean) =>
  postJson<{ hearted: boolean; hearts: number }>(
    `/api/shares/${token}/photos/${photoId}/heart`, { heart }, vis(visitorToken));

export const getShareComments = (token: string, ids: string[], visitorToken?: string | null) =>
  api<{ comments: Record<string, PhotoComment[]> }>(
    `/api/shares/${token}/comments?ids=${ids.join(',')}`, { headers: vis(visitorToken) });

/** Heart a COMMENT, as a share-link visitor. Explicit boolean, never a toggle. */
export const shareCommentHeart = (token: string, commentId: string, visitorToken: string, heart: boolean) =>
  postJson<{ hearted: boolean; hearts: number }>(
    `/api/shares/${token}/comments/${commentId}/heart`, { heart }, vis(visitorToken));

export const addShareComment = (token: string, photoId: string, visitorToken: string, body: string) =>
  postJson<PhotoComment>(`/api/shares/${token}/photos/${photoId}/comment`, { body }, vis(visitorToken));

export const deleteShareComment = (token: string, commentId: string, visitorToken: string) =>
  api<{ success: boolean }>(`/api/shares/${token}/comments/${commentId}`,
    { method: 'DELETE', headers: vis(visitorToken) });

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

/** Is this share's custom URL free? Same three rules the PATCH enforces, asked before saving.
 *  `shareId` so the share's OWN slug does not read as taken by itself. */
export const checkShareSlug = (code: string, organizerCode: string, slug: string, shareId: string) =>
  api<{ available: boolean; slug?: string; reason?: string }>(
    `/api/events/${code}/shares/check-slug/${encodeURIComponent(slug)}?id=${encodeURIComponent(shareId)}`,
    { headers: org(organizerCode) });

export const savePoster = (code: string, organizerCode: string, config: Record<string, unknown>) =>
  api(`/api/events/${code}/poster`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...org(organizerCode) }, body: JSON.stringify({ config }) });
export const saveSettings = (code: string, organizerCode: string, body: Record<string, unknown>) =>
  // The clamp flags are the server saying "I saved a DIFFERENT time from the one you sent". They
  // have been returned since the reveal rules were written and nothing ever read them, so a host
  // whose reveal was moved to their new event end saw a different time in the form and no reason
  // for it — the exact failure the reveal code's own comments say this exists to prevent.
  api<{ aspectsRefused?: boolean; revealAtClamped?: boolean; guestSendAtClamped?: boolean; startRefused?: string | null; startsAt?: number }>(`/api/events/${code}/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...org(organizerCode) }, body: JSON.stringify(body) });
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
// revealInstantRefusal is re-exported so the two forms that let a host TYPE a reveal time refuse
// exactly what the server refuses, in the server's own words. A second opinion here is how a
// client ends up letting through what the API then rejects, or blocking what it would accept.
export { REVEAL_TICK_MS, REVEAL_CUSTOM, ceilToRevealTick, zonedWallTimeToMs, msToZonedWallTime, scheduledRevealAt,
         revealInstantRefusal } from '../../../shared/reveal';

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

/** Fold any number of degrees into the (-180, 180] window the API speaks in.
 *
 *  Four taps on a rotate control is a full circle and therefore nothing at all, and 270 and -90 are
 *  the same turn said two ways — client and server have to agree on the spelling, or a photo turned
 *  three times and a photo turned once back would be stored as two different corrections.
 *
 *  Deliberately a second copy of the server's normalizeTurn (app/src/server/images.ts) rather than
 *  an import: nothing under app/ is reachable from the web bundle, and a one-line fold is a cheaper
 *  thing to keep in step than a shared package would be to introduce for it. */
export function normalizeTurn(deg: number): number {
  const wrapped = ((Math.round(deg) % 360) + 360) % 360;   // [0, 360)
  return wrapped > 180 ? wrapped - 360 : wrapped;          // (-180, 180]
}

/** What a rotation answers with: everything needed to show the corrected photo without a refetch.
 *
 *  THE NEW URLS ARE THE CACHE-BUST — there is no version token to look for, and nothing here may
 *  go on displaying the url it already had. The server RENAMES the stored file, because /uploads
 *  is served `immutable, max-age=365d` and a browser will not so much as revalidate that: new
 *  bytes under an old name are invisible to everyone except someone with an empty cache, so the
 *  host would press rotate, see nothing happen, and press it again. The old name then stops
 *  existing, which is the other half of the bargain — a reference nobody updated 404s where it can
 *  be seen instead of quietly serving the wrong picture.
 *
 *  `shotSideways` is a REAL BOOLEAN here, unlike the gallery row where the field is present only
 *  when true. This reply exists to update a card already on screen, and `undefined` would leave a
 *  client merging it unable to tell "no longer sideways" from "no opinion" — so the ↻ mark would
 *  stay up until a reload. */
export interface PhotoRotation {
  success: boolean;
  id: string;
  /** The full-quality original, under its new name. Download this; play `playUrl`. */
  url: string;
  thumbUrl: string;
  /** Clips only, and only once the phone-decodable copy has been rebuilt. */
  playUrl?: string;
  /** The stored dimensions AFTER the turn: swapped by a quarter, unchanged by a half. Optional
   *  because a file whose dimensions could not be read still rotates. */
  width?: number;
  height?: number;
  /** Total degrees clockwise now baked into the file, normalised — see normalizeTurn. */
  captureRotation: number;
  shotSideways: boolean;
}

/** Turn one stored photo or clip, clockwise, for good.
 *
 *  Exactly one credential, the same pair as savePhotoCaption and for the same reasons: a guest's
 *  session token (their OWN photos only) or the organizer code (anything in their event). A photo
 *  the caller may not touch answers 404, never 403 — whether a given photo id exists, and whose
 *  roll it is in, is not a stranger's business. So a 404 from HERE means "not yours, or not there
 *  any more", and api()'s own sentence for it says exactly that; there is nothing to special-case.
 *  A 409 is two rotations racing, and the server writes the words for that one itself.
 *
 *  `quarter` is a named turn, not an angle: the server refuses 0 and refuses 270 rather than
 *  folding it, on the grounds that a client sending either has a bug worth seeing. normalizeTurn
 *  is what keeps an accumulating client on the right side of that.
 *
 *  ONE TAP DOES NOT COME HERE. The control turns the picture on screen with a transform and sends
 *  the accumulated total once, on Save: a request per 90° would re-encode the file, republish it
 *  and evict it from every cache three times on the way to a place one request could reach. */
export const rotatePhoto = (photoId: string, quarter: 90 | -90 | 180,
                            who: { sessionToken: string } | { organizerCode: string }) =>
  postJson<PhotoRotation>(`/api/photos/${photoId}/rotate`,
    { quarter, ...('sessionToken' in who ? { sessionToken: who.sessionToken } : {}) },
    'organizerCode' in who ? org(who.organizerCode) : {});

/** Heart or unheart a photo. EXPLICIT, never a toggle — a retried request must land on what the
 *  guest asked for, not the opposite of it. Comes back with the authoritative count. */
/** One endpoint, two kinds of caller: a guest passes their session, a gallery-link visitor passes
 *  their token in the header. Exactly one of them is ever set. */
export const setHeart = (photoId: string, sessionToken: string, heart: boolean, visitorToken?: string | null) =>
  postJson<{ hearted: boolean; hearts: number }>(
    `/api/photos/${photoId}/heart`, { sessionToken, heart }, vis(visitorToken));

/** Live counts for an event, and which of them are this guest's.
 *
 *  `ids` scopes it to what is on screen: a big event holds thousands of photos and this is polled,
 *  so asking for all of them every few seconds is a payload nobody reads. */
export const getHearts = (code: string, sessionToken?: string, ids?: string[], visitorToken?: string | null) => {
  const q = new URLSearchParams();
  if (ids?.length) q.set('ids', ids.join(','));
  const s = q.toString();
  // The token goes in a HEADER, never the query — as every other session-bearing read here does
  // (getPhotosBySession, chooseCard, getMe). It is a bearer credential good for the whole event,
  // and this is polled every 45s by every open gallery: in the query it was writing itself into
  // nginx, Traefik and Cloudflare access logs for the life of the event, once per poll per guest.
  // (The ZIP endpoint's query token is unavoidable — that one is reached by navigating to a URL,
  // which cannot carry headers. This is a fetch, so it can.)
  // Same rule for the visitor token: a bearer credential belongs in a header, not in a query that
  // every proxy between here and the server writes to disk.
  const headers = sessionToken ? { 'X-Session-Token': sessionToken } : vis(visitorToken);
  return api<{ hearts: Record<string, number>; mine: string[] }>(
    `/api/photos/${code}/hearts${s ? `?${s}` : ''}`,
    Object.keys(headers).length ? { headers } : undefined,
  );
};

export type PhotoComment = {
  id: string; body: string; author: string; createdAt: number;
  /** Resolved by the SERVER, not by comparing ids here — the client does not need to know who
   *  everyone is in order to know which message is its own. True for the writer and for the host. */
  canDelete: boolean;
  /** 'visitor' = somebody who only ever held a link, never joined the event. Shown in the thread,
   *  because a name alone is not a claim anyone can check. */
  authorKind?: 'guest' | 'visitor';
  /** Hearts on the COMMENT itself. `hearts` absent means an older API that did not send them, which
   *  reads the same as none. */
  hearts?: number;
  hearted?: boolean;
};

/** Threads for the photos named. Scoped by id on purpose: a thread is only read when a photo is
 *  open, so asking for a whole event's comments would be sending something nobody will look at. */
export const getComments = (code: string, ids: string[], who?: { sessionToken?: string; organizerCode?: string; visitorToken?: string | null }) =>
  api<{ comments: Record<string, PhotoComment[]> }>(
    `/api/photos/${code}/comments?ids=${ids.join(',')}`,
    { headers: {
        ...(who?.sessionToken ? { 'X-Session-Token': who.sessionToken } : {}),
        ...(who?.organizerCode ? org(who.organizerCode) : {}),
        ...vis(who?.visitorToken),
      } },
  );

export const addComment = (photoId: string, sessionToken: string, body: string, visitorToken?: string | null) =>
  postJson<PhotoComment>(`/api/photos/${photoId}/comment`, { body },
    sessionToken ? { 'X-Session-Token': sessionToken } : vis(visitorToken));

/** Give a name (or just take a token) on the EVENT'S OWN gallery link — the same two-step identity
 *  a share visitor has, for somebody who never joined. Reactions here inherit the event's switches,
 *  because the gallery link IS the event. */
/** What the event's own gallery link lets people do. Its own endpoint, not the settings form — see
 *  the note on the route for why a partial save there would clobber. */
export const saveGalleryLink = (code: string, organizerCode: string,
                               body: { galleryHeartsEnabled?: boolean; galleryCommentsEnabled?: boolean }) =>
  api<{ ok: boolean; galleryHeartsEnabled: boolean; galleryCommentsEnabled: boolean }>(
    `/api/events/${code}/gallery-link`,
    { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...org(organizerCode) }, body: JSON.stringify(body) });

export const galleryVisitorJoin = (code: string, name: string, visitorToken?: string | null) =>
  postJson<{ token: string; name: string }>(`/api/photos/${code}/visitor`, { name }, vis(visitorToken));

/** Heart a COMMENT, as a guest of the event. */
export const setCommentHeart = (commentId: string, sessionToken: string, heart: boolean, visitorToken?: string | null) =>
  postJson<{ hearted: boolean; hearts: number }>(
    `/api/photos/comments/${commentId}/heart`, { sessionToken, heart }, vis(visitorToken));

export const deleteComment = (commentId: string, who: { sessionToken?: string; organizerCode?: string; visitorToken?: string | null }) =>
  api<{ success: boolean }>(`/api/photos/comments/${commentId}`, {
    method: 'DELETE',
    headers: {
      ...(who.sessionToken ? { 'X-Session-Token': who.sessionToken } : {}),
      ...(who.organizerCode ? org(who.organizerCode) : {}),
      ...vis(who.visitorToken),
    },
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
  // `notSent` is how many of the submitted addresses were past the per-press batch and therefore
  // never attempted — not refused, not failed, not considered. It was reported nowhere for as long
  // as the cap has existed, so 250 addresses answered `sent: 200, errors: 0` and fifty people never
  // got the link to their own photos. `perSend` is the cap itself, so the UI can say how many are
  // left without hardcoding a number that lives on the server.
  postJson<{ sent: number; errors: number; skipped: number; notSent: number; perSend: number }>(
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
  /** More to come when this is a string; null or absent means this is the last page. */
  nextCursor?: string | null;
  revealed: boolean; photoCount?: number; revealMode?: string; revealAt?: number | null;
  /** Would asking the host actually change anything? True for a manual event and for photos that
   *  have been explicitly hidden; false for a timed reveal, where waiting is the answer. Optional
   *  because a server that predates it says nothing, and absent must read as "do not ask". */
  awaitingHost?: boolean;
  hasHighlights?: boolean; allowDownloads?: boolean; moderationEnabled?: boolean;
  /** Moderated events only: how many photos are waiting for the host. THE signal that separates
   *  "the host is still approving" from "this event is empty" — two states that look identical from
   *  a revealed gallery with no photos in it, and which the client used to guess at (always
   *  wrongly, in the second case) and then poll for ever. Optional because a server that predates
   *  it does not send it, and absent must read as "keep asking", not as "stop". */
  pendingCount?: number;
  /** Participant mode only. How many shots are this guest's, and how many of everyone else's they
   *  are allowed to see. Numbers rather than rows, because `own=true` no longer ships the rows —
   *  see the ?own comment in the server's photos route. */
  ownCount?: number; othersCount?: number;
  myParticipantId?: string; photos?: Photo[];
}
/** `ownOnly` asks the server for just this guest's shots. The camera's roll wants nothing else, and
 *  without it a revealed event sends the whole gallery for the client to throw three quarters of
 *  away — on a phone, at a venue, over the worst connection the product ever runs on. */
export const getPhotosBySession = (code: string, sessionToken: string, highlightsOnly = false, ownOnly = false) => {
  const q = [highlightsOnly ? 'highlightsOnly=true' : '', ownOnly ? 'own=true' : ''].filter(Boolean).join('&');
  return api<PhotosResponse>(`/api/photos/${code}${q ? `?${q}` : ''}`, { headers: { 'X-Session-Token': sessionToken } });
};
export const getPhotosByOrganizer = (code: string, organizerCode: string) =>
  api<PhotosResponse>(`/api/photos/${code}`, { headers: org(organizerCode) });
/** One page of the gallery. `after` is the previous page's `nextCursor` — an opaque `<takenAt>_<id>`
 *  key, NOT a page number: offsets renumber themselves when a photo is uploaded or rejected
 *  mid-scroll, which shows a guest the same shot twice or skips one without saying so. */
/** `fresh` adds a one-off cache-buster. The gallery answer is deliberately shared and cacheable
 *  for 30s (galleryCacheSeconds) because the ORDER is everyone's, not yours — but a viewer who has
 *  just hearted or unhearted something must see their own change take effect, and a cached page
 *  would show them the old order for up to half a minute. Only their own write sets this, so the
 *  cache still does its job for every other request. */
export const getGalleryPhotos = (code: string, highlightsOnly = false, after?: string | null,
                                sort?: 'newest' | 'hearted', fresh = false) =>
  api<PhotosResponse>(`/api/photos/${code}?gallery=true${highlightsOnly ? '&highlightsOnly=true' : ''}`
    + (sort === 'hearted' ? '&sort=hearted' : '')
    + (after ? `&after=${encodeURIComponent(after)}` : '')
    + (fresh ? `&fresh=${Date.now()}` : ''));

/** The missions on THIS guest's card, and the ids they have already captured. A guest is handed
 *  one card of possibly several, so this is per-participant, never the event's whole list. */
export type GuestMissions = {
  challenges?: { id: string; text: string }[];
  challengesDone?: string[];
  challengeSet?: string | null;
  challengeTick?: string | null;
} & GuestCardStatus;

/** One of the host's printed cards, as somebody deciding which one is in their hand needs to see
 *  it: the label printed on it, and enough of the list to tell two apart when both say "Card". */
export type CardChoice = { key: string; label: string; preview: string[]; count: number };

/** What the server says about WHICH card this guest has, beyond the list itself.
 *
 *  Every field optional, so a response from a server that does not serve them — or one already in
 *  a cache — reads as a guest with nothing to answer, which is what such a guest is. */
export type GuestCardStatus = {
  /** 'qr' a printed card named it · 'self' they told us · 'auto' the round-robin. */
  setSource?: 'qr' | 'self' | 'auto';
  /** Is the “which card are you?” question still open for this guest? THE gate on the prompt. */
  setPending?: boolean;
  /** Sent only while it is. */
  setChoices?: CardChoice[];
  /** ...and whether the cards at this event each carry their own code, so the better suggestion is
   *  to go and scan the one in their hand. */
  cardsHaveQr?: boolean;
};

/** `set` is the key off a printed trick card's QR (`?set=b` on the join link).
 *
 *  It has to travel from the page URL into the join call, and for a while it did not: the server
 *  has always honoured it, the QR endpoint has always printed it, and nothing in between ever
 *  passed it on — so every guest who scanned a card got whatever the round-robin handed out. The
 *  card in their hand disagreeing with the app is the one thing printing several cards is meant to
 *  avoid, so this argument is the fix, and the server keeps the last word on whether the key is
 *  real. */
export const joinEvent = (joinCode: string, name: string, email?: string, set?: string) =>
  postJson<{ participant: { id: string; name: string }; sessionToken: string; joinCode: string; photosRemaining: number; eventName: string; noFlash?: boolean; recovered?: boolean; canBuyShots?: boolean; canAskHost?: boolean; faceMatching?: boolean; faceEnrolled?: boolean; feedbackGiven?: boolean; emailFromPayment?: boolean; wantsPhotos?: boolean } & GuestMissions>(
    '/api/participants', { joinCode, name, email: email || undefined, set: set || undefined });

/** The guest saying which card they are holding — or, with `null`, that they have not got one, in
 *  which case the round-robin's answer stands. Answerable once: the server refuses a second attempt
 *  with 409 and hands back the card they already have. */
export const chooseCard = (sessionToken: string, set: string | null) =>
  postJson<{ ok: boolean } & GuestMissions>(
    '/api/participants/card', { set }, { 'X-Session-Token': sessionToken });
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
  /** Always present. The list exists to mail a lot of people one link, so a guest without an
   *  address is a guest nothing here can reach — the column is NOT NULL (migration 0054) and the
   *  server refuses a guest without one. Whoever the host has no address for gets a printed card,
   *  which is the host's job and not this product's.
   *
   *  There is no `phone`. The server has no such column and the importer skips a phone column
   *  rather than storing it — Snapdini sends email and nothing else, so a number is data nothing
   *  here can act on. See looksPhone() in app/src/server/csv.ts. */
  email: string;
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

export type GuestField = 'name' | 'email' | 'notes' | 'ignore';

/** One line of the file as the preview shows it. `action: 'skip'` rows are rendered greyed rather
 *  than hidden — a file where 40 of 200 rows are duplicates is a file the host needs to look at. */
export interface ImportRow {
  line: number;
  /** `email` is nullable HERE and nowhere else: a preview row is a line of the host's file, and a
   *  line with no address is exactly the case the preview exists to show them. It is skipped, never
   *  stored, so an EventGuest always has one. */
  guest: { name: string | null; email: string | null; notes: string | null };
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
  /** `noEmail` is broken out of `skip` deliberately: it is the one skip reason the host can do
   *  something about, and a file where half the rows have no address must say so in its own words
   *  rather than as part of a lump. */
  counts: { add: number; skip: number; duplicate: number; invalid: number; noEmail: number };
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

/** Send the Snapdini invite. Omit `guestIds` to mail everyone on the list who is not blocked.
 *
 *  `skipped` is the part that matters: addresses that were NOT mailed because they are suppressed,
 *  with the reason. A count of successes alone is how a guest ends up never invited. */
export const sendInvites = (code: string, organizerCode: string, guestIds?: string[]) =>
  // `notSent`: selected, and not attempted this press — the batch cap, reported rather than hidden.
  // The server puts anyone who has never had an invite at the front of the queue, so pressing Send
  // again reaches exactly the people this press could not.
  postJson<{ sent: number; failed: number; notSent: number; perSend: number;
             skipped: { email: string; name: string | null; reason: string }[] } & GuestListPayload>(
    `/api/events/${code}/guests/invite`, { guestIds }, org(organizerCode));

// ── The site-admin action log ────────────────────────────────────────────────
//
// What a site admin changed on an event they do NOT own: who, which event, what, the value before
// and the value after, and when. Site-admin only, newest first:
//
//     GET /api/admin/actions?eventId=<id>&limit=<n>&offset=<n>
//     → { actions: [...], total, limit, offset }
//
// THIS FILE IS THE ONLY PLACE IN THE WEB APP THAT KNOWS THE WIRE SHAPE. Both surfaces that render
// the log — the console and the event manager — consume `AdminAction` and nothing else, so a
// rename on the server is a line in `pick()` below rather than a hunt through two pages and a
// component. That mattered while the endpoint was being written in parallel and it still does:
// every field is read through a list of candidate names and nothing throws on a missing one. A log
// that renders four of its six columns is useful; a log that white-screens because `before` came
// back under another name is not, and this is exactly the screen somebody opens when they are
// already trying to work out what went wrong.
//
// `before` and `after` are OBJECTS WITH THE SAME KEYS holding only what changed (see migration
// 0068) — `{"revealMode":"manual"}` → `{"revealMode":"instant"}`. So they are unzipped here into
// one row per key, which is the generic renderer the table was designed around: one shape covers a
// settings save, a rotation and a bulk moderation, including the toggle nobody has written yet.
// `after` NULL is meaningful and is not `{}`: it means the thing stopped existing, and `before`
// then holds the only surviving copy of it.

/** One field that moved, unzipped from the before/after pair. */
export interface AdminActionChange {
  key: string;
  /** THE RECOVERY PATH. There is deliberately no revert — not here and not on the server — so this
   *  string is the whole remedy: a human reads it and puts the value back through the normal
   *  control, which is the path that already carries the confirms and the validation. Rendered
   *  selectable and copyable for exactly that reason. */
  before: string;
  after: string;
}

/** One change, in the shape the UI renders. Every field is always present — absent on the wire
 *  becomes empty here and the view draws an em dash — so no consumer has to guard. */
export interface AdminAction {
  /** Stable enough for an {#each} key; falls back to the row's position if the server sends none. */
  id: string;
  /** Epoch ms, or null when nothing parseable arrived. Never a guess: an invented "now" on an audit
   *  row is worse than no time, because it reads as fact. */
  at: number | null;
  /** The admin, as an address. */
  actor: string;
  eventId: string;
  eventName: string;
  eventCode: string;
  /** False once the event has been deleted — including by the very action being reported, which is
   *  why the log keeps no foreign key to it. There is then nowhere to drill into. */
  eventExists: boolean;
  /** Verb and noun: 'event.settings' on a 'event', 'photo.rotate' on a 'photo'. */
  action: string;
  target: string;
  changes: AdminActionChange[];
  /** The raw pair as text. Only used when the values are not key-shaped — a scalar, or a server
   *  that has not settled on objects — so the row still says something rather than nothing. */
  before: string;
  after: string;
}

export interface AdminActionPage {
  actions: AdminAction[];
  /** How many there are in total behind this filter, which is what "load more" is measured against.
   *  Offset paging, not a cursor: `at` ties are broken by `id DESC` on the server, so consecutive
   *  pages cannot overlap the way they would on `at` alone. */
  total: number;
}

/** First key that is actually there. Not `a ?? b ?? c`: `false` and `0` are values a setting really
 *  takes, and a nullish chain over a bag of unknown keys drops them for the next candidate. */
function pick(row: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null) return row[k];
  }
  return undefined;
}

/** A value as the log should SHOW it.
 *
 *  Booleans and numbers are printed rather than run through a falsy check — "false" is the single
 *  most important thing this log can say, and `String(v) || '—'` would turn it into a dash. Objects
 *  become JSON, because `[object Object]` is the log failing at its one job. */
function showValue(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}

/** Epoch ms from a number, a numeric string, or an ISO date. Null rather than NaN or Date.now()
 *  when it is none of those. */
function showTime(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

const plainObject = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** Unzip the pair into one row per field that moved.
 *
 *  Keys from BOTH sides, in before's order first: a delete has no `after` at all, and an action
 *  that added a field has no `before` for it. Either missing side prints as an em dash in the view
 *  rather than as the string "undefined". */
function unzip(before: unknown, after: unknown): AdminActionChange[] {
  const b = plainObject(before);
  const a = plainObject(after);
  if (!b && !a) return [];          // scalars, or nothing — the raw pair is shown instead
  const keys = [...new Set([...Object.keys(b ?? {}), ...Object.keys(a ?? {})])];
  return keys.map((key) => ({ key, before: showValue(b?.[key]), after: showValue(a?.[key]) }));
}

/** THE ONE PLACE that knows the wire shape. Each candidate list is ordered most-specific first, so
 *  a server sending both `adminEmail` and `admin` gives the address rather than an id. */
export function normalizeAdminAction(raw: unknown, index: number): AdminAction {
  const row = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  // An embedded event object is as plausible a shape as flattened columns and costs one line.
  const ev = plainObject(row.event) ?? {};
  const before = pick(row, ['before', 'beforeValue', 'before_value', 'oldValue', 'old_value', 'from']);
  const after = pick(row, ['after', 'afterValue', 'after_value', 'newValue', 'new_value', 'to']);

  return {
    id: showValue(pick(row, ['id', 'actionId', 'action_id'])) || `row-${index}`,
    at: showTime(pick(row, ['at', 'createdAt', 'created_at', 'timestamp', 'ts'])),
    actor: showValue(
      pick(row, ['adminEmail', 'admin_email', 'actorEmail', 'actor_email', 'adminName', 'admin_name',
                 'adminUserId', 'admin_user_id', 'actor'])
      ?? pick(plainObject(row.actor) ?? {}, ['email', 'name', 'id']),
    ),
    eventId: showValue(pick(row, ['eventId', 'event_id']) ?? pick(ev, ['id'])),
    eventName: showValue(pick(row, ['eventName', 'event_name']) ?? pick(ev, ['name'])),
    eventCode: showValue(
      pick(row, ['eventJoinCode', 'event_join_code', 'joinCode', 'join_code', 'eventCode', 'event_code'])
      ?? pick(ev, ['joinCode', 'join_code']),
    ),
    // Absent means "we were not told", and the only safe reading of that is that the event is still
    // there — offering a link that 404s is a smaller failure than hiding a working one.
    eventExists: pick(row, ['eventExists', 'event_exists']) !== false,
    action: showValue(pick(row, ['action', 'type', 'kind', 'operation'])),
    target: showValue(pick(row, ['targetType', 'target_type', 'target', 'field', 'setting'])),
    changes: unzip(before, after),
    before: showValue(before),
    after: showValue(after),
  };
}

/** Fetch a page of the log.
 *
 *  `eventId` filters to one event — the manager passes it so the operator can see what he has
 *  already changed HERE before he touches anything; the console omits it for the platform-wide
 *  view. Both go through the same normaliser, so the two surfaces cannot drift into describing the
 *  same change differently. */
export async function listAdminActions(opts: { eventId?: string | null; limit?: number; offset?: number } = {})
    : Promise<AdminActionPage> {
  const q = new URLSearchParams();
  if (opts.eventId) q.set('eventId', opts.eventId);
  q.set('limit', String(opts.limit ?? 25));
  if (opts.offset) q.set('offset', String(opts.offset));

  // `unknown`, then narrowed here rather than an `any` cast at the call site: the response shape is
  // the thing that moves, and the whole point of this module is that it stops moving at this line.
  const res = await api<unknown>(`/api/admin/actions?${q}`);
  const body = (plainObject(res) ?? {}) as Record<string, unknown>;
  // A bare array is as plausible a first draft as any wrapper, so it is accepted too.
  const listRaw = Array.isArray(res) ? res : pick(body, ['actions', 'items', 'rows', 'entries', 'results']);
  const list = Array.isArray(listRaw) ? listRaw : [];
  const total = pick(body, ['total', 'count']);

  return {
    actions: list.map(normalizeAdminAction),
    // No total (or a bare array) means "what you have is what there is" — better than a Load more
    // button that fetches the same page again for ever.
    total: typeof total === 'number' ? total : list.length,
  };
}
