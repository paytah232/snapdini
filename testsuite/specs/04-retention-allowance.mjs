// Snapdini integration spec — 'Retention allowance (paid events include 30 days)'.
import { createEvent, dbq, group, ok, spec } from '../lib/harness.mjs';

await spec('04-retention-allowance', async () => {
  group('Retention allowance (paid events include 30 days)');
  {
    // A 7-day default on a memories product means a customer who never touches the control loses
    // their photos a week after the event. Paid tiers now include 30 days as a floor.
    const paidEv = await createEvent({ maxGuests: 60, durationHours: 6 });   // no retentionDays given
    ok('paid event defaults to 31-day retention (a generous month)',
       Number(dbq(`SELECT retention_days FROM events WHERE join_code='${paidEv.joinCode}'`)) === 31,
       dbq(`SELECT retention_days FROM events WHERE join_code='${paidEv.joinCode}'`));

    // The allowance is a floor: posting a smaller value must not drop a paid event below it.
    const lowEv = await createEvent({ maxGuests: 60, durationHours: 6, retentionDays: 7 });
    ok('a paid event cannot be created below the allowance',
       Number(dbq(`SELECT retention_days FROM events WHERE join_code='${lowEv.joinCode}'`)) >= 31,
       dbq(`SELECT retention_days FROM events WHERE join_code='${lowEv.joinCode}'`));

    // Free tier keeps the 7-day floor — the allowance is a paid benefit.
    const freeEv = await createEvent({ maxGuests: 10, durationHours: 6 });
    ok('free event still defaults to 7 days',
       Number(dbq(`SELECT retention_days FROM events WHERE join_code='${freeEv.joinCode}'`)) === 7,
       dbq(`SELECT retention_days FROM events WHERE join_code='${freeEv.joinCode}'`));

    // purge_at must follow retention, not lag behind it.
    const span = Number(dbq(`SELECT (purge_at - expires_at) FROM events WHERE join_code='${paidEv.joinCode}'`));
    ok('purge_at reflects the 31 days (purge lands on day 32)', span === 31 * 86_400_000, `${span}ms`);
  }
}, {});
