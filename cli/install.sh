#!/bin/sh
# Installs the ambb CLI (Amber Backup) on Linux and macOS.
#
#   curl -fsSL https://<your-amber-server>/api/cli/install.sh | sh
#
# Downloads the release archive for this OS/architecture from GitHub Releases,
# verifies its SHA-256 against the release's checksums.txt and installs the
# binary. Safe to re-run; it replaces an existing ambb in the install dir.
#
# Environment:
#   AMBB_VERSION      release to install, e.g. 1.36.0 (default: latest)
#   AMBB_INSTALL_DIR  target directory (default: /usr/local/bin if writable or
#                     running as root, otherwise ~/.local/bin)
#   AMBER_URL         Amber server, only used for the "next step" hint
set -eu

# Defaults. The Amber server rewrites these two lines when it serves the script;
# a variable set in the environment always wins.
AMBB_VERSION="${AMBB_VERSION:-latest}"
AMBER_URL="${AMBER_URL:-}"

REPO="amber-backup/amber-backup"
TMP_DIR=""

say() {
    printf '%s\n' "$*"
}

fail() {
    printf 'Error: %s\n' "$*" >&2
    exit 1
}

cleanup() {
    if [ -n "$TMP_DIR" ]; then
        rm -rf "$TMP_DIR"
    fi
}

has() {
    command -v "$1" >/dev/null 2>&1
}

# download <url> <dest>: HTTPS only, fails on HTTP errors.
download() {
    if has curl; then
        curl -fsSL --proto '=https' --proto-redir '=https' -o "$2" "$1"
    elif has wget; then
        if wget --help 2>&1 | grep -q -- '--https-only'; then
            wget -q --https-only -O "$2" "$1"
        else
            wget -q -O "$2" "$1"
        fi
    else
        fail "curl or wget is required"
    fi
}

# Resolves "latest" to the newest release tag (e.g. v1.36.0).
latest_tag() {
    if has curl; then
        # The /releases/latest page redirects to /releases/tag/<tag>; following
        # it avoids the GitHub API's rate limit.
        curl -fsSLI --proto '=https' --proto-redir '=https' -o /dev/null \
            -w '%{url_effective}' "https://github.com/$REPO/releases/latest" |
            sed -n 's|.*/releases/tag/||p'
    else
        download "https://api.github.com/repos/$REPO/releases/latest" "$TMP_DIR/latest.json"
        sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$TMP_DIR/latest.json" |
            head -n 1
    fi
}

sha256_of() {
    if has sha256sum; then
        sha256sum "$1" | awk '{print $1}'
    elif has shasum; then
        shasum -a 256 "$1" | awk '{print $1}'
    else
        fail "sha256sum or shasum is required to verify the download"
    fi
}

main() {
    case "$(uname -s)" in
        Linux) os=linux ;;
        Darwin) os=darwin ;;
        *) fail "unsupported operating system: $(uname -s) (use install.ps1 on Windows)" ;;
    esac
    case "$(uname -m)" in
        x86_64 | amd64) arch=amd64 ;;
        aarch64 | arm64) arch=arm64 ;;
        *) fail "unsupported architecture: $(uname -m)" ;;
    esac

    TMP_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t ambb)"
    trap cleanup EXIT
    trap 'exit 1' HUP INT TERM

    if [ "$AMBB_VERSION" = "latest" ]; then
        tag="$(latest_tag)" || tag=""
        [ -n "$tag" ] || fail "could not determine the latest release of $REPO"
    else
        tag="v${AMBB_VERSION#v}"
    fi
    version="${tag#v}"
    if ! printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
        fail "invalid version: $version (expected e.g. 1.36.0)"
    fi

    name="ambb_${version}_${os}_${arch}"
    archive="$name.tar.gz"
    base="https://github.com/$REPO/releases/download/v$version"

    say "Downloading ambb $version ($os/$arch)"
    download "$base/$archive" "$TMP_DIR/$archive" ||
        fail "download of $base/$archive failed"
    download "$base/checksums.txt" "$TMP_DIR/checksums.txt" ||
        fail "download of $base/checksums.txt failed"

    expected="$(awk -v f="$archive" '$2 == f || $2 == "*" f {print $1; exit}' "$TMP_DIR/checksums.txt")"
    [ -n "$expected" ] || fail "no checksum for $archive in checksums.txt"
    actual="$(sha256_of "$TMP_DIR/$archive")"
    if [ "$actual" != "$expected" ]; then
        fail "checksum mismatch for $archive (expected $expected, got $actual)"
    fi
    say "Checksum verified"

    tar -xzf "$TMP_DIR/$archive" -C "$TMP_DIR"
    [ -f "$TMP_DIR/$name/ambb" ] || fail "archive does not contain $name/ambb"

    if [ -n "${AMBB_INSTALL_DIR:-}" ]; then
        dir="$AMBB_INSTALL_DIR"
    elif [ "$(id -u)" = "0" ] || { [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; }; then
        dir=/usr/local/bin
    else
        [ -n "${HOME:-}" ] || fail "HOME is not set; set AMBB_INSTALL_DIR"
        dir="$HOME/.local/bin"
    fi
    mkdir -p "$dir" || fail "cannot create $dir"

    # Copy next to the target first, then rename: atomic, and replacing a
    # running binary never fails with "text file busy".
    cp "$TMP_DIR/$name/ambb" "$dir/.ambb.new" || fail "cannot write to $dir (set AMBB_INSTALL_DIR or run as root)"
    chmod 0755 "$dir/.ambb.new"
    mv -f "$dir/.ambb.new" "$dir/ambb"

    say "Installed $("$dir/ambb" --version) to $dir/ambb"
    case ":${PATH:-}:" in
        *":$dir:"*) ;;
        *) say "Warning: $dir is not on your PATH. Add it, e.g.: export PATH=\"$dir:\$PATH\"" ;;
    esac

    say ""
    if [ -n "$AMBER_URL" ]; then
        say "Next step: ambb login $AMBER_URL"
    else
        say "Next step: ambb login <your-amber-server>"
    fi
}

main "$@"
