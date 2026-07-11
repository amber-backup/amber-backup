# syntax=docker/dockerfile:1

# --- Stage 1: build client (Vite) ---
FROM node:22-alpine AS client-build
WORKDIR /build
COPY package.json package-lock.json* ./
COPY client/package.json ./client/
COPY server/package.json ./server/
RUN npm ci --workspace @amber/client --include-workspace-root
COPY client ./client
RUN npm run build --workspace @amber/client

# --- Stage 2: build server (NestJS) ---
FROM node:22-alpine AS server-build
WORKDIR /build
COPY package.json package-lock.json* ./
COPY server/package.json ./server/
COPY client/package.json ./client/
RUN npm ci --workspace @amber/server --include-workspace-root
COPY server ./server
RUN npm run build --workspace @amber/server \
  && npm prune --omit=dev --workspace @amber/server

# --- Stage 3: build agent binaries (both arches, served to hosts) ---
# Cross-compiles on the build host's native arch so a single image can serve
# every agent architecture, independent of the image's own platform.
FROM --platform=$BUILDPLATFORM golang:1.25-alpine AS agent-build
WORKDIR /agent
COPY agent/go.mod ./
COPY agent/VERSION ./
COPY agent/*.go ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
      go build -ldflags="-s -w" -o /out/amber-agent-linux-amd64 . \
 && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 \
      go build -ldflags="-s -w" -o /out/amber-agent-linux-arm64 . \
 && cp VERSION /out/version

# --- Stage 4: runtime ---
FROM node:22-alpine AS runtime
# Pinned restic version bundled in the image.
ARG RESTIC_VERSION=0.17.3
# Populated by buildx (amd64 / arm64) so the bundled restic matches the target.
ARG TARGETARCH
RUN apk add --no-cache bzip2 ca-certificates tar \
  && wget -qO /tmp/restic.bz2 \
     "https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}/restic_${RESTIC_VERSION}_linux_${TARGETARCH}.bz2" \
  && bunzip2 /tmp/restic.bz2 \
  && mv /tmp/restic /usr/local/bin/restic \
  && chmod +x /usr/local/bin/restic

WORKDIR /app
ENV NODE_ENV=production
ENV RESTIC_BINARY=/usr/local/bin/restic
ENV RESTIC_CACHE_DIR=/data/cache
ENV RESTORE_TMP_DIR=/data/restore-tmp

# Server runtime + compiled output + node_modules
COPY --from=server-build /build/node_modules ./node_modules
COPY --from=server-build /build/server/dist ./dist
COPY --from=server-build /build/server/package.json ./package.json
# Client assets served by the server
COPY --from=client-build /build/client/dist ./client
# Precompiled agent binaries served via GET /api/agents/binary/linux-<arch>
COPY --from=agent-build /out/ ./agent-bin/

VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "dist/main.js"]
