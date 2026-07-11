# syntax=docker/dockerfile:1

# --- Build the static Go agent ---
# Runs on the build host's native arch and cross-compiles to the target,
# avoiding slow QEMU emulation of the Go toolchain.
FROM --platform=$BUILDPLATFORM golang:1.25-alpine AS build
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src
COPY go.mod ./
COPY VERSION ./
COPY *.go ./
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -ldflags="-s -w" -o /amber-agent .

# --- Runtime with pinned restic ---
FROM alpine:3.20
ARG RESTIC_VERSION=0.17.3
# Populated by buildx (amd64 / arm64) so the bundled restic matches the target.
ARG TARGETARCH
RUN apk add --no-cache bzip2 ca-certificates \
  && wget -qO /tmp/restic.bz2 \
     "https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}/restic_${RESTIC_VERSION}_linux_${TARGETARCH}.bz2" \
  && bunzip2 /tmp/restic.bz2 \
  && mv /tmp/restic /usr/local/bin/restic \
  && chmod +x /usr/local/bin/restic

COPY --from=build /amber-agent /usr/local/bin/amber-agent
ENV RESTIC_BINARY=/usr/local/bin/restic
ENV AMBER_STATE=/var/lib/amber-agent/state.json
VOLUME ["/var/lib/amber-agent"]
ENTRYPOINT ["/usr/local/bin/amber-agent"]
