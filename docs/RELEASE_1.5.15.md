# Snapdini 1.5.15 — a tidier site admin

This release reorganises the site admin console and gives the failover standby its own page.

- Site admin is now split into tabs — Overview, Events, Users, Support, Sales and Admin log —
  instead of one long page. Each tab has its own address (for example `/siteadmin#support`), and
  the Support tab shows how many messages and error reports are waiting.
- The failover standby moved to its own page, `/siteadmin/standby`, opened from a button beside
  "My events". The button carries a coloured dot with the standby's status. The old address,
  `/siteadmin#standby`, redirects to the new page.
- Guest feedback, guest top-ups and the referral funnel now appear on the Sales and Support tabs.
  They had stopped loading, so these sections were not being shown.
- Smaller layout fixes: stat tiles fit four across on a phone, the referral funnel lists the ten
  most-viewed galleries, and the most-visited pages list is capped at ten.

No database migration or configuration change is introduced, and nothing changes for guests,
hosts or events.

## Validation

- Frontend typecheck (0 errors) and unit suite (1,621 tests).
- Dev deployment: every tab, the tab addresses surviving a reload, the `#standby` redirect and the
  standby status dot checked in a browser at desktop and phone widths.

## Upgrade

Use the normal upgrade procedure and version `1.5.15`. Replace both app and web images, and
refresh any separate guest-settings publisher and warm standby app images as for 1.5.14.
