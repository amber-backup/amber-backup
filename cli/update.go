package main

// Self-update: `ambb update` fetches the latest GitHub Release, downloads the
// archive for this OS/architecture, verifies it against the release's
// checksums.txt, checks that the extracted binary runs and reports the release
// version, and only then atomically swaps it over the running executable.

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

// releaseRepo is the GitHub repository whose releases carry the CLI binaries.
const releaseRepo = "amber-backup/amber-backup"

const (
	maxReleaseJSON  = 1 << 20   // GitHub release metadata
	maxChecksums    = 64 << 10  // checksums.txt
	maxArchive      = 100 << 20 // downloaded archive
	maxBinary       = 100 << 20 // extracted binary
	versionCheckTTL = 15 * time.Second
)

var releaseTagRE = regexp.MustCompile(`^v(\d+\.\d+\.\d+)$`)

type ghRelease struct {
	TagName string    `json:"tag_name"`
	Assets  []ghAsset `json:"assets"`
}

type ghAsset struct {
	Name string `json:"name"`
	URL  string `json:"browser_download_url"`
	Size int64  `json:"size"`
}

// allowedDownloadHost reports whether a (redirect) target may serve release
// data: GitHub itself and its asset CDN, HTTPS only.
func allowedDownloadHost(u *url.URL) bool {
	if u.Scheme != "https" {
		return false
	}
	host := strings.ToLower(u.Hostname())
	return host == "github.com" || host == "api.github.com" ||
		host == "githubusercontent.com" || strings.HasSuffix(host, ".githubusercontent.com")
}

// newUpdateHTTPClient refuses to follow redirects off GitHub or down to HTTP.
func newUpdateHTTPClient() *http.Client {
	return &http.Client{
		Timeout: 5 * time.Minute,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return errors.New("too many redirects")
			}
			if !isAllowedHost(req.URL) {
				return fmt.Errorf("refusing redirect to %s", req.URL.Redacted())
			}
			return nil
		},
	}
}

// notFoundError is a 404 from GitHub (e.g. no release published yet).
type notFoundError struct{ url string }

func (e *notFoundError) Error() string { return "GET " + e.url + ": HTTP 404" }

// fetchLimited GETs rawURL and returns at most limit bytes, failing if the body
// is larger.
func fetchLimited(client *http.Client, rawURL string, limit int64) ([]byte, error) {
	u, err := url.Parse(rawURL)
	if err != nil || !isAllowedHost(u) {
		return nil, fmt.Errorf("refusing to download from %q", rawURL)
	}
	req, err := http.NewRequest(http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "ambb/"+Version)
	if u.Hostname() == "api.github.com" {
		req.Header.Set("Accept", "application/vnd.github+json")
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, &notFoundError{url: rawURL}
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET %s: HTTP %d", rawURL, resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("GET %s: response exceeds %d bytes", rawURL, limit)
	}
	return data, nil
}

// assetName is the release archive holding the binary for goos/goarch (see
// .github/workflows/cli-release.yml).
func assetName(version, goos, goarch string) string {
	ext := ".tar.gz"
	if goos == "windows" {
		ext = ".zip"
	}
	return fmt.Sprintf("ambb_%s_%s_%s%s", version, goos, goarch, ext)
}

// binaryName is the executable's file name inside the archive.
func binaryName(goos string) string {
	if goos == "windows" {
		return "ambb.exe"
	}
	return "ambb"
}

// lookupChecksum finds the SHA-256 for name in a `sha256sum` listing.
func lookupChecksum(listing []byte, name string) (string, error) {
	for _, line := range strings.Split(string(listing), "\n") {
		fields := strings.Fields(line)
		if len(fields) != 2 {
			continue
		}
		if strings.TrimPrefix(fields[1], "*") != name {
			continue
		}
		sum := strings.ToLower(fields[0])
		if len(sum) != sha256.Size*2 {
			return "", fmt.Errorf("malformed checksum for %s", name)
		}
		if _, err := hex.DecodeString(sum); err != nil {
			return "", fmt.Errorf("malformed checksum for %s", name)
		}
		return sum, nil
	}
	return "", fmt.Errorf("no checksum for %s in checksums.txt", name)
}

// extractBinary pulls exactly `<dir>/<binary>` out of the archive — the one
// entry a release archive is expected to carry — as a regular file. Any other
// entry is ignored, so a crafted archive cannot write elsewhere.
func extractBinary(archive []byte, asset, dir, binary string) ([]byte, error) {
	want := dir + "/" + binary
	readAll := func(r io.Reader) ([]byte, error) {
		data, err := io.ReadAll(io.LimitReader(r, maxBinary+1))
		if err != nil {
			return nil, err
		}
		if len(data) > maxBinary {
			return nil, fmt.Errorf("%s exceeds %d bytes", want, maxBinary)
		}
		return data, nil
	}

	if strings.HasSuffix(asset, ".zip") {
		zr, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
		if err != nil {
			return nil, fmt.Errorf("open zip: %w", err)
		}
		for _, f := range zr.File {
			if f.Name != want || !f.Mode().IsRegular() {
				continue
			}
			rc, err := f.Open()
			if err != nil {
				return nil, err
			}
			defer rc.Close()
			return readAll(rc)
		}
		return nil, fmt.Errorf("%s not found in %s", want, asset)
	}

	gz, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		return nil, fmt.Errorf("open gzip: %w", err)
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return nil, fmt.Errorf("%s not found in %s", want, asset)
		}
		if err != nil {
			return nil, fmt.Errorf("read tar: %w", err)
		}
		if hdr.Name == want && hdr.Typeflag == tar.TypeReg {
			return readAll(tr)
		}
	}
}

// latestReleaseURL is the GitHub API endpoint for the newest release.
var latestReleaseURL = "https://api.github.com/repos/" + releaseRepo + "/releases/latest"

// isAllowedHost is allowedDownloadHost; tests swap it to reach a local server.
var isAllowedHost = allowedDownloadHost

// fetchLatestRelease returns the newest release's version (without "v").
func fetchLatestRelease(client *http.Client) (string, *ghRelease, error) {
	meta, err := fetchLimited(client, latestReleaseURL, maxReleaseJSON)
	if err != nil {
		var nf *notFoundError
		if errors.As(err, &nf) {
			return "", nil, errors.New("no release of ambb has been published yet")
		}
		return "", nil, fmt.Errorf("look up latest release: %w", err)
	}
	var rel ghRelease
	if err := json.Unmarshal(meta, &rel); err != nil {
		return "", nil, fmt.Errorf("decode release metadata: %w", err)
	}
	m := releaseTagRE.FindStringSubmatch(rel.TagName)
	if m == nil {
		return "", nil, fmt.Errorf("latest release has an unexpected tag %q", rel.TagName)
	}
	return m[1], &rel, nil
}

// downloadBinary fetches the release archive for goos/goarch, verifies it
// against the release's checksums.txt and returns the extracted executable.
func downloadBinary(client *http.Client, rel *ghRelease, version, goos, goarch string) ([]byte, error) {
	name := assetName(version, goos, goarch)
	var archiveAsset, checksumAsset *ghAsset
	for i := range rel.Assets {
		switch rel.Assets[i].Name {
		case name:
			archiveAsset = &rel.Assets[i]
		case "checksums.txt":
			checksumAsset = &rel.Assets[i]
		}
	}
	if archiveAsset == nil {
		return nil, fmt.Errorf("release %s has no build for %s/%s (%s)", rel.TagName, goos, goarch, name)
	}
	if checksumAsset == nil {
		return nil, fmt.Errorf("release %s has no checksums.txt; refusing to install an unverified binary", rel.TagName)
	}

	sums, err := fetchLimited(client, checksumAsset.URL, maxChecksums)
	if err != nil {
		return nil, fmt.Errorf("download checksums: %w", err)
	}
	wantSum, err := lookupChecksum(sums, name)
	if err != nil {
		return nil, err
	}
	archive, err := fetchLimited(client, archiveAsset.URL, maxArchive)
	if err != nil {
		return nil, fmt.Errorf("download %s: %w", name, err)
	}
	gotSum := sha256.Sum256(archive)
	if hex.EncodeToString(gotSum[:]) != wantSum {
		return nil, fmt.Errorf("checksum mismatch for %s; refusing to install", name)
	}
	dir := strings.TrimSuffix(strings.TrimSuffix(name, ".zip"), ".tar.gz")
	return extractBinary(archive, name, dir, binaryName(goos))
}

// runUpdate implements `ambb update [--check] [--force]`.
func runUpdate(flags *CommandFlags) error {
	client := newUpdateHTTPClient()
	latest, rel, err := fetchLatestRelease(client)
	if err != nil {
		return err
	}

	current := Version
	isDev := !releaseTagRE.MatchString("v" + current)
	switch {
	case flags.Check:
		if !isDev && !versionGreater(latest, current) {
			fmt.Printf("ambb %s is up to date\n", current)
		} else {
			fmt.Printf("ambb %s is available (installed: %s)\n", latest, current)
		}
		return nil
	case isDev && !flags.Force:
		return fmt.Errorf(
			"this is a development build (%s); pass --force to replace it with release %s",
			current, latest)
	case !isDev && !versionGreater(latest, current) && !flags.Force:
		fmt.Printf("ambb %s is up to date\n", current)
		return nil
	}

	exePath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("locate executable: %w", err)
	}
	if resolved, err := filepath.EvalSymlinks(exePath); err == nil {
		exePath = resolved
	}
	info, err := os.Stat(exePath)
	if err != nil {
		return fmt.Errorf("stat executable: %w", err)
	}

	fmt.Printf("Downloading ambb %s for %s/%s...\n", latest, runtime.GOOS, runtime.GOARCH)
	binary, err := downloadBinary(client, rel, latest, runtime.GOOS, runtime.GOARCH)
	if err != nil {
		return err
	}

	// Stage next to the executable so the final rename stays on one filesystem.
	dir := filepath.Dir(exePath)
	tmp, err := os.CreateTemp(dir, ".ambb-update-*")
	if err != nil {
		if errors.Is(err, os.ErrPermission) {
			return fmt.Errorf("cannot write to %s (permission denied); re-run with the permissions that own the binary, e.g. sudo ambb update", dir)
		}
		return fmt.Errorf("stage update: %w", err)
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath) // no-op once renamed away
	_, writeErr := tmp.Write(binary)
	closeErr := tmp.Close()
	if writeErr != nil {
		return fmt.Errorf("stage update: %w", writeErr)
	}
	if closeErr != nil {
		return fmt.Errorf("stage update: %w", closeErr)
	}
	if err := os.Chmod(tmpPath, info.Mode().Perm()|0o100); err != nil {
		return fmt.Errorf("stage update: %w", err)
	}
	if runtime.GOOS == "windows" {
		// Windows only runs files with an executable extension.
		exeTmp := tmpPath + ".exe"
		if err := os.Rename(tmpPath, exeTmp); err != nil {
			return fmt.Errorf("stage update: %w", err)
		}
		tmpPath = exeTmp
		defer os.Remove(tmpPath)
	}

	// The new binary must run and report exactly the release version.
	ctx, cancel := context.WithTimeout(context.Background(), versionCheckTTL)
	defer cancel()
	out, err := exec.CommandContext(ctx, tmpPath, "--version").Output()
	if got := strings.TrimSpace(string(out)); err != nil || got != "ambb "+latest {
		return fmt.Errorf("downloaded binary failed its version check (got %q, want %q): %v",
			got, "ambb "+latest, err)
	}

	if err := replaceExecutable(tmpPath, exePath); err != nil {
		if errors.Is(err, os.ErrPermission) {
			return fmt.Errorf("cannot replace %s (permission denied); re-run with the permissions that own the binary, e.g. sudo ambb update", exePath)
		}
		return fmt.Errorf("install update: %w", err)
	}
	fmt.Printf("Updated ambb %s -> %s (%s)\n", current, latest, exePath)
	return nil
}

// replaceExecutable moves src over dst. A running executable cannot be
// overwritten on Windows but can be renamed, so it is moved aside first.
func replaceExecutable(src, dst string) error {
	if runtime.GOOS != "windows" {
		return os.Rename(src, dst)
	}
	old := dst + ".old"
	_ = os.Remove(old) // leftover from a previous update
	if err := os.Rename(dst, old); err != nil {
		return err
	}
	if err := os.Rename(src, dst); err != nil {
		_ = os.Rename(old, dst)
		return err
	}
	_ = os.Remove(old) // fails while still running; cleaned up next time
	return nil
}

// versionGreater reports whether semantic version a is strictly newer than b.
func versionGreater(a, b string) bool {
	pa, pb := parseVersion(a), parseVersion(b)
	for i := range pa {
		if pa[i] != pb[i] {
			return pa[i] > pb[i]
		}
	}
	return false
}

func parseVersion(s string) [3]int {
	var v [3]int
	parts := strings.SplitN(strings.TrimPrefix(strings.TrimSpace(s), "v"), ".", 3)
	for i := 0; i < len(parts) && i < 3; i++ {
		n := 0
		fmt.Sscanf(parts[i], "%d", &n)
		v[i] = n
	}
	return v
}
