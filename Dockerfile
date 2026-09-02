# One image for both roles. RUN_WORKER decides whether a container holds
# WhatsApp sockets or only serves the API.
FROM node:22-slim

WORKDIR /app

# postgresql-client is here for scripts/migrate.sh, which runs on release.
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY api/package.json api/package-lock.json ./api/
RUN cd api && npm ci --omit=dev

COPY api ./api
COPY web ./web
COPY db ./db
COPY scripts ./scripts

ENV NODE_ENV=production
ENV WEB_ROOT=/app/web
EXPOSE 8080

CMD ["node", "--experimental-strip-types", "api/src/main.ts"]
