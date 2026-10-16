FROM node:22-alpine

WORKDIR /app

# no dependencies, so no npm install
COPY package.json server.js ./
COPY public/ ./public/

# Photos and music come from mounted folders (see immich-plate-loader.xml)
ENV NODE_ENV=production \
    PORT=8787 \
    PHOTOS_DIR=/photos \
    MUSIC_DIR=/music
RUN mkdir -p /photos /music && chown node:node /photos /music

USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -q -O /dev/null http://127.0.0.1:8787/health || exit 1

CMD ["node", "server.js"]
