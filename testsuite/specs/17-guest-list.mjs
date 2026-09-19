// Snapdini integration spec — 'The guest list: an address on every row, and an order that holds still'.
//
// event_guests exists for ONE job: let a host send a lot of people one join link. Two rules follow
// from that, and both changed in 1.5.0 late enough that the older comments in the tree still
// describe the world before them:
//
//  • AN EMAIL ADDRESS IS REQUIRED (0054_guest_email_required.sql). A row with no address is a row
//    no send can ever reach, so the list refuses it — on create AND on edit — and says what to do
//    with that guest instead ("print a card"). A message that just said "email is required" leaves
//    a host hunting for the asterisk they missed, so the WORDS are asserted here, not just the 400.
//
//  • ONE ADDRESS PER LIST IS THE DATABASE'S RULE, NOT THE WRITER'S (0055). The index used to be
//    keyed on the raw column, on the stated grounds that the writer lower-cases on the way in. It
//    does — and a constraint that only holds while every future writer remembers a toLowerCase()
//    is a convention with an index standing next to it. The group below goes ROUND the writer with
//    a straight INSERT, because that is the only way to test a second line of defence.
//
//  • THE ORDER IS ALPHABETICAL AND STABLE (lower(name), lower(email), id). It used to be
//    `created_at`, and a batch import writes its whole batch with ONE timestamp — ORDER BY over
//    ties has no defined order in Postgres, and an UPDATE writes a new tuple a heap scan returns
//    last. So a host edited a guest's note and watched them drop to the bottom of the list.
//    Nothing was reordered; there was never an order. The fixture below builds that exact case on
//    purpose: the batch goes in through the import endpoint so all three rows share one
//    created_at, and the insert order is deliberately NOT the alphabetical order.
//
// Uses @example.com throughout (and a per-run unique prefix). Nothing here sends mail.
import { execFileSync } from 'node:child_process';
import { api, createEvent, DB, dbq, group, ok, org, spec, UNIQ } from '../lib/harness.mjs';

/** The exact words. The message names the FIX rather than the rule, which is the whole point of it. */
const NEEDS_EMAIL = 'Add an email address — that is how the join link is sent. Print a card for anyone without one.';

const addr = (tag) => `${tag}_${UNIQ}@example.com`;

const list   = (ev)            => api('GET',    `/api/events/${ev.joinCode}/guests`,        { headers: org(ev.organizerCode) });
const add    = (ev, body)      => api('POST',   `/api/events/${ev.joinCode}/guests`,        { body, headers: org(ev.organizerCode) });
const patch  = (ev, id, body)  => api('PATCH',  `/api/events/${ev.joinCode}/guests/${id}`,  { body, headers: org(ev.organizerCode) });
const remove = (ev, id)        => api('DELETE', `/api/events/${ev.joinCode}/guests/${id}`,  { headers: org(ev.organizerCode) });
const importCsv = (ev, text, mapping) =>
  api('POST', `/api/events/${ev.joinCode}/guests/import`, { body: { text, mapping }, headers: org(ev.organizerCode) });

/** What the host sees, as one comparable string per row. `·` stands in for a guest with no name so
 *  that "the nameless sort last" is visible in the failure message rather than inferred from it. */
const shape = (payload) => (payload.guests || []).map((g) => `${g.name || '·'}|${g.email}`);
const countGuests = (ev) => Number(dbq(`SELECT count(*) FROM event_guests WHERE event_id='${ev.id}'`));
const guestIndexDef = () =>
  dbq(`SELECT COALESCE(indexdef,'missing') FROM pg_indexes WHERE indexname='idx_event_guests_event_email'`);
/** Run a statement that is SUPPOSED to be refused, and return what refused it (or '<accepted>').
 *  Deliberately not through the API: a constraint is only a constraint if it holds against a writer
 *  that never heard of cleanGuest().
 *
 *  Its own execFileSync rather than dbq() only so that stderr is CAPTURED — dbq lets psql's stderr
 *  through to the parent, and a refusal this spec asked for would print like a fault in a run that
 *  is entirely green. */
const refusal = (sql) => {
  try {
    execFileSync('docker', ['exec', DB, 'psql', '-U', 'snapdini', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', sql],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return '<accepted>';
  } catch (e) { return String(e.stderr || e.message || e).replace(/\s+/g, ' ').trim(); }
};

await spec('17-guest-list', async () => {
  group('An email address is required — and the refusal says what to do instead');
  const ev = await createEvent();
  {
    const noEmail = await add(ev, { name: 'Dan’s partner' });
    ok('a guest with no email is refused', noEmail.status === 400, `status ${noEmail.status}`);
    ok('and the refusal names the fix, not the rule', noEmail.json?.error === NEEDS_EMAIL,
      JSON.stringify(noEmail.json).slice(0, 160));

    const blank = await add(ev, { name: 'Blank', email: '   ' });
    ok('whitespace is not an address either', blank.status === 400 && blank.json?.error === NEEDS_EMAIL,
      `status ${blank.status} ${JSON.stringify(blank.json).slice(0, 120)}`);

    const junk = await add(ev, { name: 'Typo', email: 'not-an-email' });
    ok('a malformed address is refused with its OWN reason', junk.status === 400
      && junk.json?.error === 'That does not look like an email address',
      `status ${junk.status} ${JSON.stringify(junk.json).slice(0, 120)}`);

    ok('and none of those three put a row on the list', countGuests(ev) === 0, `${countGuests(ev)} rows`);

    // The database keeps the same rule, so a writer that skipped cleanGuest could not slip one past.
    ok('the column itself is NOT NULL (0054)',
      dbq(`SELECT is_nullable FROM information_schema.columns WHERE table_name='event_guests' AND column_name='email'`) === 'NO');
  }

  group('A name is optional; an address is not');
  let nan, pop;
  {
    const only = await add(ev, { email: addr('emailonly') });
    ok('a guest can be added with an address and nothing else', only.status === 200, `status ${only.status}`);
    ok('and is stored with no name rather than an empty one',
      dbq(`SELECT coalesce(name,'<NULL>') FROM event_guests WHERE email='${addr('emailonly')}'`) === '<NULL>');

    const r = await add(ev, { name: 'Nan', email: `NAN_${UNIQ}@Example.COM`, notes: 'Table 4' });
    ok('an address is stored lower-cased however it was typed',
      r.status === 200 && dbq(`SELECT count(*) FROM event_guests WHERE event_id='${ev.id}' AND email='${addr('nan')}'`) === '1',
      `status ${r.status}`);
    nan = (r.json.guests || []).find((g) => g.email === addr('nan'));

    const dupe = await add(ev, { name: 'Nan again', email: `nan_${UNIQ}@EXAMPLE.com` });
    ok('the same address in a different case is a 409, not a second row', dupe.status === 409, `status ${dupe.status}`);
    ok('and it says which list it is already on', dupe.json?.error === 'That email is already on this guest list',
      JSON.stringify(dupe.json).slice(0, 120));
    ok('and there is still exactly one of her',
      dbq(`SELECT count(*) FROM event_guests WHERE event_id='${ev.id}' AND email='${addr('nan')}'`) === '1');

    const p = await add(ev, { name: 'Pop', email: addr('pop') });
    pop = (p.json.guests || []).find((g) => g.email === addr('pop'));
  }

  group('An edit may not take a guest’s address away');
  {
    const cleared = await patch(ev, nan.id, { name: 'Nan', email: '' });
    ok('clearing an existing guest’s address is refused', cleared.status === 400, `status ${cleared.status}`);
    ok('with the same words as creating one without', cleared.json?.error === NEEDS_EMAIL,
      JSON.stringify(cleared.json).slice(0, 160));
    ok('and her address is untouched',
      dbq(`SELECT email FROM event_guests WHERE id='${nan.id}'`) === addr('nan'));

    const missing = await patch(ev, nan.id, { name: 'Nan' });
    ok('an edit that simply omits the address is refused too', missing.status === 400 && missing.json?.error === NEEDS_EMAIL,
      `status ${missing.status} ${JSON.stringify(missing.json).slice(0, 120)}`);

    const taken = await patch(ev, nan.id, { name: 'Nan', email: addr('pop') });
    ok('taking another guest’s address is a 409, not a 500', taken.status === 409, `status ${taken.status}`);
    ok('and says whose it is', taken.json?.error === 'Another guest on this list already has that email',
      JSON.stringify(taken.json).slice(0, 120));

    const moved = await patch(ev, nan.id, { name: 'Nan', email: `NAN2_${UNIQ}@example.com`, notes: 'Table 4' });
    ok('a real change of address succeeds', moved.status === 200, `status ${moved.status}`);
    ok('and is stored lower-cased', dbq(`SELECT email FROM event_guests WHERE id='${nan.id}'`) === addr('nan2'));
  }

  group('One address per list is the DATABASE’s rule, not the writer’s');
  {
    // 0047 keyed this index on (event_id, email) and said why: the writer stores an address already
    // lower-cased, so byte equality was enough. 0055 overrides that, and this group is the reason.
    // 0031 (participants) and 0052 (share_sends) had already both gone the other way.
    ok('the index case-folds and trims, the way 0052 does for the send ledger (0055)',
      /lower\(btrim\(email\)\)/.test(guestIndexDef()), guestIndexDef());

    const idx = await createEvent();
    await add(idx, { name: 'Mum', email: addr('mum') });

    // A plain INSERT: no route, no cleanGuest, no normaliseAddress. Under the byte-exact index this
    // landed as a SECOND row for one inbox on one event — which is exactly the duplicate the index
    // is there to refuse, arriving through the door the index was trusting somebody else to shut.
    const cased = refusal(`INSERT INTO event_guests (id, event_id, name, email, created_at, updated_at)
      VALUES ('bypass1_${UNIQ}', '${idx.id}', 'Mum (bypass)', 'MUM_${UNIQ}@Example.COM', 1, 1)`);
    ok('a writer that skips the toLowerCase() is refused by the index itself',
      /duplicate key value violates unique constraint "idx_event_guests_event_email"/.test(cased), cased);

    // btrim, not just lower — ' mum@x.com' is the same inbox, and a cell pasted out of a
    // spreadsheet is exactly where the leading space comes from.
    const spaced = refusal(`INSERT INTO event_guests (id, event_id, name, email, created_at, updated_at)
      VALUES ('bypass2_${UNIQ}', '${idx.id}', 'Mum (spaced)', '  ${addr('mum')} ', 1, 1)`);
    ok('and so is one with a stray space around it',
      /duplicate key value violates unique constraint "idx_event_guests_event_email"/.test(spaced), spaced);

    ok('so there is still exactly one of her',
      dbq(`SELECT count(*) FROM event_guests WHERE event_id='${idx.id}'`) === '1',
      dbq(`SELECT count(*) FROM event_guests WHERE event_id='${idx.id}'`));

    // The constraint is per EVENT, not global: the same person can be on two hosts' lists.
    const elsewhere = await createEvent();
    const shared = await add(elsewhere, { name: 'Mum', email: addr('mum') });
    ok('while the same address on ANOTHER event is not a duplicate at all', shared.status === 200,
      `status ${shared.status} ${JSON.stringify(shared.json?.error || '').slice(0, 120)}`);
  }

  group('An organizer code reaches its OWN event’s list and no other');
  {
    // Same owner, two events — so the session cookie authorises both and the only thing standing
    // between them is the route's `AND event_id = …`. That is the guard being tested: an id from
    // another list must be invisible here, not merely unauthorised.
    const other = await createEvent();
    const theirs = await add(other, { name: 'Theirs', email: addr('theirs') });
    const theirId = (theirs.json.guests || [])[0].id;

    const edit = await patch(ev, theirId, { name: 'Hijacked', email: addr('hijack') });
    ok('editing another event’s guest through this event is a 404', edit.status === 404, `status ${edit.status}`);
    ok('and says the guest is not on THIS list', edit.json?.error === 'That guest is no longer on the list',
      JSON.stringify(edit.json).slice(0, 120));
    ok('and left them exactly as they were',
      dbq(`SELECT name FROM event_guests WHERE id='${theirId}'`) === 'Theirs');

    // DELETE answers 200 whatever it matched — so the ONLY evidence the scope held is the row.
    const del = await remove(ev, theirId);
    ok('deleting another event’s guest through this event answers 200…', del.status === 200, `status ${del.status}`);
    ok('…and deletes nothing', dbq(`SELECT count(*) FROM event_guests WHERE id='${theirId}'`) === '1');

    const own = await remove(other, theirId);
    ok('while the owning event’s own delete removes them',
      own.status === 200 && dbq(`SELECT count(*) FROM event_guests WHERE id='${theirId}'`) === '0');
  }

  group('Alphabetical, and a batch import cannot unstick it');
  {
    const ord = await createEvent();
    // Through the IMPORT endpoint on purpose: that is the writer that gives a whole batch one
    // `created_at`, which is the exact condition the old `ORDER BY created_at` fell apart under.
    // Insertion order is deliberately not alphabetical order.
    const imp = await importCsv(ord, [
      'Name,Email',
      `Zara,${addr('z')}`,
      `alice,${addr('a1')}`,
      `Alice,${addr('a2')}`,
    ].join('\n'));
    ok('the batch imported', imp.status === 200 && imp.json?.imported === 3,
      `status ${imp.status} ${JSON.stringify(imp.json?.counts || imp.json?.error || '').slice(0, 120)}`);
    ok('and the whole batch shares ONE created_at — the tie the order has to survive',
      dbq(`SELECT count(DISTINCT created_at) FROM event_guests WHERE event_id='${ord.id}'`) === '1');

    // Added after, so it has its own created_at: under the old ordering it would always be last
    // for the wrong reason. It is last here because it has no name.
    await add(ord, { email: addr('zz') });

    const expected = [`alice|${addr('a1')}`, `Alice|${addr('a2')}`, `Zara|${addr('z')}`, `·|${addr('zz')}`];
    const first = await list(ord);
    ok('the list is alphabetical by name, then by address, with the nameless last',
      JSON.stringify(shape(first.json)) === JSON.stringify(expected), JSON.stringify(shape(first.json)));

    const before = (first.json.guests || []).map((g) => g.id);
    const zara = (first.json.guests || []).find((g) => g.name === 'Zara');
    const edited = await patch(ord, zara.id, { name: 'Zara', email: addr('z'), notes: 'Coming after 8' });
    ok('editing a guest succeeds', edited.status === 200, `status ${edited.status}`);
    // THE REGRESSION. An UPDATE rewrites the tuple; with nothing but a tied created_at to order by,
    // the edited row came back last and the host watched Zara fall off the bottom of their list.
    ok('and editing a guest does NOT move them',
      JSON.stringify((edited.json.guests || []).map((g) => g.id)) === JSON.stringify(before),
      JSON.stringify(shape(edited.json)));

    const again = await list(ord);
    ok('and a fresh read agrees — the order is a property of the query, not of the response',
      JSON.stringify(shape(again.json)) === JSON.stringify(expected), JSON.stringify(shape(again.json)));

    // …but a change to the thing the order is ON must move them. Otherwise "stable" would just mean
    // "frozen", and a renamed guest would sit under their old letter forever.
    const renamed = await patch(ord, (again.json.guests || []).find((g) => g.email === addr('a1')).id,
      { name: 'Zoe', email: addr('a1') });
    ok('renaming a guest DOES move them, to where their new name belongs',
      JSON.stringify(shape(renamed.json))
        === JSON.stringify([`Alice|${addr('a2')}`, `Zara|${addr('z')}`, `Zoe|${addr('a1')}`, `·|${addr('zz')}`]),
      JSON.stringify(shape(renamed.json)));
  }

  void pop;
});
