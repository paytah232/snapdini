// Snapdini integration spec — the demo ships a trick list.
import { api, group, ok, spec, createEvent, org, orphanJoinCodes } from '../lib/harness.mjs';

// ── The demo ────────────────────────────────────────────────────────────────
// The demo is how most people meet the product, so the trick list has to be IN it — a feature nobody
// sees until they have paid is a feature that does not sell itself.
await spec('98c-mission-demo', async () => {
  group('Photo missions: the demo ships a trick list');
  {
    const r = await api('POST', '/api/events/demo');
    ok('a demo roll is created', r.status === 200 && !!r.json?.joinCode, `status ${r.status}`);
    if (r.json?.joinCode) {
      orphanJoinCodes.push(r.json.joinCode);
      const me = await api('GET', `/api/participants/me?sessionToken=${r.json.sessionToken}`);
      const list = me.json?.challenges || me.json?.missions || [];
      ok('the demo guest is handed a trick list', Array.isArray(list) && list.length > 0, `${list.length} on the card`);
      ok('with nothing ticked off yet', (me.json?.challengesDone || []).length === 0);
    }
  }
});
