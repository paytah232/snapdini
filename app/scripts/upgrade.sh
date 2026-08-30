#!/usr/bin/env bash
# Snapdini upgrade helper.
#
#   ./scripts/upgrade.sh [VERSION]      e.g. ./scripts/upgrade.sh 1.1.1   (default: latest)
#
# `docker compose pull && up -d` alone is NOT always enough, which is the trap this exists to close:
#
#   1. compose passes env EXPLICITLY (not env_file), so a new feature's variable must be added to
#      docker-compose.yml as well as .env — otherwise it never reaches the container and the feature
#      is silently inert, with no error anywhere.
#   2. if you pinned IMAGE_TAG, `pull` re-fetches the SAME version until you change it.
#   3. docker-compose.yml and nginx/default.conf are YOUR files. A release can change them and
#      `pull` will not touch them.
#
# This script checks all three, backs up, upgrades, and verifies. It never overwrites your files —
# it tells you what differs and lets you decide.
set -euo pipefail

VERSION="${1:-latest}"
# Deliberately operates on the CURRENT directory, not the script's own location: people copy
# this script around, and guessing a path relative to $0 silently targets the wrong deployment.
COMPOSE="docker compose"
$COMPOSE version >/dev/null 2>&1 || COMPOSE="docker-compose"
TS=$(date +%Y%m%d-%H%M%S)
ok(){ printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn(){ printf '  \033[33m!\033[0m %s\n' "$1"; }
die(){ printf '  \033[31m✗\033[0m %s\n' "$1"; exit 1; }

[ -f .env ] || die ".env not found — run this from your deployment directory."
echo "▸ Snapdini upgrade → ${VERSION}"

# ── 1. env keys the new release expects but your .env lacks ───────────────────
if [ -f .env.example ]; then
  missing=""
  while IFS= read -r key; do
    grep -qE "^${key}=" .env || missing="${missing} ${key}"
  done < <(grep -oE '^[A-Z_][A-Z0-9_]*=' .env.example | tr -d '=' | sort -u)
  if [ -n "$missing" ]; then
    warn "new/absent settings in .env (defaults apply unless you set them):"
    for k in $missing; do echo "      $k"; done
  else ok ".env covers everything .env.example documents"; fi
fi

# ── 2. env referenced by compose but missing from .env, and vice versa ────────
# A variable counts as "used" if compose mentions it ANYWHERE: under environment:, or as a
# ${VAR} interpolation for image/ports/volumes (IMAGE_TAG, HTTP_PORT, UPLOADS_HOST and friends
# are consumed by compose itself and are NOT container env — flagging those would be a false alarm).
notpassed=""
while IFS= read -r key; do
  grep -q "${key}" docker-compose.yml || notpassed="${notpassed} ${key}"
done < <(grep -oE '^[A-Z_][A-Z0-9_]*=' .env | tr -d '=' | sort -u)
if [ -n "$notpassed" ]; then
  warn "set in .env but never referenced by docker-compose.yml — these do NOTHING:"
  for k in $notpassed; do echo "      $k"; done
  warn "add them to the app service's 'environment:' list, or the feature stays silently inert."
else ok "every .env setting is referenced by docker-compose.yml"; fi

# ── 3. have your compose / nginx drifted from the release? ────────────────────
for f in docker-compose.yml nginx/default.conf; do
  [ -f "$f" ] || continue
  ref=".upgrade-ref/${f}"
  if [ -f "$ref" ] && ! diff -q "$ref" "$f" >/dev/null 2>&1; then
    warn "$f differs from the shipped version — review: diff $ref $f"
  fi
done

# ── 4. back up, then upgrade ──────────────────────────────────────────────────
cp -a .env ".env.bak-${TS}"; ok "backed up .env → .env.bak-${TS}"
if $COMPOSE ps --status running 2>/dev/null | grep -q db; then
  $COMPOSE exec -T db pg_dump -U "${POSTGRES_USER:-snapdini}" --no-owner "${POSTGRES_DB:-snapdini}" > "db-backup-${TS}.sql" 2>/dev/null \
    && ok "database dumped → db-backup-${TS}.sql" || warn "database dump skipped"
fi
if [ "$VERSION" != "latest" ]; then
  if grep -q '^IMAGE_TAG=' .env; then sed -i.tmp "s/^IMAGE_TAG=.*/IMAGE_TAG=${VERSION}/" .env && rm -f .env.tmp
  else printf 'IMAGE_TAG=%s\n' "$VERSION" >> .env; fi
  ok "IMAGE_TAG=${VERSION}"
fi
echo "▸ pulling"; $COMPOSE pull
echo "▸ starting (DB migrations run automatically on boot)"; $COMPOSE up -d

# ── 5. verify ─────────────────────────────────────────────────────────────────
PORT=$(grep -oE '^HTTP_PORT=.*' .env | cut -d= -f2); PORT="${PORT:-8080}"
echo "▸ verifying on :${PORT}"
for i in $(seq 1 30); do
  got=$(curl -fsS --max-time 5 "http://localhost:${PORT}/api/config" 2>/dev/null \
        | sed -n 's/.*"version":"\([^"]*\)".*/\1/p' || true)
  [ -n "$got" ] && break; sleep 2
done
[ -n "${got:-}" ] || die "app did not come up — check: $COMPOSE logs app"
ok "running version ${got}"
echo "▸ done. Roll back with: sed -i 's/^IMAGE_TAG=.*/IMAGE_TAG=<previous>/' .env && $COMPOSE up -d"
