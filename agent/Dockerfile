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
# openssh-client provides ssh, which restic's sftp backend shells out to for
# SFTP jobs dispatched to this agent.
RUN apk add --no-cache bzip2 ca-certificates openssh-client \
  && cd /tmp \
  && ASSET="restic_${RESTIC_VERSION}_linux_${TARGETARCH}.bz2" \
  && wget -q "https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}/${ASSET}" \
  && wget -q "https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}/SHA256SUMS" \
  # Verify against the release checksums before trusting the binary.
  && grep " ${ASSET}\$" SHA256SUMS | sha256sum -c - \
  && bunzip2 "${ASSET}" \
  && mv "restic_${RESTIC_VERSION}_linux_${TARGETARCH}" /usr/local/bin/restic \
  && chmod +x /usr/local/bin/restic \
  && rm -f SHA256SUMS

COPY --from=build /amber-agent /usr/local/bin/amber-agent
ENV RESTIC_BINARY=/usr/local/bin/restic
ENV AMBER_STATE=/var/lib/amber-agent/state.json
VOLUME ["/var/lib/amber-agent"]
ENTRYPOINT ["/usr/local/bin/amber-agent"]
