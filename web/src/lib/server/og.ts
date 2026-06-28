import { env } from '$env/dynamic/private';

// Server-side base for reaching the Express API directly (inside the Docker network),
// bypassing nginx. Falls back to the dev service name.
const API_BASE = env.INTERNAL_API_BASE || 'http://app:3000';

export interface OgData {
  title: string;
  description: string;
  image?: string;
  url: string;
}

/**
 * Fetch an event server-side and build Open Graph / link-preview data, so links
 * shared in messengers (WhatsApp, Messenger, iMessage, Slack, …) render a rich card.
 * Resilient: returns `{}` on any failure so the page still renders.
 */
export async function loadEventOg(
  code: string,
  url: URL,
  kind: 'gallery' | 'invite'
): Promise<{ og?: OgData }> {
  try {
    const res = await fetch(`${API_BASE}/api/events/${encodeURIComponent(code)}`);
    if (!res.ok) return {};
    const ev = await res.json();
    if (!ev?.name) return {};

    const header: string | undefined = ev?.theme?.headerImage || undefined;
    const title = kind === 'gallery' ? `${ev.name} — Photo Gallery` : ev.name;
    const description =
      kind === 'gallery'
        ? `See the shared photos from ${ev.name} on Snapdini 📷`
        : `You're invited to ${ev.name} — join the camera roll and start snapping 📷`;

    return {
      og: {
        title,
        description,
        image: header ? new URL(header, url.origin).href : undefined,
        url: url.href
      }
    };
  } catch {
    return {};
  }
}

/**
 * Link-preview data for a shared gallery (/s/<token-or-slug>). The share's NAME drives the preview
 * title; a photo from the share (or the event image) becomes the card image.
 */
export async function loadShareOg(token: string, url: URL): Promise<{ og?: OgData }> {
  try {
    const res = await fetch(`${API_BASE}/api/shares/${encodeURIComponent(token)}`);
    if (!res.ok) return {};
    const s = await res.json();
    const name: string = (s?.label && String(s.label)) || (s?.event?.name ? `${s.event.name} — photos` : 'Shared photos');
    const photo: string | undefined = (Array.isArray(s?.photos) && s.photos[0]?.thumbUrl)
      ? s.photos[0].thumbUrl
      : (s?.event?.theme?.headerImage || undefined);
    return {
      og: {
        title: name,
        description: s?.event?.name ? `Photos from ${s.event.name}, shared via Snapdini 📷` : 'Photos shared via Snapdini 📷',
        image: photo ? new URL(photo, url.origin).href : undefined,
        url: url.href,
      }
    };
  } catch {
    return {};
  }
}
