// Only this adapter-node file API is used. Keep Node globals out of browser source checks.
declare module 'node:fs/promises' {
  export function readFile(path: string): Promise<Uint8Array<ArrayBuffer>>;
}
