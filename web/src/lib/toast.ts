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
