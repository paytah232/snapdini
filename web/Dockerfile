# SvelteKit (adapter-node) — built and served as a standalone Node server.
# Pinned by digest, not by the floating `node:22-alpine` tag, so a rebuild of an old release
# produces the same image it did the first time. This is the multi-arch index digest, so it
# still resolves on every platform the tag covers (amd64/arm64/arm/s390x).
#   tag: node:22-alpine  ·  Node 22.23.2 (Alpine)  ·  resolved 2026-09-21
# To move it on: docker pull node:22-alpine && docker inspect --format='{{index .RepoDigests 0}}' node:22-alpine
FROM node:22-alpine@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85 AS build
WORKDIR /app
# Built from the REPO ROOT — see shared/README.md.
COPY web/package*.json ./
RUN npm install
COPY web/ ./
# Sibling of the web root, mirroring the repo, so `../../../shared/caption` means the same thing in
# here as it does in the checkout. Bundled into build/ by Vite, so it is not needed at runtime.
COPY shared/ /shared/
RUN npm run build && npm prune --omit=dev

# Same image as the build stage above; see the note there before changing either.
FROM node:22-alpine@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=build /app/build ./build
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
EXPOSE 3000
CMD ["node", "build"]
