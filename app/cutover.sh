#!/usr/bin/env bash
# Snapdini production cutover helper. Run from app.
# See CUTOVER.md for the full runbook + the external prerequisites you must confirm first.
set -euo pipefail
cd "$(dirname "$0")"

PROD="docker compose -f docker-compose.yml --env-file .env.release"
SOON="docker compose -f docker-compose.comingsoon.yml"

case "${1:-}" in
  build)   $PROD build ;;
  up)      # FLIP live: build prod, drop the coming-soon page, bring prod up on :3002
           [ -f .env.release ] || { echo "✗ .env.release missing"; exit 1; }
           $PROD build
           $SOON down || true
           $PROD up -d
           echo "→ prod up. Tail logs: docker logs -f snapdini-app" ;;
  down)    # ROLLBACK: stop prod, restore the coming-soon page (data-prod is preserved)
           $PROD down || true
           $SOON up -d
           echo "→ rolled back to coming-soon on :3002" ;;
  status)  $PROD ps ;;
  logs)    docker logs -f "snapdini-${2:-app}" ;;
  *) echo "usage: ./cutover.sh {build|up|down|status|logs [app|web|nginx|db]}"; exit 1 ;;
esac
