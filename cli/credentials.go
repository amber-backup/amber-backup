package main

// Local credential store for `ambb login`: one API key per server, kept in a
// JSON file only the current user can read (like ~/.ssh). A stored key is only
// ever sent to the server it was issued by — lookups are keyed by the
// normalized server URL.

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// storedLogin is one server's credentials.
type storedLogin struct {
	APIKey    string `json:"apiKey"`
	Email     string `json:"email,omitempty"`
	Access    string `json:"access,omitempty"`
	ExpiresAt string `json:"expiresAt,omitempty"`
}

// credentialStore is the on-disk file format.
type credentialStore struct {
	// Current is the server used when no --url/AMBER_URL is given.
	Current string                 `json:"current,omitempty"`
	Servers map[string]storedLogin `json:"servers"`
}

// credentialsPath returns the credential file location: $AMBB_CONFIG_DIR, or
// the OS user config directory (e.g. ~/.config/ambb on Linux).
func credentialsPath() (string, error) {
	dir := os.Getenv("AMBB_CONFIG_DIR")
	if dir == "" {
		base, err := os.UserConfigDir()
		if err != nil {
			return "", fmt.Errorf("locate config directory: %w", err)
		}
		dir = filepath.Join(base, "ambb")
	}
	return filepath.Join(dir, "credentials.json"), nil
}

// loadCredentials reads the store; a missing file is an empty store. On Unix a
// file readable by other users is refused rather than trusted.
func loadCredentials() (*credentialStore, error) {
	store := &credentialStore{Servers: map[string]storedLogin{}}
	path, err := credentialsPath()
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return store, nil
	}
	if err != nil {
		return nil, err
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0 {
		return nil, fmt.Errorf(
			"%s is accessible by other users (mode %o); run: chmod 600 %s",
			path, info.Mode().Perm(), path)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(data, store); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	if store.Servers == nil {
		store.Servers = map[string]storedLogin{}
	}
	return store, nil
}

// save writes the store atomically with owner-only permissions.
func (s *credentialStore) save() error {
	path, err := credentialsPath()
	if err != nil {
		return err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".credentials-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name()) // no-op once renamed away
	if err := tmp.Chmod(0o600); err != nil && runtime.GOOS != "windows" {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(append(data, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// normalizeServerURL turns user input ("amber.example.com", "https://host/x/")
// into a canonical base URL: https by default, no trailing slash, no query,
// fragment or embedded credentials.
func normalizeServerURL(input string) (string, error) {
	raw := strings.TrimSpace(input)
	if raw == "" {
		return "", errors.New("empty server URL")
	}
	if !strings.Contains(raw, "://") {
		raw = "https://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("invalid server URL %q: %w", input, err)
	}
	if u.Scheme != "https" && u.Scheme != "http" {
		return "", fmt.Errorf("invalid server URL %q: scheme must be https or http", input)
	}
	if u.Hostname() == "" {
		return "", fmt.Errorf("invalid server URL %q: missing host", input)
	}
	if u.User != nil {
		return "", fmt.Errorf("invalid server URL %q: must not contain credentials", input)
	}
	u.Scheme = strings.ToLower(u.Scheme)
	u.Host = strings.ToLower(u.Host)
	u.RawQuery, u.Fragment, u.RawFragment = "", "", ""
	u.Path = strings.TrimRight(u.Path, "/")
	u.RawPath = ""
	return u.String(), nil
}

// isLoopbackURL reports whether the server runs on this machine, where plain
// HTTP cannot be intercepted on the network.
func isLoopbackURL(base string) bool {
	u, err := url.Parse(base)
	if err != nil {
		return false
	}
	host := u.Hostname()
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
