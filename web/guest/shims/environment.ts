/** Compile-time values normally supplied by SvelteKit, with no server environment access. */
export const browser = true;
export const building = false;
export const dev = import.meta.env.DEV;
export const version = __GUEST_BUILD_VERSION__;

declare const __GUEST_BUILD_VERSION__: string;
