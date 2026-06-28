FROM node:22-alpine

RUN apk add --no-cache python3 make g++ fontconfig ttf-dejavu ffmpeg

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY tsconfig.json ./
COPY src/ ./src/
COPY assets/ ./assets/

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

EXPOSE 3000

VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "require('http').get('http://localhost:3000/api/config',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))" || exit 1

CMD ["npm", "start"]
