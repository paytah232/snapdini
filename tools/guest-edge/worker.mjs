/** Isolated development guest API/media proxy. Static assets normally bypass this code. */
export function appOrigin(raw, lane) {
  if (lane !== 'dev') throw new Error('Only the development lane is supported');
  const origin = new URL(raw);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/'
      || origin.search || origin.hash || origin.hostname === 'snapdini.com'
      || origin.hostname === 'www.snapdini.com') throw new Error('Invalid development APP_ORIGIN');
  return origin.origin;
}

const REQUEST_HEADERS = ['accept', 'accept-language', 'content-type', 'range', 'if-range',
  'if-none-match', 'if-modified-since', 'if-match', 'if-unmodified-since',
  'x-session-token', 'x-visitor-token', 'x-capture-id', 'x-upload-id', 'x-upload-index', 'x-upload-total'];

export async function handle(request, env, fetchOrigin = fetch) {
  let origin;
  try { origin = appOrigin(env.APP_ORIGIN, env.DEPLOYMENT_LANE); }
  catch { return new Response('Development proxy is not configured', { status: 503 }); }
  const incoming = new URL(request.url);
  if (!incoming.pathname.startsWith('/api/') && !incoming.pathname.startsWith('/uploads/'))
    return new Response('Not found', { status: 404 });
  // Setting pathname/search independently prevents //host paths becoming a different origin.
  const target = new URL(origin);
  target.pathname = incoming.pathname;
  target.search = incoming.search;
  const headers = new Headers();
  for (const name of REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  // Guest tokens survive; account cookies, Authorization, organizer/admin keys and
  // caller-controlled forwarding headers never cross this separate guest boundary.
  const init = { method: request.method, headers, redirect: 'manual', signal: request.signal };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body;
    init.duplex = 'half'; // Node test compatibility; Workers streams the body unchanged.
  }
  try {
    const upstream = await fetchOrigin(new Request(target, init));
    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.delete('set-cookie');
    responseHeaders.set('cache-control', 'no-store');
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText,
      headers: responseHeaders });
  } catch {
    return new Response(JSON.stringify({ error: 'Snapdini is temporarily unavailable.' }), {
      status: 503, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }
}

export default { fetch: (request, env) => handle(request, env) };
