// Snapdini integration spec — a zip downloads whatever the event and its guests are called.
//
// The demo roll is named with an emoji, and every zip of one answered 500 until 1.5.8: the name
// went verbatim into the Content-Disposition header, which Node refuses for any byte outside
// ASCII. This drives the real route with the names people actually use — curly apostrophes,
// straight ones, quotes, slashes, emoji — and reads the bytes back as a zip. Both the event zip
// and the share zip, and the demo roll itself.
import { BASE, api, createEvent, dbq, group, join, ok, org, spec, upload } from '../lib/harness.mjs';

const isZip = (buf) => buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b;   // "PK"
async function download(url, headers = {}) {
  const r = await fetch(`${BASE}${url}`, { headers });
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, type: r.headers.get('content-type') || '', disposition: r.headers.get('content-disposition') || '', buf };
}

await spec('07b-zip-names', async () => {
  group('A zip downloads for any event name');
  const names = ["Tatiana’s 21st birthday 🎉", "Sarah's Hen Do", 'Josh and Otis\' "Big Day" / 2026', '日本語の結婚式'];
  for (const name of names) {
    const ev = await createEvent({ name, revealMode: 'instant', allowDownloads: true });
    const g = await join(ev.joinCode, "O'Brien 🎞️ / slash");
    await upload(g.json.sessionToken);
    await upload(g.json.sessionToken);
    const z = await download(`/api/photos/${ev.joinCode}/download`, org(ev.organizerCode));
    ok(`organizer zip 200 for ${JSON.stringify(name)}`, z.status === 200, `status ${z.status} ${z.buf.toString().slice(0, 80)}`);
    ok('…and the body is a zip', isZip(z.buf), `${z.type} ${z.buf.length}B`);
    ok('…with an ASCII filename and a UTF-8 one', /filename="[\x20-\x7e]+\.zip"; filename\*=UTF-8''/.test(z.disposition), z.disposition);
    const gz = await download(`/api/photos/${ev.joinCode}/download?sessionToken=${g.json.sessionToken}`);
    ok('guest own-roll zip 200', gz.status === 200 && isZip(gz.buf), `status ${gz.status}`);
    // The same event's share link.
    const sh = await api('POST', `/api/events/${ev.joinCode}/shares`, { headers: org(ev.organizerCode), body: { kind: 'all' } });
    const token = sh.json?.id || sh.json?.share?.id || sh.json?.token;
    if (token) {
      const sz = await download(`/api/shares/${token}/download`);
      ok('share zip 200 and a zip', sz.status === 200 && isZip(sz.buf), `status ${sz.status} ${sz.buf.toString().slice(0, 60)}`);
    } else {
      ok('share could be created for the zip check', false, `${sh.status} ${sh.text.slice(0, 80)}`);
    }
  }

  group('The demo roll (emoji name) zips too');
  const demo = await api('POST', '/api/events/demo', { body: {} });
  ok('demo roll created', demo.status === 200 && !!demo.json?.joinCode, `${demo.status}`);
  if (demo.json?.joinCode) {
    const g = await join(demo.json.joinCode, 'Demo Guest');
    await upload(g.json.sessionToken);
    const z = await download(`/api/photos/${demo.json.joinCode}/download`, org(demo.json.organizerCode));
    ok('demo-roll zip 200 and a zip', z.status === 200 && isZip(z.buf), `status ${z.status} ${z.buf.toString().slice(0, 80)}`);
    const name = dbq(`SELECT name FROM events WHERE join_code='${demo.json.joinCode}'`);
    ok('the demo roll really is named with a non-ASCII character (the case this guards)', /[^\x20-\x7e]/.test(name), name);
    await api('DELETE', `/api/events/${demo.json.joinCode}`, { headers: org(demo.json.organizerCode) });
  }
});
