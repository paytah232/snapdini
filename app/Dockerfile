# Base image pinned BY DIGEST, not by tag.
#   tag pinned:  node:22-alpine   (resolved to Node 22.23.4, alpine 3.24)
#   pinned on:   2026-10-24
#   digest:      sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a
# This is the multi-arch INDEX digest, so it still resolves per-platform on arm64.
#
# `node:22-alpine` is a moving tag: it silently became a different Node, a different Alpine and a
# different OpenSSL every few weeks, so two builds of the same commit were not the same image and
# a broken upstream arrived without a code change. A digest makes the base an input we choose.
#
# Node 22.23.4 includes the October 2026 security fixes. `uuid` v14 is ESM-only and
# is imported from CommonJS, which also needs Node >= 22.12 for require(ESM). Keep the security
# patch floor as well as that compatibility requirement. Re-pin deliberately (docker buildx imagetools inspect node:22-alpine) to pick up
# base-image security fixes, and stay on 22 — 24 is a separate piece of work.
FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a

RUN apk add --no-cache python3 make g++ fontconfig ttf-dejavu ffmpeg

WORKDIR /app

# Built from the REPO ROOT, so paths are prefixed. That context is what lets shared/ into the image
# at all; see shared/README.md for why the two halves import one file instead of keeping copies.
COPY app/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY app/tsconfig.json ./
COPY app/src/ ./src/
COPY app/assets/ ./assets/
# At /shared, NOT inside /app: that mirrors the repo, where shared/ is a sibling of app/. Because
# the layout matches, `../../../../shared/caption` resolves the same here as on a laptop.
COPY shared/ /shared/

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

EXPOSE 3000

VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "require('http').get('http://localhost:3000/api/config',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))" || exit 1

CMD ["npm", "start"]
