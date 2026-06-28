// Participant session lives in localStorage keyed by joinCode (matches the old app, so
// existing demo/join links keep working).
const key = (joinCode: string) => `session_${joinCode}`;

export const getSession = (joinCode: string): string | null =>
  typeof localStorage !== 'undefined' ? localStorage.getItem(key(joinCode)) : null;
export const saveSession = (joinCode: string, token: string): void => localStorage.setItem(key(joinCode), token);
export const clearSession = (joinCode: string): void => localStorage.removeItem(key(joinCode));

// Organizer admin code (per-event), used by the admin page.
const adminKey = (joinCode: string) => `admin_${joinCode}`;
export const getAdminCode = (joinCode: string): string =>
  (typeof localStorage !== 'undefined' ? localStorage.getItem(adminKey(joinCode)) : '') || '';
export const saveAdminCode = (joinCode: string, code: string): void => localStorage.setItem(adminKey(joinCode), code);
// Clear every cached organizer code — called on logout so signing out also revokes the
// quick manager access this browser had stored (organizer codes are bearer credentials).
export const clearAllAdminCodes = (): void => {
  if (typeof localStorage === 'undefined') return;
  for (const k of Object.keys(localStorage)) if (k.startsWith('admin_')) localStorage.removeItem(k);
};
