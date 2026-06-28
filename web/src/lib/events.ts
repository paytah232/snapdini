import { api, postJson } from './api';

export interface Photo {
  id: string;
  url: string;            // full-quality original (lightbox + download)
  thumbUrl?: string;      // small fast thumbnail (grids); falls back to url if absent
  takenAt: number;
  participantName: string;
  participantId: string;
  isHighlighted: boolean;
  rating: number; // 0–5; 5 == favourite
  mediaType: 'photo' | 'video';
  status?: 'approved' | 'pending' | 'rejected';
  isOwn?: boolean;
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
  aspectRatios: string[]; videoSeconds: number; startsAt: number; expiresAt: number;
  isDemo: boolean; isUpcoming: boolean; isExpired: boolean; isLocked: boolean; isRevealed: boolean;
  allowDownloads: boolean; noFlash: boolean; theme: EventTheme | null; participantCount: number; photoCount: number;
}

export interface MyEvent {
  id: string; name: string; joinCode: string; slug: string | null; organizerCode: string;
  revealMode: string; startsAt: number; expiresAt: number; isLocked: boolean;
  isUpcoming: boolean; isExpired: boolean; participantCount: number; photoCount: number;
  coHost?: boolean;   // true when you co-host (don't own) this event
}

export interface AdminEvent extends Omit<PublicEvent, 'participantCount'> {
  joinUrl: string; galleryUrl: string; revealedAt: number | null;
  moderationEnabled: boolean; ratingMode: RatingMode; pendingCount: number; participantCount: number;
  participants: { id: string; name: string; email: string | null; photosTaken: number; joinedAt: number }[];
  emailEnabled: boolean;
  // entitlement (upgrades)
  guestCap: number; videoSeconds: number; retentionDays: number; paid: boolean; amountPaidCents: number;
  posterConfig: Record<string, unknown> | null; purged: boolean;
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

export interface SlideshowVersion { id: string; url: string; favourite: boolean; label: string; resolution: string; createdAt: number; }
// Friendly-named download (server sets <event>-<date>-snapdini.mp4); res='1080p' live-transcodes a 4K render.
export const slideshowDownloadUrl = (code: string, id: string, res?: '1080p') =>
  `/api/events/${code}/slideshow/${id}/download${res ? `?res=${res}` : ''}`;
export interface SlideshowStatus {
  status: 'idle' | 'running' | 'done' | 'error';
  url?: string; error?: string; truncated?: boolean;
  progress?: number; phase?: 'collecting' | 'encoding';
  music: { id: string; label: string }[];
  photoCount?: number; favouriteCount?: number; videoCount?: number; hasCustomAudio?: boolean; maxImages?: number; secondsPerDefault?: number;
  recent?: SlideshowVersion[];
  qualities?: { id: string; label: string; kbps: number }[];
  resolutions?: { id: string; label: string; sizeScale: number }[];
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
export const startSlideshowJob = (code: string, organizerCode: string, body: { favouritesOnly: boolean; track?: string; tracks?: string[]; loopMusic?: boolean; secondsPer?: number; includeVideos?: boolean; keepVideoAudio?: boolean; quality?: string; resolution?: string; branding?: boolean }) =>
  api<SlideshowStatus>(`/api/events/${code}/slideshow`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...org(organizerCode) }, body: JSON.stringify(body) });
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
  event: { name: string; theme: EventTheme | null; allowDownloads: boolean };
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
  api(`/api/events/${code}/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...org(organizerCode) }, body: JSON.stringify(body) });
export const setReveal = (code: string, organizerCode: string, on: boolean) =>
  postJson(`/api/events/${code}/${on ? 'reveal' : 'unreveal'}`, {}, org(organizerCode));
export const toggleLock = (code: string, organizerCode: string) => postJson(`/api/events/${code}/lock`, {}, org(organizerCode));
export const deleteEvent = (code: string, organizerCode: string) =>
  api(`/api/events/${code}`, { method: 'DELETE', headers: org(organizerCode) });
export const setHighlights = (code: string, organizerCode: string, photoIds: string[], highlight: boolean) =>
  postJson(`/api/events/${code}/highlights`, { photoIds, highlight }, org(organizerCode));
export const moderate = (code: string, organizerCode: string, photoIds: string[], action: 'approve' | 'reject' | 'restore') =>
  postJson(`/api/events/${code}/moderate`, { photoIds, action }, org(organizerCode));
export const ratePhoto = (code: string, organizerCode: string, photoId: string, rating: number) =>
  postJson<{ success: boolean; photoId: string; rating: number; isHighlighted: boolean }>(
    `/api/events/${code}/rate`, { photoId, rating }, org(organizerCode));
export const saveTheme = (code: string, organizerCode: string, theme: EventTheme) =>
  api(`/api/events/${code}/theme`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...org(organizerCode) }, body: JSON.stringify({ theme }) });
export const emailGallery = (code: string, organizerCode: string, emails: string[]) =>
  postJson(`/api/events/${code}/email-gallery`, { emails }, org(organizerCode));
// Remove a participant (e.g. a duplicate join). Their uploads are deleted too — returns the count.
export const deleteParticipant = (code: string, organizerCode: string, id: string) =>
  api<{ ok: boolean; removedPhotos: number }>(`/api/events/${code}/participants/${id}`, { method: 'DELETE', headers: org(organizerCode) });
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

export const joinEvent = (joinCode: string, name: string, email?: string) =>
  postJson<{ participant: { id: string; name: string }; sessionToken: string; joinCode: string; photosRemaining: number; eventName: string; noFlash?: boolean; recovered?: boolean }>(
    '/api/participants', { joinCode, name, email: email || undefined });
export const getMe = (sessionToken: string) =>
  api<{ participant: { id: string; name: string; photosTaken: number; email: string | null }; photosRemaining: number; eventName: string; joinCode: string; slug: string | null; startsAt: number; expiresAt: number; isLocked: boolean; maxPhotos: number; allowDownloads: boolean; noFlash: boolean }>(
    '/api/participants/me', { headers: { 'X-Session-Token': sessionToken } });
