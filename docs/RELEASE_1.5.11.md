# Snapdini 1.5.11 security patch

This patch updates Node.js to 22.23.4 and refreshes affected request parsing, upload,
image, email and PDF dependencies. Docker builds now use `npm ci` against the
committed lockfiles. No database migration or configuration change is introduced.

## Validation

- Backend and frontend typechecks and unit suites.
- Ten isolated gzip/Brotli parser regressions, including malformed data, subsequent
  request survival and inflated body size limits, verified on patched Node.
- Full dev integration suite: 1,037 checks.
- Browser smoke, signup, queued guest capture/recovery and service-worker tests.
- Guest edge/publication unit suites: 33 checks.
- Native app/web image builds for amd64 and arm64 through the release workflow.

The backend production dependency audit is clear at release preparation. Full audits
retain assessed migration-tooling and low-severity framework findings; these do not
mean every dependency is vulnerability-free. Framework major upgrades remain
separate from this security patch.

## Upgrade

Use the normal upgrade procedure and version `1.5.11`. Replace both app and web
images. Operators with a separate guest-settings publisher must refresh its app
image too. Warm standby images also need updating while retaining replica/read-only
settings. Changing only the host Node installation does not patch containers.

Deployments using independent guest hosting should run their normal guest asset
promotion hook after the new origin is healthy so it serves the matching build.

Node security release: https://nodejs.org/en/blog/vulnerability/october-2026-security-releases
