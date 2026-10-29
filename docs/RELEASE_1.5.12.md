# Snapdini 1.5.12 security patch

This patch closes an account-takeover path in registration. Previously, registering with the
email address of an existing account that had no password (one created through a magic link or
social sign-in) attached the new password to that account. Because such accounts are already
email-verified, the person who registered could then sign in as the account owner.

Registration now refuses every existing email address and never changes the credentials of an
existing account. People with passwordless accounts keep signing in the way they always have.
No database migration or configuration change is introduced.

## Validation

- Backend and frontend typechecks (0 errors) and unit suites: 1,353 backend and 1,616 frontend tests.
- New registration-ownership regression suite (5 checks), including passwordless accounts.
- Full dev integration suite: 1,037 checks.
- Browser signup, verification, guest capture/recovery and service-worker tests.

## Upgrade

Use the normal upgrade procedure and version `1.5.12`. Replace both app and web images, and
refresh any separate guest-settings publisher and warm standby app images as for 1.5.11.
