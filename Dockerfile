# syntax=docker/dockerfile:1

# Pinned to a patch release so a rebuild never silently picks up an older,
# vulnerable Node (floor: 26.12.1, the CVE-2026-111497 Brotli fix).
ARG NODE_IMAGE=node:26.12.1-alpine

# --- Stage 1: build client (Vite) ---
FROM ${NODE_IMAGE} AS client-build
WORKDIR /build
COPY package.json package-lock.json* ./
COPY client/package.json ./client/
COPY server/package.json ./server/
RUN npm ci --workspace @amber/client --include-workspace-root
COPY client ./client
RUN npm run build --workspace @amber/client

# --- Stage 2: build server (NestJS) ---
FROM ${NODE_IMAGE} AS server-build
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
FROM ${NODE_IMAGE} AS runtime
# Pinned restic version bundled in the image.
ARG RESTIC_VERSION=0.17.3
# Populated by buildx (amd64 / arm64) so the bundled restic matches the target.
ARG TARGETARCH
# openssh-client provides ssh-keygen (SFTP target key generation) and ssh
# (restic's sftp backend shells out to it for server-executed SFTP jobs).
RUN apk add --no-cache bzip2 ca-certificates tar openssh-client \
  && cd /tmp \
  && ASSET="restic_${RESTIC_VERSION}_linux_${TARGETARCH}.bz2" \
  && wget -q "https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}/${ASSET}" \
  && wget -q "https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}/SHA256SUMS" \
  # Verify the download against the release checksums before trusting the binary,
  # so a corrupted or tampered asset never becomes the bundled restic.
  && grep " ${ASSET}\$" SHA256SUMS | sha256sum -c - \
  && bunzip2 "${ASSET}" \
  && mv "restic_${RESTIC_VERSION}_linux_${TARGETARCH}" /usr/local/bin/restic \
  && chmod +x /usr/local/bin/restic \
  && rm -f SHA256SUMS

WORKDIR /app
ENV NODE_ENV=production
ENV RESTIC_BINARY=/usr/local/bin/restic
ENV RESTIC_CACHE_DIR=/data/cache
ENV RESTORE_TMP_DIR=/data/restore-tmp
ENV CLI_SCRIPT_DIR=/app/cli-install

# Server runtime + compiled output + node_modules
COPY --from=server-build /build/node_modules ./node_modules
COPY --from=server-build /build/server/dist ./dist
COPY --from=server-build /build/server/package.json ./package.json
# Client assets served by the server
COPY --from=client-build /build/client/dist ./client
# Precompiled agent binaries served via GET /api/agents/binary/linux-<arch>
COPY --from=agent-build /out/ ./agent-bin/
# ambb CLI install scripts served via GET /api/cli/install.{sh,ps1}; the
# binaries themselves are downloaded from GitHub Releases by the scripts.
COPY cli/install.sh cli/install.ps1 ./cli-install/

VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "dist/main.js"]
