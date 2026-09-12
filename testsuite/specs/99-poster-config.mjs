// Snapdini integration spec — 'The poster design cannot take the event page down'.
//
// The bug this guards: the saved poster design was stored as JSON.stringify(config).slice(0, 4000).
// Truncating JSON does not produce smaller JSON, it produces a syntax error — and the organizer
// payload parsed that column with a bare JSON.parse on every load. So one design past the ceiling
// would have 500'd GET /:joinCode/admin for good, locking a host out of their own event: no reveal,
// no settings, no delete. The design is a nice-to-have; the page it hangs off is not.
//
// Two halves, and both matter. Saving refuses what it cannot store, so nobody silently loses work.
// Reading survives a row that is already bad, because prod may hold one and the host must still be
// able to get in and save over it.
import { api, createEvent, dbq, group, ok, org, spec } from '../lib/harness.mjs';

await spec('99-poster-config', async () => {
  group('The poster design cannot take the event page down');
  {
    const ev = await createEvent();
    const h = org(ev.organizerCode);

    // A design a host would really make.
    const design = { title: 'Ruby & Sam', message: 'Scan me', cardsPerSheet: 2, cardRound: false,
                     decor: 'birds', colors: { title: '#8a6d3b', body: '#222' } };
    const save = await api('PUT', `/api/events/${ev.joinCode}/poster`, { body: { config: design }, headers: h });
    ok('a design saves', save.status === 200, `status ${save.status}`);

    const back = await api('GET', `/api/events/${ev.joinCode}/admin`, { headers: h });
    ok('and comes back intact', back.json?.posterConfig?.title === 'Ruby & Sam'
      && back.json?.posterConfig?.cardsPerSheet === 2 && back.json?.posterConfig?.cardRound === false,
      JSON.stringify(back.json?.posterConfig || null).slice(0, 100));

    // Far past any real design — a maxed-out one is about 2kB, because every text field in the
    // designer is maxlength-capped. Kept under express.json()'s 100kB so it reaches OUR check and
    // gets our message, rather than an opaque body-parser rejection.
    const huge = { ...design, junk: 'x'.repeat(80_000) };
    const big = await api('PUT', `/api/events/${ev.joinCode}/poster`, { body: { config: huge }, headers: h });
    ok('an impossible design is refused, not trimmed', big.status === 413, `status ${big.status}`);

    const after = await api('GET', `/api/events/${ev.joinCode}/admin`, { headers: h });
    ok('the refusal leaves the last good design alone', after.json?.posterConfig?.title === 'Ruby & Sam',
      JSON.stringify(after.json?.posterConfig || null).slice(0, 80));

    const stored = dbq(`SELECT length(poster_config) FROM events WHERE id='${ev.id}'`);
    ok('nothing oversized reached the column', Number(stored) < 2000, `${stored} chars`);

    // Now the row prod might already hold: valid JSON chopped in half.
    dbq(`UPDATE events SET poster_config='{"title":"Ruby & S' WHERE id='${ev.id}'`);
    const broken = await api('GET', `/api/events/${ev.joinCode}/admin`, { headers: h });
    ok('a corrupted row does not lock the host out', broken.status === 200, `status ${broken.status}`);
    ok('it reads as no design rather than throwing', broken.json?.posterConfig === null,
      JSON.stringify(broken.json?.posterConfig ?? 'missing').slice(0, 60));

    // And the host can recover by simply saving again.
    const redo = await api('PUT', `/api/events/${ev.joinCode}/poster`, { body: { config: design }, headers: h });
    const fixed = await api('GET', `/api/events/${ev.joinCode}/admin`, { headers: h });
    ok('saving again repairs it', redo.status === 200 && fixed.json?.posterConfig?.title === 'Ruby & Sam',
      `put ${redo.status}`);

    // Clearing is still allowed — null is not "too big".
    const clear = await api('PUT', `/api/events/${ev.joinCode}/poster`, { body: { config: null }, headers: h });
    const gone = await api('GET', `/api/events/${ev.joinCode}/admin`, { headers: h });
    ok('and a design can be cleared', clear.status === 200 && gone.json?.posterConfig === null, `put ${clear.status}`);
  }
});
