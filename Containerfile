# Sammat – https://github.com/lyzio/SamMat
# --- build: better-sqlite3 needs a compiler on Alpine ---
FROM docker.io/library/node:22-alpine AS build
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# --- runtime ---
FROM docker.io/library/node:22-alpine
RUN apk add --no-cache tzdata
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/app/data/sammat.db \
    TZ=Europe/Stockholm
COPY --from=build /app/node_modules ./node_modules
COPY package.json server.js ./
COPY public ./public
LABEL org.opencontainers.image.title="Sammat" \
      org.opencontainers.image.description="Sambeställning av mat med Swish" \
      org.opencontainers.image.source="https://github.com/lyzio/SamMat" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"
EXPOSE 3000
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
# Runs as root inside the container; with rootless podman that is your own user on the host.
CMD ["node", "server.js"]
