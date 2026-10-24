# syntax=docker/dockerfile:1

# Pinned to a patch release so a rebuild never silently picks up an older,
# vulnerable Go stdlib (floor: 1.27.3, the latest stdlib security fixes).
ARG GO_IMAGE=golang:1.27.3-alpine

# --- Build the static Go agent ---
# Runs on the build host's native arch and cross-compiles to the target,
# avoiding slow QEMU emulation of the Go toolchain.
FROM --platform=$BUILDPLATFORM ${GO_IMAGE} AS build
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src
COPY go.mod ./
COPY VERSION ./
COPY *.go ./
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -ldflags="-s -w" -o /amber-agent .

# --- Build restic from source ---
# restic's release binaries keep the Go stdlib and module versions of their
# release day and age into known CVEs, so the bundled restic is built from the
# release source with GO_IMAGE and the affected modules raised to fixed versions.
# Keep in sync with the restic-build stage of the server's Dockerfile.
FROM --platform=$BUILDPLATFORM ${GO_IMAGE} AS restic-build
ARG RESTIC_VERSION=0.19.1
WORKDIR /src
RUN wget -q "https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}/restic-${RESTIC_VERSION}.tar.gz" \
  && wget -q "https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}/SHA256SUMS" \
  # Verify against the release checksums before trusting the source.
  && grep " restic-${RESTIC_VERSION}.tar.gz\$" SHA256SUMS | sha256sum -c - \
  && tar -xzf "restic-${RESTIC_VERSION}.tar.gz" --strip-components=1 \
  && rm -f "restic-${RESTIC_VERSION}.tar.gz" SHA256SUMS
RUN go get golang.org/x/crypto@v0.57.0 golang.org/x/net@v0.60.0 \
      google.golang.org/grpc@v1.83.2 github.com/klauspost/compress@v1.18.7 \
      go.opentelemetry.io/otel/sdk@v1.45.0 \
  && go mod tidy \
  && go mod verify
ARG TARGETOS
ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
      go build -trimpath -ldflags="-s -w" -o /restic ./cmd/restic

# --- Runtime with pinned restic ---
FROM alpine:3.24
# openssh-client provides ssh, which restic's sftp backend shells out to for
# SFTP jobs dispatched to this agent.
RUN apk add --no-cache ca-certificates openssh-client

COPY --from=restic-build /restic /usr/local/bin/restic
COPY --from=build /amber-agent /usr/local/bin/amber-agent
ENV RESTIC_BINARY=/usr/local/bin/restic
ENV AMBER_STATE=/var/lib/amber-agent/state.json
VOLUME ["/var/lib/amber-agent"]
ENTRYPOINT ["/usr/local/bin/amber-agent"]
