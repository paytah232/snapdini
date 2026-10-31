# Snapdini 1.5.13 search listing fixes

This release improves how Snapdini's public pages appear in search results.

- Page descriptions are now short enough to show in full in Google and Bing results, instead of
  being cut off mid-sentence. The homepage title is shorter for the same reason.
- `www.snapdini.com` now permanently redirects to `snapdini.com`, so search engines treat them
  as one site. On snapdini.com this also runs at the Cloudflare edge; the app-level redirect is a
  fallback and only applies to the `www.` form of the deployment's own canonical host.
- The contact page now declares its canonical address like the other public pages.

No database migration or configuration change is introduced, and nothing changes for guests,
hosts or events.

## Validation

- Frontend typecheck (0 errors) and unit suite: 1,621 tests, including new checks for the
  redirect and for title and description lengths.
- Production build served locally: `www` redirects with path and query kept (301, or 308 for
  form posts), the apex and non-indexable hosts are never redirected.
- Dev deployment checked for the new tags, canonicals and `noindex`.

## Upgrade

Use the normal upgrade procedure and version `1.5.13`. Replace both app and web images, and
refresh any separate guest-settings publisher and warm standby app images as for 1.5.12.
