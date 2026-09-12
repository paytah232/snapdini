FROM node:22-alpine

RUN apk add --no-cache python3 make g++ fontconfig ttf-dejavu ffmpeg

WORKDIR /app

# Built from the REPO ROOT, so paths are prefixed. That context is what lets shared/ into the image
# at all; see shared/README.md for why the two halves import one file instead of keeping copies.
COPY app/package*.json ./
RUN npm install --omit=dev && npm cache clean --force

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
