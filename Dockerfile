# syntax=docker/dockerfile:1

# Pinned to a patch release so a rebuild never silently picks up an older,
# vulnerable Node (floor: 26.12.1, the CVE-2026-111497 Brotli fix).
ARG NODE_IMAGE=node:26.12.1-alpine
# Same for Go, which builds the agent binaries and the bundled restic
# (floor: 1.27.3, the latest stdlib security fixes).
ARG GO_IMAGE=golang:1.27.3-alpine

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
RUN npm run build --workspace @amber/server

# --- Stage 3: server production dependencies ---
# A fresh install instead of pruning the build tree: `npm prune --workspace`
# keeps the root's devDependencies (semantic-release and the npm it bundles),
# and a root-level prune pulls in the client's dependencies.
FROM ${NODE_IMAGE} AS server-deps
WORKDIR /build
COPY package.json package-lock.json* ./
COPY server/package.json ./server/
COPY client/package.json ./client/
RUN npm ci --omit=dev --workspace @amber/server

# --- Stage 4: build agent binaries (every target, served to hosts) ---
# Cross-compiles on the build host's native arch so a single image can serve
# every agent platform, independent of the image's own platform.
FROM --platform=$BUILDPLATFORM ${GO_IMAGE} AS agent-build
WORKDIR /agent
COPY agent/go.mod agent/go.sum ./
RUN go mod download
COPY agent/VERSION ./
COPY agent/*.go ./
COPY agent/hyperv ./hyperv
RUN for t in linux/amd64 linux/arm64 windows/amd64 windows/arm64; do \
      os="${t%/*}"; arch="${t#*/}"; ext=""; [ "$os" = windows ] && ext=".exe"; \
      CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" \
        go build -ldflags="-s -w" -o "/out/amber-agent-$os-$arch$ext" . || exit 1; \
    done \
 && cp VERSION /out/version

# --- Stage 5: build restic from source ---
# restic's release binaries keep the Go stdlib and module versions of their
# release day and age into known CVEs, so the bundled restic is built from the
# release source with GO_IMAGE and the affected modules raised to fixed versions.
# Keep in sync with the restic-build stage of agent/Dockerfile.
FROM --platform=$BUILDPLATFORM ${GO_IMAGE} AS restic-build
# Pinned restic version bundled in the image.
ARG RESTIC_VERSION=0.19.1
WORKDIR /src
RUN wget -q "https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}/restic-${RESTIC_VERSION}.tar.gz" \
  && wget -q "https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}/SHA256SUMS" \
  # Verify the download against the release checksums before trusting the source,
  # so a corrupted or tampered archive never becomes the bundled restic.
  && grep " restic-${RESTIC_VERSION}.tar.gz\$" SHA256SUMS | sha256sum -c - \
  && tar -xzf "restic-${RESTIC_VERSION}.tar.gz" --strip-components=1 \
  && rm -f "restic-${RESTIC_VERSION}.tar.gz" SHA256SUMS
# Lowest versions that fix the known CVEs in restic 0.19.1's dependencies
# (x/crypto 0.57.0 is the floor x/net 0.60.0 requires); go.sum is checked
# against the Go checksum database while they are downloaded.
RUN go get golang.org/x/crypto@v0.57.0 golang.org/x/net@v0.60.0 \
      google.golang.org/grpc@v1.83.2 github.com/klauspost/compress@v1.18.7 \
      go.opentelemetry.io/otel/sdk@v1.45.0 \
  && go mod tidy \
  && go mod verify
# Every agent platform: the image's own restic is picked from these by
# TARGETARCH, and agent hosts download theirs via GET /api/agents/restic/<target>
# (Windows agents always run this bundled build).
RUN for t in linux/amd64 linux/arm64 windows/amd64 windows/arm64; do \
      os="${t%/*}"; arch="${t#*/}"; ext=""; [ "$os" = windows ] && ext=".exe"; \
      CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" \
        go build -trimpath -ldflags="-s -w" -o "/out/restic-$os-$arch$ext" ./cmd/restic || exit 1; \
    done \
 && echo "${RESTIC_VERSION}" > /out/restic-version

# --- Stage 5b: agent bundle + checksums ---
# What the server serves to agent hosts, with the SHA256SUMS install.ps1 checks.
FROM --platform=$BUILDPLATFORM ${GO_IMAGE} AS agent-bundle
WORKDIR /bundle
COPY --from=agent-build /out/ ./
COPY --from=restic-build /out/ ./
RUN sha256sum amber-agent-* restic-linux-* restic-windows-* > SHA256SUMS

# --- Stage 6: runtime ---
FROM ${NODE_IMAGE} AS runtime
# openssh-client provides ssh-keygen (SFTP target key generation) and ssh
# (restic's sftp backend shells out to it for server-executed SFTP jobs).
# The server runs on plain node, so the base image's npm (with its own
# vulnerable dependency tree) is removed.
RUN apk add --no-cache ca-certificates tar openssh-client \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
# Populated by buildx (amd64 / arm64) so the server's restic matches the image.
ARG TARGETARCH
COPY --from=restic-build /out/restic-linux-${TARGETARCH} /usr/local/bin/restic

WORKDIR /app
ENV NODE_ENV=production
ENV RESTIC_BINARY=/usr/local/bin/restic
ENV RESTIC_CACHE_DIR=/data/cache
ENV RESTORE_TMP_DIR=/data/restore-tmp
ENV CLI_SCRIPT_DIR=/app/cli-install

# Server runtime + compiled output + node_modules
COPY --from=server-deps /build/node_modules ./node_modules
COPY --from=server-build /build/server/dist ./dist
COPY --from=server-build /build/server/package.json ./package.json
# Client assets served by the server
COPY --from=client-build /build/client/dist ./client
# Precompiled agent binaries and restic builds served to agent hosts via
# GET /api/agents/binary/<os>-<arch>, /api/agents/restic/<os>-<arch> and
# /api/agents/SHA256SUMS.
COPY --from=agent-bundle /bundle/ ./agent-bin/
# ambb CLI install scripts served via GET /api/cli/install.{sh,ps1}; the
# binaries themselves are downloaded from GitHub Releases by the scripts.
COPY cli/install.sh cli/install.ps1 ./cli-install/

VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "dist/main.js"]
