package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func tarGz(t *testing.T, entries map[string][]byte, symlink string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for name, data := range entries {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o755, Size: int64(len(data)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	if symlink != "" {
		if err := tw.WriteHeader(&tar.Header{Name: symlink, Linkname: "/etc/passwd", Typeflag: tar.TypeSymlink}); err != nil {
			t.Fatal(err)
		}
	}
	tw.Close()
	gz.Close()
	return buf.Bytes()
}

func TestAssetNameMatchesReleaseWorkflow(t *testing.T) {
	if got := assetName("1.2.3", "linux", "arm64"); got != "ambb_1.2.3_linux_arm64.tar.gz" {
		t.Errorf("linux asset = %s", got)
	}
	if got := assetName("1.2.3", "windows", "amd64"); got != "ambb_1.2.3_windows_amd64.zip" {
		t.Errorf("windows asset = %s", got)
	}
}

func TestLookupChecksum(t *testing.T) {
	sum := strings.Repeat("ab", 32)
	listing := []byte(strings.Repeat("cd", 32) + "  ambb_1.0.0_linux_amd64.tar.gz.sig\n" +
		sum + "  ambb_1.0.0_linux_amd64.tar.gz\n")

	got, err := lookupChecksum(listing, "ambb_1.0.0_linux_amd64.tar.gz")
	if err != nil || got != sum {
		t.Fatalf("lookupChecksum = %q, %v", got, err)
	}
	if _, err := lookupChecksum(listing, "ambb_1.0.0_darwin_amd64.tar.gz"); err == nil {
		t.Error("expected an error for a missing asset")
	}
	if _, err := lookupChecksum([]byte("xyz  a.tar.gz\n"), "a.tar.gz"); err == nil {
		t.Error("expected an error for a malformed checksum")
	}
}

func TestExtractBinaryTakesOnlyTheExpectedEntry(t *testing.T) {
	archive := tarGz(t, map[string][]byte{
		"../ambb":             []byte("evil"),
		"other/ambb":          []byte("evil"),
		"ambb_1.0.0_x_y/ambb": []byte("good"),
	}, "")
	got, err := extractBinary(archive, "ambb_1.0.0_x_y.tar.gz", "ambb_1.0.0_x_y", "ambb")
	if err != nil || string(got) != "good" {
		t.Fatalf("extractBinary = %q, %v", got, err)
	}
}

func TestExtractBinaryRejectsSymlink(t *testing.T) {
	archive := tarGz(t, nil, "ambb_1.0.0_x_y/ambb")
	if _, err := extractBinary(archive, "ambb_1.0.0_x_y.tar.gz", "ambb_1.0.0_x_y", "ambb"); err == nil {
		t.Error("a symlink must not be accepted as the binary")
	}
}

func TestExtractBinaryZip(t *testing.T) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, _ := zw.Create("ambb_1.0.0_windows_amd64/ambb.exe")
	w.Write([]byte("exe"))
	zw.Close()

	got, err := extractBinary(buf.Bytes(), "ambb_1.0.0_windows_amd64.zip", "ambb_1.0.0_windows_amd64", "ambb.exe")
	if err != nil || string(got) != "exe" {
		t.Fatalf("extractBinary = %q, %v", got, err)
	}
}

func TestAllowedDownloadHost(t *testing.T) {
	cases := map[string]bool{
		"https://github.com/amber-backup/amber-backup/releases/download/v1/x": true,
		"https://api.github.com/repos/x/y/releases/latest":                    true,
		"https://objects.githubusercontent.com/abc":                           true,
		"http://github.com/x":                 false,
		"https://github.com.evil.example/x":   false,
		"https://evilgithubusercontent.com/x": false,
	}
	for raw, want := range cases {
		u, _ := url.Parse(raw)
		if got := allowedDownloadHost(u); got != want {
			t.Errorf("allowedDownloadHost(%s) = %v, want %v", raw, got, want)
		}
	}
}

func TestVersionGreater(t *testing.T) {
	if !versionGreater("1.10.0", "1.9.9") {
		t.Error("1.10.0 should be newer than 1.9.9")
	}
	if versionGreater("1.2.3", "1.2.3") {
		t.Error("equal versions are not newer")
	}
}

func TestDownloadBinaryVerifiesChecksum(t *testing.T) {
	archive := tarGz(t, map[string][]byte{"ambb_2.0.0_linux_amd64/ambb": []byte("binary")}, "")
	sum := sha256.Sum256(archive)
	checksums := hex.EncodeToString(sum[:]) + "  ambb_2.0.0_linux_amd64.tar.gz\n"

	var tampered bool
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/latest":
			fmt.Fprintf(w, `{"tag_name":"v2.0.0","assets":[
				{"name":"ambb_2.0.0_linux_amd64.tar.gz","browser_download_url":"https://%[1]s/archive"},
				{"name":"checksums.txt","browser_download_url":"https://%[1]s/sums"}]}`, r.Host)
		case "/archive":
			if tampered {
				w.Write(append([]byte{}, archive[:len(archive)-1]...))
				return
			}
			w.Write(archive)
		case "/sums":
			w.Write([]byte(checksums))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	origURL, origAllowed := latestReleaseURL, isAllowedHost
	latestReleaseURL = srv.URL + "/latest"
	isAllowedHost = func(u *url.URL) bool { return u.Scheme == "https" }
	defer func() { latestReleaseURL, isAllowedHost = origURL, origAllowed }()

	client := srv.Client()
	version, rel, err := fetchLatestRelease(client)
	if err != nil || version != "2.0.0" {
		t.Fatalf("fetchLatestRelease = %q, %v", version, err)
	}
	bin, err := downloadBinary(client, rel, version, "linux", "amd64")
	if err != nil || string(bin) != "binary" {
		t.Fatalf("downloadBinary = %q, %v", bin, err)
	}

	tampered = true
	if _, err := downloadBinary(client, rel, version, "linux", "amd64"); err == nil ||
		!strings.Contains(err.Error(), "checksum mismatch") {
		t.Fatalf("tampered archive: err = %v, want checksum mismatch", err)
	}
	if _, err := downloadBinary(client, rel, version, "darwin", "arm64"); err == nil {
		t.Fatal("expected an error for a missing platform build")
	}
}
