// Snapdini integration spec — 'Importing a spreadsheet: reported, never silently dropped'.
//
// The host pastes the list they already have. Everything that can go wrong with that file is a
// thing the host has to be TOLD about, because the failure mode of getting it wrong is invisible:
// "160 imported" and nothing else is how someone finds out at the party that forty of their guests
// were never invited.
//
// What is pinned here, all of it decided in 1.5.0:
//
//  • PHONE IS GONE AS A FIELD (0053) AND STILL RECOGNISED AS A COLUMN. An ordinary `Name,Email,
//    Phone` sheet must import cleanly — the numbers identified, resolved to 'ignore', and reaching
//    no stored field. Never mistaken for a name; never a fatal.
//  • THE PREVIEW REPORTS. Counts are {add, skip, duplicate, invalid, noEmail}, and `noEmail` is
//    counted APART from `invalid` because the two need different things done about them: a typo is
//    fixed in the file, a missing address means that person gets a printed card. Skipped rows come
//    back with the guest's name and a per-row reason, not hidden.
//  • NO EMAIL COLUMN IS ONE LOUD FATAL, not two hundred identical grey rows.
//  • HEADERLESS PASTES ARE INFERRED from a 20-row sample of the data, and a consumed header row is
//    reported (`headerless`, and line numbers that match the host's own file).
//  • DEDUPE IS THE ADDRESS ALONE, case-folded. `identityKey()` (name + note) was removed with 0054,
//    so two people genuinely called "John Smith" both import, and re-pasting the same file adds
//    nobody a second time.
//
// Preview and commit run the SAME functions over the SAME text, which is what makes the preview a
// promise rather than an illustration — so every group below checks the commit agrees with it.
//
// Uses @example.com throughout (and a per-run unique prefix). Nothing here sends mail.
import { api, createEvent, dbq, group, ok, org, spec, UNIQ } from '../lib/harness.mjs';

/** Said ONCE, above a mapper the host can fix it with. */
const NO_EMAIL_COLUMN = 'Map a column to Email — that is how the join link is sent, so every guest needs one.';

const addr = (tag) => `${tag}_${UNIQ}@example.com`;

const preview = (ev, text, mapping) =>
  api('POST', `/api/events/${ev.joinCode}/guests/import/preview`, { body: { text, mapping }, headers: org(ev.organizerCode) });
const commit = (ev, text, mapping) =>
  api('POST', `/api/events/${ev.joinCode}/guests/import`, { body: { text, mapping }, headers: org(ev.organizerCode) });
const add = (ev, body) => api('POST', `/api/events/${ev.joinCode}/guests`, { body, headers: org(ev.organizerCode) });

const rowAt = (p, line) => (p.rows || []).find((r) => r.line === line);
const why = (p, line) => ((rowAt(p, line) || {}).problems || []).join(' | ');
const stored = (ev) => Number(dbq(`SELECT count(*) FROM event_guests WHERE event_id='${ev.id}'`));

await spec('18-guest-import', async () => {
  group('An ordinary Name,Email,Phone sheet imports cleanly — and the digits are stored nowhere');
  const sheet = [
    'Name,Email,Phone',
    `Nan,${addr('nan')},0400 111 222`,
    `Pop,${addr('pop')},+61 400 333 444`,
  ].join('\n');
  const ev = await createEvent();
  {
    const p = (await preview(ev, sheet)).json;
    ok('the phone column is identified and resolved to "don’t import"',
      JSON.stringify(p?.mapping) === JSON.stringify(['name', 'email', 'ignore']), JSON.stringify(p?.mapping));
    ok('and a phone column is not a fatal', p?.fatal === null, String(p?.fatal));
    // NOTE on `skip` throughout this spec: the consumed header LINE is now a reported row too, so
    // it adds one to `skip` (and one line to `rows`). That is the whole point of the change — a
    // line the host can see in their own file always has a row here, which is what stopped a first
    // guest with a typo'd address vanishing with no count mentioning her. It is deliberately not
    // counted as `invalid`, `noEmail` or `duplicate`: it is none of those.
    ok('both guests are importable',
      JSON.stringify(p?.counts) === JSON.stringify({ add: 2, skip: 1, duplicate: 0, invalid: 0, noEmail: 0 }),
      JSON.stringify(p?.counts));
    ok('the header row was consumed and is reported as one', p?.headerless === false, String(p?.headerless));
    ok('so the line numbers are the ones the host sees when they open the file',
      JSON.stringify((p?.rows || []).map((r) => r.line)) === JSON.stringify([1, 2, 3]),
      JSON.stringify((p?.rows || []).map((r) => r.line)));

    const c = await commit(ev, sheet);
    ok('the commit agrees with the preview', c.status === 200 && c.json?.imported === 2 && c.json?.skipped === 1,
      `status ${c.status} ${JSON.stringify(c.json?.imported)}/${JSON.stringify(c.json?.skipped)}`);
    // Data minimisation is the point of 0053: the numbers must not have been quietly parked in a
    // name or a note. Asserted as the WHOLE stored row rather than as a LIKE, so there is nowhere
    // for the digits to have gone that this would not notice.
    ok('and the stored rows are a name and an address and nothing else — the digits went nowhere',
      dbq(`SELECT string_agg(coalesce(name,'<NULL>') || '/' || email || '/' || coalesce(notes,'<NULL>'), ' ; ' ORDER BY name)
           FROM event_guests WHERE event_id='${ev.id}'`)
      === `Nan/${addr('nan')}/<NULL> ; Pop/${addr('pop')}/<NULL>`,
      dbq(`SELECT string_agg(coalesce(name,'<NULL>') || '/' || email || '/' || coalesce(notes,'<NULL>'), ' ; ' ORDER BY name)
           FROM event_guests WHERE event_id='${ev.id}'`));
    ok('because there is no phone column left to put it in (0053)',
      dbq(`SELECT count(*) FROM information_schema.columns WHERE table_name='event_guests' AND column_name='phone'`) === '0');
  }

  group('Re-pasting the same file adds nobody a second time');
  {
    const p = (await preview(ev, sheet)).json;
    ok('every row is recognised as already on the list',
      JSON.stringify(p?.counts) === JSON.stringify({ add: 0, skip: 3, duplicate: 2, invalid: 0, noEmail: 0 }),
      JSON.stringify(p?.counts));
    ok('and each greyed row says so in the host’s words', /Already on the guest list/.test(why(p, 2)), why(p, 2));
    const c = await commit(ev, sheet);
    ok('the commit imports nobody', c.json?.imported === 0 && c.json?.skipped === 3, JSON.stringify(c.json?.imported));
    ok('and the list is still two people', stored(ev) === 2, `${stored(ev)}`);
  }

  group('Dedupe is the ADDRESS ALONE, case-folded — identityKey() is gone');
  {
    const d = await createEvent();
    const p = (await preview(d, [
      'Name,Email',
      `Mum,MUM_${UNIQ}@Example.COM`,
      `Mum (mobile),mum_${UNIQ}@example.com`,
      `John Smith,${addr('js1')}`,
      `John Smith,${addr('js2')}`,
    ].join('\n'))).json;
    ok('one address in two casings is ONE guest',
      p?.counts?.add === 3 && p?.counts?.duplicate === 1, JSON.stringify(p?.counts));
    ok('and the second casing is named as the duplicate, not the first',
      /Appears more than once in this file/.test(why(p, 3)), why(p, 3));
    // The old name+note fallback would have collapsed these two. Two guests really can be called
    // the same thing, and the address is the only thing that says they are one person.
    ok('two guests with the SAME NAME and different addresses both import',
      !why(p, 4) && !why(p, 5), `${why(p, 4)} / ${why(p, 5)}`);

    const c = await commit(d, [
      'Name,Email',
      `Mum,MUM_${UNIQ}@Example.COM`,
      `Mum (mobile),mum_${UNIQ}@example.com`,
      `John Smith,${addr('js1')}`,
      `John Smith,${addr('js2')}`,
    ].join('\n'));
    ok('and the commit writes exactly three rows', c.json?.imported === 3 && stored(d) === 3,
      `${c.json?.imported} imported, ${stored(d)} stored`);
    ok('with the address stored lower-cased, which is what the unique index compares',
      dbq(`SELECT count(*) FROM event_guests WHERE event_id='${d.id}' AND email='mum_${UNIQ}@example.com'`) === '1');
  }

  group('Skipped rows are reported — with the reason, and with the guest’s name');
  {
    const s = await createEvent();
    await add(s, { name: 'Already There', email: addr('dup') });
    const messy = [
      'Name,Email,Notes,Phone',
      `Good Guest,${addr('good')},table 4,`,
      `Dup Existing,${addr('dup')},,`,
      `In File A,${addr('twice')},,`,
      `In File B,${addr('twice')},,`,
      'Typo Guy,not-an-email,,',
      'No Address Nan,,,',
      ',,,0400 555 666',
    ].join('\n');

    const p = (await preview(s, messy)).json;
    ok('every kind of bad row is COUNTED rather than dropped',
      JSON.stringify(p?.counts) === JSON.stringify({ add: 2, skip: 6, duplicate: 2, invalid: 1, noEmail: 1 }),
      JSON.stringify(p?.counts));
    // The one that a lumped "skipped" number would hide. A host whose sheet is half address-less
    // needs THAT number: it is the only skip reason they can act on.
    ok('and "no address" is counted apart from "bad address"',
      p?.counts?.noEmail === 1 && p?.counts?.invalid === 1, JSON.stringify(p?.counts));
    ok('nothing about a messy file is fatal', p?.fatal === null, String(p?.fatal));
    ok('every row in the file comes back, skipped ones included', p?.total === 8, String(p?.total));

    ok('a duplicate of someone already on the list says so',
      /Already on the guest list/.test(why(p, 3)), why(p, 3));
    ok('a duplicate within the file says something different',
      /Appears more than once in this file/.test(why(p, 5)), why(p, 5));
    ok('a malformed address is quoted back verbatim so the typo can be found',
      /"not-an-email" is not a valid email address/.test(why(p, 6)), why(p, 6));
    ok('a row with no address at all says exactly that', /No email address/.test(why(p, 7)), why(p, 7));
    ok('and a row with nothing in any MAPPED column says that instead',
      /Nothing in the mapped columns/.test(why(p, 8)), why(p, 8));

    // Without the name the grey row is unfindable: the host cannot match "line 7" to a person in a
    // spreadsheet they scrolled past ten minutes ago.
    ok('each skipped row still carries the guest’s name, so the host knows WHO',
      rowAt(p, 3)?.guest?.name === 'Dup Existing'
      && rowAt(p, 6)?.guest?.name === 'Typo Guy'
      && rowAt(p, 7)?.guest?.name === 'No Address Nan',
      JSON.stringify([rowAt(p, 3)?.guest?.name, rowAt(p, 6)?.guest?.name, rowAt(p, 7)?.guest?.name]));
    ok('and the row marks itself as a skip, not an add',
      (p?.rows || []).filter((r) => r.action === 'add').length === 2,
      JSON.stringify((p?.rows || []).map((r) => r.action)));

    const c = await commit(s, messy);
    ok('the commit imports only the two clean rows', c.json?.imported === 2 && c.json?.skipped === 6,
      `${c.json?.imported}/${c.json?.skipped}`);
    ok('so the list holds the pre-existing guest plus two', stored(s) === 3, `${stored(s)}`);
    ok('and the malformed address was never written anywhere',
      dbq(`SELECT count(*) FROM event_guests WHERE event_id='${s.id}' AND email LIKE '%not-an-email%'`) === '0');
  }

  group('A mapping with no Email column is ONE loud fatal, not a page of grey rows');
  {
    const f = await createEvent();
    const p = (await preview(f, sheet, ['name', 'notes', 'ignore'])).json;
    ok('the preview refuses the mapping with one sentence', p?.fatal === NO_EMAIL_COLUMN, String(p?.fatal));
    ok('and renders no rows at all — the reason is the same for every one of them',
      (p?.rows || []).length === 0 && p?.total === 0, `${(p?.rows || []).length} rows`);
    ok('with every count at zero rather than a "skipped" tally that reads like bad data',
      JSON.stringify(p?.counts) === JSON.stringify({ add: 0, skip: 0, duplicate: 0, invalid: 0, noEmail: 0 }),
      JSON.stringify(p?.counts));

    const c = await commit(f, sheet, ['name', 'notes', 'ignore']);
    ok('and the commit refuses it with the SAME sentence — not a 200 that wrote nothing',
      c.status === 400 && c.json?.error === NO_EMAIL_COLUMN, `status ${c.status} ${JSON.stringify(c.json).slice(0, 140)}`);
    ok('nothing was written', stored(f) === 0, `${stored(f)}`);
  }

  group('A paste with no header row does not lose its first guest');
  {
    const h = await createEvent();
    const headerless = [
      `Ann Headerless,${addr('d1')}`,
      `Bo Headerless,${addr('d2')}`,
      `Cal Headerless,${addr('d3')}`,
    ].join('\n');
    const p = (await preview(h, headerless)).json;
    ok('row 1 is recognised as DATA, because it holds an address', p?.headerless === true, String(p?.headerless));
    ok('so the columns are named for the host rather than out of their data',
      JSON.stringify(p?.headers) === JSON.stringify(['Column 1', 'Column 2']), JSON.stringify(p?.headers));
    ok('and are worked out from what is IN them',
      JSON.stringify(p?.mapping) === JSON.stringify(['name', 'email']), JSON.stringify(p?.mapping));
    ok('all three guests survive — the first is not eaten as a header', p?.counts?.add === 3, JSON.stringify(p?.counts));
    ok('and the line numbers start at 1, because there is no header row to count',
      JSON.stringify((p?.rows || []).map((r) => r.line)) === JSON.stringify([1, 2, 3]),
      JSON.stringify((p?.rows || []).map((r) => r.line)));

    const c = await commit(h, headerless);
    ok('and the first row is on the list afterwards',
      c.json?.imported === 3
      && dbq(`SELECT count(*) FROM event_guests WHERE event_id='${h.id}' AND email='${addr('d1')}'`) === '1',
      `${c.json?.imported}`);
  }

  group('Columns are inferred from a 20-row sample of the data');
  {
    // Headers the hint list does not recognise, so only the DATA can decide. This is the same code
    // path a headerless paste takes.
    const rows = (emailFrom, emailTo) => {
      const out = ['Col A,Col B'];
      for (let i = 1; i <= 25; i++) {
        const n = String(i).padStart(2, '0');
        out.push(`g${n} Sample,${i >= emailFrom && i <= emailTo ? `s${n}_${UNIQ}@example.com` : ''}`);
      }
      return out.join('\n');
    };
    const s = await createEvent();

    const early = (await preview(s, rows(1, 20))).json;
    ok('addresses inside the sample are found and the column is mapped',
      JSON.stringify(early?.mapping) === JSON.stringify(['name', 'email']), JSON.stringify(early?.mapping));
    ok('and the rows past the sample are still read — they simply have no address',
      early?.counts?.add === 20 && early?.counts?.noEmail === 5, JSON.stringify(early?.counts));

    // The bound, stated rather than assumed. Twenty rows is a deliberate ceiling (INFER_SAMPLE in
    // csv.ts): enough that one odd row cannot decide a column, few enough that a 2000-row paste
    // costs nothing to classify. A file that hides every address below it gets the loud fatal and a
    // mapper — which is a fixable answer — rather than a silent full-table scan.
    const late = (await preview(s, rows(21, 25))).json;
    ok('a file whose first 20 rows show no address falls to the mapper, loudly',
      late?.fatal === NO_EMAIL_COLUMN, String(late?.fatal));

    // Majority, not first-row: a column of twenty addresses with one typo in it is still the
    // address column, and the typo is reported as a row rather than costing the whole mapping.
    const typo = (await preview(s, rows(1, 20).replace(`s05_${UNIQ}@example.com`, 'oops'))).json;
    ok('one bad cell does not turn the address column into something else',
      JSON.stringify(typo?.mapping) === JSON.stringify(['name', 'email']), JSON.stringify(typo?.mapping));
    ok('it is reported as one invalid row instead',
      typo?.counts?.add === 19 && typo?.counts?.invalid === 1, JSON.stringify(typo?.counts));
  }

  group('Input the parser cannot usefully read is refused in words');
  {
    const x = await createEvent();
    const empty = await preview(x, '   ');
    ok('an empty paste says what to do', empty.status === 400 && empty.json?.error === 'Paste some rows, or choose a file',
      `status ${empty.status} ${JSON.stringify(empty.json).slice(0, 120)}`);
    const xlsx = await preview(x, 'PKbinary rubbish');
    ok('a real .xlsx is named as one, with the one-click fix',
      xlsx.status === 400 && /Excel file/.test(xlsx.json?.error || ''), JSON.stringify(xlsx.json).slice(0, 140));
    ok('and neither wrote anything', stored(x) === 0, `${stored(x)}`);
  }
});
