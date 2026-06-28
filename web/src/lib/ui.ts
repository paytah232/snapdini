// On a grid <img> whose thumbnail is missing (e.g. pre-backfill photos), fall back to
// the full-resolution original — once, to avoid an error loop if that's missing too.
export function imgFallback(e: Event, fullUrl: string): void {
  const t = e.currentTarget as HTMLImageElement;
  if (!t.dataset.fb) {
    t.dataset.fb = '1';
    t.src = fullUrl;
  }
}

// On a video-poster <img> whose poster is missing (e.g. pre-backfill clips, or ffmpeg failed),
// hide the broken image so the cell just shows its dark background + ▶ overlay.
export function hidePoster(e: Event): void {
  (e.currentTarget as HTMLImageElement).style.display = 'none';
}

// Svelte action for modals/dialogs: move focus into the element on open and restore it
// to the previously-focused element on close. Pair with Escape-to-close on the modal.
export function modalFocus(node: HTMLElement) {
  const prev = document.activeElement as HTMLElement | null;
  node.focus();
  return { destroy() { prev?.focus?.(); } };
}
