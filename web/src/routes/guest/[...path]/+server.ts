import { readFile } from 'node:fs/promises';
import type { RequestHandler } from './$types';

// Local dev serves the same artifact that will be hosted independently at the edge. This
// route never evaluates a camera page on the server or exposes directory listings/source files.
export const GET: RequestHandler = async ({ params }) => {
  const path = params.path ?? '';
  const snapshot = /^events\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\.json$/.exec(path);
  const shell = /^(?:(?:join|e|saved)\/[^/]+\/?|index\.html)?$/.test(path);
  if (!snapshot && !shell) return new Response('Not found', { status: 404 });
  try {
    const data = await readFile(snapshot ? `/guest-events/${snapshot[1]}.json` : 'build/client/guest/index.html');
    return new Response(data, { headers: {
      'Content-Type': snapshot ? 'application/json' : 'text/html; charset=utf-8',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow',
    } });
  } catch { return new Response('Not found', { status: 404 }); }
};
