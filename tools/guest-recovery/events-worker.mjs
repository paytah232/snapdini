/** Public metadata only. Publication happens through the authenticated deployment API. */
export async function handle(request, env) {
  const pathname = new URL(request.url).pathname;
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex, nofollow' };
  if (!['GET', 'HEAD'].includes(request.method))
    return new Response(null, { status: 405, headers: { ...headers, allow: 'GET, HEAD' } });
  if (!/^\/guest\/(events\/[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*\.json|publication\.json)$/.test(pathname))
    return new Response(null, { status: 404, headers });
  let response;
  try { response = await env.ASSETS.fetch(request); }
  catch { return new Response(null, { status: 503, headers }); }
  if (!response.ok) return new Response(null, { status: response.status, headers });
  // Fetch the body even for HEAD so a withdrawal has the same status as GET.
  if (request.method === 'HEAD') {
    try { response = await env.ASSETS.fetch(new Request(request.url, { method: 'GET' })); }
    catch { return new Response(null, { status: 503, headers }); }
    if (!response.ok) return new Response(null, { status: response.status, headers });
  }
  let body;
  try { body = await response.json(); }
  catch { return new Response(null, { status: 503, headers }); }
  if (body?.schema !== 1) return new Response(null, { status: 503, headers });
  const status = body.withdrawn === true ? 410 : 200;
  return new Response(request.method === 'HEAD' ? null : JSON.stringify(body), { status, headers });
}
export default { fetch: handle };
