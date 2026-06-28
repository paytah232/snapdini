// Best-effort client-side error reporting — fire-and-forget, never throws back at the caller.
// Sends TECHNICAL data only (a short message + where it happened); never photos or content.
export function reportClientError(message: string, context?: string, eventCode?: string): void {
  try {
    fetch('/api/client-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: String(message).slice(0, 500),
        context,
        eventCode,
        url: typeof location !== 'undefined' ? location.pathname : undefined,
      }),
      keepalive: true,
    }).catch(() => {});
  } catch { /* ignore */ }
}
