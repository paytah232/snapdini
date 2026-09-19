import { writable } from 'svelte/store';

export type ToastKind = 'info' | 'error' | 'success' | 'hint';
export const toast = writable<{ msg: string; kind: ToastKind } | null>(null);

let timer: ReturnType<typeof setTimeout> | undefined;

function show(msg: string, kind: ToastKind): void {
  toast.set({ msg, kind });
  clearTimeout(timer);
  timer = setTimeout(() => toast.set(null), 2600);
}

// Backwards-compatible: showToast(msg) = info, showToast(msg, true) = error.
export function showToast(msg: string, error = false): void {
  show(msg, error ? 'error' : 'info');
}

export function showSuccess(msg: string): void {
  show(msg, 'success');
}

/** A message the reader has to ACT on, rather than one reporting what already happened.
 *
 *  Worth its own kind because of where it lands: a hint fires in response to a touch, so it appears
 *  under the hand that caused it, next to whatever that hand is still holding. An info toast is
 *  quiet on purpose — it is telling you something is done — and quiet is exactly wrong for an
 *  instruction competing with the thing beneath your own finger. */
export function showHint(msg: string): void {
  show(msg, 'hint');
}

/** Take a toast down NOW, without waiting out its timer.
 *
 *  A toast describes something that just happened. The moment the thing it describes stops being
 *  the subject — a different photo is on screen, the viewer is closed, the editor is reopened — it
 *  is stale, and a stale confirmation hovering over new content reads as being about that content
 *  instead. Cheaper to dismiss it than to leave someone working out which it meant. */
export function hideToast(): void {
  clearTimeout(timer);
  toast.set(null);
}
