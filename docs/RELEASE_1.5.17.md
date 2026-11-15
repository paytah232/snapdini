# Snapdini 1.5.17 — security and dependency updates

This is a maintenance release. Nothing changes for guests, hosts or events.

- Node.js 22.23.5 in the app and web images. This is a Node security release (2026-11-11); its
  HTTP parser fix applies to Snapdini, while most of its other fixes are for HTTP/2 and TLS, which
  the Node servers do not use behind the reverse proxy.
- SvelteKit 2.70.4 and `@sveltejs/adapter-node` 5.5.8, which fix two advisories that could crash
  the web server (GHSA-rqw3-x7hx-mm3p, GHSA-mw6w-2fmv-pvw3).
- The Stripe library moves to 23.1 (API version `2026-09-30.endive`). Snapdini did not use any of
  the removed parameters, and webhook signature checking is unchanged.
- All other app and web dependencies are updated within their current major versions, and the
  test-only jsdom moves to 31.

The SvelteKit 3 upgrade is not part of this release; it ships with 1.6.0. The two low-severity
SvelteKit advisories that only version 3 fixes do not affect Snapdini: it uses no enhanced forms
and no prerendered pages.

No database migration or configuration change is introduced.

## Validation

- Backend typecheck and unit suite (1,364 tests); frontend typecheck (0 errors) and unit suite
  (1,621 tests); `npm audit` leaves only advisories assessed as unreachable.
- Dev deployment on Node 22.23.5: public pages, site admin, the standby page and the guest flow.
- Stripe test mode through the dev deployment: promo codes listed, created and switched off; a guest
  top-up checkout session created; a correctly signed webhook accepted and a wrongly signed one
  rejected.
- The production app image builds with Node 22.23.5 and Stripe 23.1.0.

## Upgrade

Use the normal upgrade procedure and version `1.5.17`. Replace both app and web images, and
refresh any separate guest-settings publisher and warm standby app images as for 1.5.16.
