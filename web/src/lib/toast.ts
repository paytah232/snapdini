import { writable } from 'svelte/store';

export type ToastKind = 'info' | 'error' | 'success';
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
