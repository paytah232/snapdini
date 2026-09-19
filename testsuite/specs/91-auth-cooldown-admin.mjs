// Snapdini integration spec — 'Auth: magic-link cooldown + admin overview counts'.
//
// SERIAL (9x- prefix): compares /api/admin/overview counts against a live SELECT count(*), so a
// concurrently created event would race it.
import { UNIQ, adminLogin, api, dbq, group, ok, orphanEmails, session, spec } from '../lib/harness.mjs';

await spec('91-auth-cooldown-admin', async () => {
  const ownerCookie = session.cookie;   // the verified owner session bootstrapOwner() left us in

  group('Auth: magic-link cooldown + admin overview counts');
  {
    // magic-link creates an account for any new address AND is the "resend my sign-in link" the
    // login page offers, so it needs a per-address gap or it doubles as a mail cannon.
    // Both addresses carry UNIQ and are torn down BY NAME in the `finally`. The old version used
    // Date.now() and then swept up with `email LIKE 'other_%@example.com'` — a wildcard delete over
    // rows this spec did not create, which is the same mistake as counting rows it did not create.
    const mEmail = `cooldown_${UNIQ}@example.com`;
    const otherEmail = `other_${UNIQ}@example.com`;
    orphanEmails.push(mEmail, otherEmail);
    const first = await api('POST', '/api/auth/magic-link', { body: { email: mEmail } });
    ok('magic-link first request sends', first.status === 200, `status ${first.status}`);
    const second = await api('POST', '/api/auth/magic-link', { body: { email: mEmail } });
    ok('same address within 5 min is refused', second.status === 429, `status ${second.status}`);
    ok('refusal explains the wait', /wait \d+ more minute/.test(second.json?.error || ''), second.json?.error);
    const other = await api('POST', '/api/auth/magic-link', { body: { email: otherEmail } });
    ok('a different address is unaffected', other.status === 200, `status ${other.status}`);
    // Aging the token past the window must let it through again.
    dbq(`UPDATE email_tokens SET created_at = created_at - 600000 WHERE user_id = (SELECT id FROM users WHERE email='${mEmail}')`);
    const third = await api('POST', '/api/auth/magic-link', { body: { email: mEmail } });
    ok('allowed again once the window passes', third.status === 200, `status ${third.status}`);

    // Demos must not be counted as paid events (they carry paid=true with zero money).
    const admLogin = await adminLogin();
    if (admLogin.status === 200) {
      const ov = await api('GET', '/api/admin/overview');
      const st = ov.json?.stats || {};
      ok('overview reports demo_events separately', typeof st.demo_events === 'number', JSON.stringify(st));
      const realPaid = Number(dbq(`SELECT count(*) FROM events WHERE amount_paid_cents > 0 AND refunded_at IS NULL`));
      ok('paid_events counts only money actually taken', Number(st.paid_events) === realPaid, `${st.paid_events} vs ${realPaid}`);
      const demos = Number(dbq(`SELECT count(*) FROM events WHERE owner_user_id IS NULL`));
      ok('demo_events matches unowned events', Number(st.demo_events) === demos, `${st.demo_events} vs ${demos}`);
      session.cookie = ownerCookie;
    }
  }
}, {});
