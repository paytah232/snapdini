// TEMPORARY probe — proves the two observed defects before the fix. Deleted afterwards.
import { api, createEvent, join, upload, org, dbq, BASE, spec, ok, group } from './lib/harness.mjs';

function zipNames(buf) {
  const names = [];
  for (let i = 0; i + 30 <= buf.length; i++) {
    if (buf.readUInt32LE(i) !== 0x04034b50) continue;
    const nlen = buf.readUInt16LE(i + 26);
    names.push(buf.subarray(i + 30, i + 30 + nlen).toString('utf8'));
  }
  return names;
}

async function zipEntries(joinCode, organizerCode) {
  const res = await fetch(`${BASE}/api/photos/${joinCode}/download`, { headers: org(organizerCode) });
  if (res.status !== 200) throw new Error(`download ${res.status}`);
  return zipNames(Buffer.from(await res.arrayBuffer()));
}

await spec('probe', async () => {
  group('Family A — moderation count reports the request, not the result');
  const ev = await createEvent({ name: 'Probe Event', moderationEnabled: true, maxPhotos: 20 });
  const mod = await api('POST', `/api/events/${ev.joinCode}/moderate`,
    { headers: org(ev.organizerCode), body: { photoIds: ['does-not-exist-1', 'does-not-exist-2'], action: 'approve' } });
  console.log('  moderate(2 nonexistent ids) ->', JSON.stringify(mod.json));
  ok('count is 0 for two ids that do not exist', mod.json?.count === 0, `count=${mod.json?.count}`);

  const hl = await api('POST', `/api/events/${ev.joinCode}/highlights`,
    { headers: org(ev.organizerCode), body: { photoIds: ['nope-1', 'nope-2', 'nope-3'], highlight: true } });
  console.log('  highlights(3 nonexistent ids) ->', JSON.stringify(hl.json));
  ok('highlightCount is 0 for three ids that do not exist', hl.json?.highlightCount === 0, `n=${hl.json?.highlightCount}`);

  group('Family B — the ZIP names files by a non-total order');
  const ev2 = await createEvent({ name: 'Wedding', maxPhotos: 20, revealMode: 'instant', allowDownloads: true });
  const tokens = [];
  for (let k = 0; k < 2; k++) {
    const j = await join(ev2.joinCode, 'Sarah');
    tokens.push(j.json.sessionToken);
  }
  for (const t of tokens) for (let n = 0; n < 6; n++) { const u = await upload(t); if (u.status !== 200) throw new Error('upload ' + u.status + ' ' + u.text.slice(0,120)); }
  // A real tie group: same participant NAME, same taken_at. Nothing in (name, takenAt) separates
  // these 12 rows, so the ORDER BY the endpoint ships has 12! permitted answers.
  dbq(`UPDATE photos SET taken_at = 1750000000000 WHERE event_id='${ev2.id}'`);
  const pids = dbq(`SELECT id FROM participants WHERE event_id='${ev2.id}' ORDER BY id`).split('\n');
  console.log('  two participants, same name:', pids.join(' '));

  const a = await zipEntries(ev2.joinCode, ev2.organizerCode);
  // Touch a column that is NOT in the ORDER BY. Nothing about the ordering data changed.
  dbq(`UPDATE photos SET view_count = view_count + 1 WHERE event_id='${ev2.id}' AND participant_id='${pids[0]}'`);
  const b = await zipEntries(ev2.joinCode, ev2.organizerCode);
  console.log('  download A:', JSON.stringify(a));
  console.log('  download B:', JSON.stringify(b));
  ok('two downloads of one event name the files the same way', JSON.stringify(a) === JSON.stringify(b));
  // Each guest's photos should be one contiguous, 1..n block — that is what "group by person, in
  // their capture order" claims and what the total order delivers.
  const contiguous = (names) => {
    const seen = [];
    for (const n of names) { const m = /- (\d+)\./.exec(n); seen.push(Number(m[1])); }
    return JSON.stringify(seen) === JSON.stringify([1,2,3,4,5,6,1,2,3,4,5,6]);
  };
  ok('each guest is one contiguous 1..6 block', contiguous(a), JSON.stringify(a.map((n) => /- (\d+)\./.exec(n)[1])));
}, { bootstrap: 'silent' });
