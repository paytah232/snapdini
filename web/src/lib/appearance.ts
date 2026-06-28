import { writable } from 'svelte/store';
import { applyTheme, type ThemeMode } from './theme';

// App-wide appearance preference for the marketing/app chrome (not per-event themes).
// Default is DARK — it suits the brand; users can switch and we remember the choice.
const KEY = 'snapdini-appearance';

function load(): ThemeMode {
  if (typeof localStorage === 'undefined') return 'dark';
  const v = localStorage.getItem(KEY);
  return v === 'light' || v === 'dark' || v === 'system' ? v : 'dark';
}

export const appearance = writable<ThemeMode>(load());

export function setAppearance(mode: ThemeMode): void {
  appearance.set(mode);
  try { localStorage.setItem(KEY, mode); } catch { /* ignore */ }
  applyTheme(mode);
}

// Apply the saved preference (call on app mount).
export function initAppearance(): void {
  applyTheme(load());
}
