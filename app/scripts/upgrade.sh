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
# Git tags are v1.1.1 but image tags are 1.1.1, and people naturally paste the git tag.
# Normalise once here so IMAGE_TAG is always the image form.
VERSION="${VERSION#v}"
# Deliberately operates on the CURRENT directory, not the script's own location: people copy
# this script around, and guessing a path relative to $0 silently targets the wrong deployment.
COMPOSE="docker compose"
$COMPOSE version >/dev/null 2>&1 || COMPOSE="docker-compose"
TS=$(date +%Y%m%d-%H%M%S)
ok(){ printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn(){ printf '  \033[33m!\033[0m %s\n' "$1"; }
die(){ printf '  \033[31m✗\033[0m %s\n' "$1"; exit 1; }

[ -f .env ] || die ".env not found — run this from your deployment directory."

# Compose identifies a stack by PROJECT NAME, not by directory. If containers for this project are
# already running but were started from somewhere else, `up -d` here would RECREATE them using THIS
# directory's compose + .env — silently rebinding ports and swapping config. That is a live outage,
# and it is easy to trigger from a copied or test deployment.
proj=$(grep -oE '^name:[[:space:]]*[A-Za-z0-9_-]+' docker-compose.yml 2>/dev/null | awk '{print $2}' || true)
proj="${proj:-$(basename "$PWD")}"
running_dir=$(docker ps --filter "label=com.docker.compose.project=${proj}"   --format '{{.Label "com.docker.compose.project.working_dir"}}' 2>/dev/null | head -1 || true)
if [ -n "$running_dir" ] && [ "$running_dir" != "$PWD" ]; then
  die "project '${proj}' is already running from ${running_dir}.
      Upgrading from here would recreate those containers with THIS directory's config.
      Run the upgrade from ${running_dir}, or give this deployment its own 'name:' in docker-compose.yml."
fi
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
# Compare against the files SHIPPED with the target release. Fetched from the repo at that tag —
# there is no local copy to compare with, which is the whole reason this trap goes unnoticed.
REF_BASE="${SNAPDINI_REF_BASE:-https://raw.githubusercontent.com/paytah232/snapdini}"
ref_tag="$VERSION"; case "$ref_tag" in latest) ref_tag="main";; v*) ;; *) ref_tag="v${ref_tag}";; esac
drift=0; fetched=0
for f in docker-compose.yml nginx/default.conf; do
  [ -f "$f" ] || continue
  tmp=$(mktemp)
  if curl -fsSL --max-time 20 "${REF_BASE}/${ref_tag}/app/${f}" -o "$tmp" 2>/dev/null && [ -s "$tmp" ]; then
    fetched=1
    if ! diff -q "$tmp" "$f" >/dev/null 2>&1; then
      drift=1
      warn "$f differs from the ${ref_tag} release — review before upgrading:"
      # diff exits 1 when files differ, which with pipefail would abort the run — the very case
      # this check exists to report.
      { diff "$tmp" "$f" || true; } | grep -E '^[<>]' | head -12 | sed 's/^/        /' || true
      cp "$tmp" "${f}.shipped-${ref_tag}"
      echo "        (full shipped copy saved as ${f}.shipped-${ref_tag})"
    fi
  fi
  rm -f "$tmp"
done
if [ "$fetched" = 0 ]; then warn "could not fetch the ${ref_tag} reference files — skipping drift check (offline?)"
elif [ "$drift" = 0 ]; then ok "docker-compose.yml and nginx/default.conf match the release"; fi

# ── 4. confirm the image exists before mutating anything ─────────────────────
# A typo'd version must not leave .env pointing at a tag that does not exist — validate first,
# mutate second.
if [ "$VERSION" != "latest" ]; then
  PREFIX=$(grep -oE '^IMAGE_PREFIX=.*' .env | cut -d= -f2 || true); PREFIX="${PREFIX:-ghcr.io/paytah232/snapdini}"
  if command -v docker >/dev/null && ! docker manifest inspect "${PREFIX}-app:${VERSION}" >/dev/null 2>&1; then
    die "no image ${PREFIX}-app:${VERSION} — check the version (image tags have no leading 'v')."
  fi
  ok "image ${PREFIX}-app:${VERSION} exists"
fi

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
PORT=$(grep -oE '^HTTP_PORT=.*' .env | cut -d= -f2 || true); PORT="${PORT:-8080}"
echo "▸ verifying on :${PORT}"
for i in $(seq 1 30); do
  got=$(curl -fsS --max-time 5 "http://localhost:${PORT}/api/config" 2>/dev/null \
        | sed -n 's/.*"version":"\([^"]*\)".*/\1/p' || true)
  [ -n "$got" ] && break; sleep 2
done
if [ -z "${got:-}" ]; then
  # Distinguish "the app is broken" from "the proxy is pointing at the wrong container", because
  # they look identical from out here and the fix is completely different. nginx resolves `app` and
  # `web` once at startup (they are in an upstream{} block, which carries the keepalive pool we
  # cannot give up), so recreating a backend WITHOUT restarting nginx leaves it proxying to an
  # address that may now belong to a different container.
  if $COMPOSE ps --status running 2>/dev/null | grep -q app; then
    warn "the app container is running but :${PORT} did not answer — the proxy is probably stale."
    echo "  ▸ restarting the proxy and retrying"
    $COMPOSE restart nginx >/dev/null 2>&1 || true
    for i in $(seq 1 15); do
      got=$(curl -fsS --max-time 5 "http://localhost:${PORT}/api/config" 2>/dev/null \
            | sed -n 's/.*"version":"\([^"]*\)".*/\1/p' || true)
      [ -n "$got" ] && break; sleep 2
    done
    [ -n "${got:-}" ] && ok "recovered after restarting nginx"
  fi
fi
[ -n "${got:-}" ] || die "app did not come up — check: $COMPOSE logs app"
ok "running version ${got}"
echo "▸ done. Roll back with: sed -i 's/^IMAGE_TAG=.*/IMAGE_TAG=<previous>/' .env && $COMPOSE up -d"
