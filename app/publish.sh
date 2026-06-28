#!/usr/bin/env bash
# Manually build + push the Snapdini images (app + web) to a registry — the same thing the GitHub
# Actions `release` workflow does automatically on a version tag, for when you want to publish now
# without CI. Requires `docker buildx` and a prior `docker login <registry>`.
#
#   ./publish.sh <version> [image-prefix]
#   ./publish.sh 1.0.0 ghcr.io/youruser/snapdini
#
# Builds linux/amd64 + linux/arm64 and pushes <prefix>-app and <prefix>-web at :<version> and :latest.
set -euo pipefail
cd "$(dirname "$0")"            # app/

VERSION="${1:?usage: ./publish.sh <version> [image-prefix]}"
PREFIX="${2:-ghcr.io/paytah232/snapdini}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"

echo "→ publishing ${PREFIX}-{app,web}:${VERSION} (+ latest) for ${PLATFORMS}"
docker buildx build --platform "$PLATFORMS" \
  -t "${PREFIX}-app:${VERSION}" -t "${PREFIX}-app:latest" \
  -f Dockerfile . --push

docker buildx build --platform "$PLATFORMS" \
  -t "${PREFIX}-web:${VERSION}" -t "${PREFIX}-web:latest" \
  -f ../web/Dockerfile ../web --push

echo "✓ published. Self-hosters: docker-compose.yml with IMAGE_PREFIX=${PREFIX} IMAGE_TAG=${VERSION}"
