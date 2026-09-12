// Snapdini integration spec — the tick a trick card is marked off with.
import { api, group, ok, spec, createEvent, org, orphanJoinCodes } from '../lib/harness.mjs';

// ── The tick: the glyph a guest and a printed card mark off with ─────────────
// Chosen once, in the trick list editor, and read from there by the print panel. A tick that does
// not survive the round trip prints the wrong thing on every card with nothing to warn anyone.
await spec('98b-mission-tick', async () => {
  group('Photo missions: the tick a card is marked off with');
  {
    const ev = await createEvent();
    const h = org(ev.organizerCode);
    const items = [{ id: 'general-laugh', text: 'Someone laughing' }, { id: 'general-shoes', text: 'Everyone\u2019s shoes' }];

    const save = await api('PUT', `/api/events/${ev.joinCode}/challenges`,
      { body: { eventType: 'wedding', challenges: { sets: [{ key: 'a', label: 'Card A', items }] }, tick: '\u2661' }, headers: h });
    ok('a tick saves with the list', save.status === 200 && save.json?.tick === '\u2661', `${save.status} ${save.json?.tick}`);

    const admin = await api('GET', `/api/events/${ev.joinCode}/admin`, { headers: h });
    ok('and the organizer reads it back', admin.json?.challengeTick === '\u2661', String(admin.json?.challengeTick));

    // A tick pasted out of an emoji picker carries a variation selector — two code points.
    const vs = await api('PUT', `/api/events/${ev.joinCode}/challenges`,
      { body: { challenges: { sets: [{ key: 'a', label: 'Card A', items }] }, tick: '\u2714\uFE0F' }, headers: h });
    ok('a tick pasted from a picker is kept, not silently dropped', vs.json?.tick === '\u2714', String(vs.json?.tick));

    // Junk must clear it rather than print a box.
    for (const [label, bad] of [['a word', 'nope'], ['two glyphs', '\u2661\u2661'], ['empty', '   ']]) {
      const r = await api('PUT', `/api/events/${ev.joinCode}/challenges`,
        { body: { challenges: { sets: [{ key: 'a', label: 'Card A', items }] }, tick: bad }, headers: h });
      ok(`${label} is refused as a tick and stored as none`, r.status === 200 && r.json?.tick === null, String(r.json?.tick));
    }

    const after = await api('GET', `/api/events/${ev.joinCode}/admin`, { headers: h });
    ok('the list itself survives every tick change', (after.json?.challengeSets?.[0]?.items || []).length === 2);
  }
});
