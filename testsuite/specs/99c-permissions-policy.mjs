// Snapdini integration spec — 'the app is not locked out of its own hardware'.
//
// The bug this guards: Permissions-Policy shipped as `microphone=()`. In that header `()` means the
// feature is disabled for EVERY origin including our own — the browser refuses it at the document
// level and never offers a prompt. Video clips recorded silently for every guest from 2026-09-07
// until it was found, and nobody could grant their way out of it, because there was nothing to
// grant. The camera was `(self)` and worked perfectly, which is what made it look like a
// microphone-permission problem on the phone rather than a header we sent.
//
// So the rule is not "these headers exist" — it is that every feature the product USES is permitted
// for our own origin. A locked door is invisible from the inside until someone tries the handle.
import { BASE, group, ok, spec } from '../lib/harness.mjs';

const directives = (header) => {
  const out = {};
  // e.g. `geolocation=(), microphone=(self), camera=(self)`
  for (const part of String(header || '').split(',')) {
    const m = /^\s*([a-z-]+)\s*=\s*(.*)$/i.exec(part);
    if (m) out[m[1].toLowerCase()] = m[2].trim();
  }
  return out;
};

await spec('99c-permissions-policy', async () => {
  group('The app is not locked out of its own hardware');
  {
    const res = await fetch(`${BASE}/`, { redirect: 'manual' });
    const header = res.headers.get('permissions-policy');
    ok('a Permissions-Policy is sent at all', !!header, String(header));

    const d = directives(header);

    // The two the camera screen cannot work without. `(self)` or `*` permit our own origin; `()`
    // forbids it — and forbids it so early that no prompt is ever shown.
    for (const feature of ['camera', 'microphone']) {
      const v = d[feature];
      ok(`${feature} is permitted for our own origin`,
        v !== undefined && v !== '()' && (v.includes('self') || v === '*'),
        `${feature}=${v ?? '(absent)'}`);
    }

    // And the point of the header survives: things we do NOT use stay shut.
    for (const feature of ['geolocation', 'payment']) {
      ok(`${feature} stays closed`, d[feature] === '()', `${feature}=${d[feature] ?? '(absent)'}`);
    }

    // Third-party frames must still be shut out of the hardware — `self`, never `*`.
    ok('the camera is ours alone, not opened to everyone', d.camera !== '*', `camera=${d.camera}`);
    ok('the microphone is ours alone, not opened to everyone', d.microphone !== '*', `microphone=${d.microphone}`);
  }
});
