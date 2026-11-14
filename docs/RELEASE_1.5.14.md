# Snapdini 1.5.14 — failover standby panel

This release adds a failover standby panel to the site admin page, for deployments that run a
warm standby.

- Site admin now has a **Failover standby** section (`/siteadmin#standby`) that shows whether the
  standby is healthy, each check behind that answer, and the progress of the last rebuild.
- An administrator can ask for the standby to be rebuilt from production by typing `REBUILD` to
  confirm. The website only records the request: a separate host runner, outside the app, re-checks
  every safety condition itself and performs the rebuild. The button is disabled, with the reason
  shown, whenever a rebuild would not be safe — for example while the standby is serving the site
  or may have been promoted, or when the runner has not reported recently.
- Deployments without a standby runner see the section report that no status is available; nothing
  else changes.

No database migration or configuration change is introduced, and nothing changes for guests,
hosts or events.

## Validation

- Backend suite (1,361 tests, including new checks for the request rules and status parsing) and
  frontend typecheck (0 errors) and unit suite (1,621 tests).
- Dev deployment: admin login required; a request is refused without the confirmation word, while
  another rebuild is pending, and when no runner has reported; accepted when allowed. Layout
  checked at phone width, including arriving from an alert link.
- A real standby rebuild driven through the runner completed in 66 seconds with all checks passing.

## Upgrade

Use the normal upgrade procedure and version `1.5.14`. Replace both app and web images, and
refresh any separate guest-settings publisher and warm standby app images as for 1.5.13.
