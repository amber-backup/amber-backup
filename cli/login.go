package main

// `ambb login <server>` pairs this device with an Amber Backup account without
// handling an API key by hand: the server issues a short code, the user
// approves it in the browser, and the CLI receives and stores a new API key.
// `ambb logout` revokes that key on the server and forgets it locally.

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
	"time"
)

var (
	userCodeRE   = regexp.MustCompile(`^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$`)
	clientNameRE = regexp.MustCompile(`[^\p{L}\p{N} ._@()-]+`)
)

type deviceCodeResponse struct {
	DeviceCode string `json:"deviceCode"`
	UserCode   string `json:"userCode"`
	ExpiresIn  int    `json:"expiresIn"`
	Interval   int    `json:"interval"`
}

type deviceTokenResponse struct {
	Status    string `json:"status"`
	APIKey    string `json:"apiKey"`
	Email     string `json:"email"`
	Access    string `json:"access"`
	ExpiresAt string `json:"expiresAt"`
}

// defaultClientName is this machine's hostname, reduced to the characters the
// server accepts for display.
func defaultClientName() string {
	host, _ := os.Hostname()
	return sanitizeClientName(host)
}

func sanitizeClientName(name string) string {
	name = strings.TrimSpace(clientNameRE.ReplaceAllString(name, "-"))
	if len([]rune(name)) > 64 {
		name = string([]rune(name)[:64])
	}
	if name == "" {
		return "ambb"
	}
	return name
}

// verificationURL is the approval page for userCode on the server at base.
func verificationURL(base, userCode string) string {
	return base + "/#/device?code=" + url.QueryEscape(userCode)
}

// openBrowser tries to show rawURL in the desktop browser. The URL is passed
// as a single argument (no shell), and failures are silent: the URL is printed
// for the user either way.
func openBrowser(rawURL string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", rawURL)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", rawURL)
	default:
		// Headless (e.g. an SSH session): nothing to open.
		if os.Getenv("DISPLAY") == "" && os.Getenv("WAYLAND_DISPLAY") == "" {
			return
		}
		cmd = exec.Command("xdg-open", rawURL)
	}
	if err := cmd.Start(); err == nil {
		go func() { _ = cmd.Wait() }()
	}
}

// runLogin implements `ambb login <server>`.
func runLogin(cfg *Config, server string) error {
	if server == "" {
		server = cfg.URL
	}
	if server == "" {
		return usageErrorf("login requires a server, e.g. ambb login amber.example.com")
	}
	base, err := normalizeServerURL(server)
	if err != nil {
		return usageErrorf("%s", err)
	}
	if strings.HasPrefix(base, "http://") && !isLoopbackURL(base) && !cfg.Flags.InsecureHTTP {
		return fmt.Errorf(
			"refusing to log in over plain HTTP to %s: the issued API key would travel unencrypted. "+
				"Use https:// or pass --insecure-http", base)
	}

	name := defaultClientName()
	if cfg.Flags.Name != nil {
		name = sanitizeClientName(*cfg.Flags.Name)
	}

	// Load the store first so a broken or insecure file fails before pairing.
	store, err := loadCredentials()
	if err != nil {
		return err
	}

	client := NewClient(&Config{URL: base})
	data, err := client.do(http.MethodPost, "/auth/device/code", map[string]string{"clientName": name})
	if err != nil {
		return fmt.Errorf("start login: %w", err)
	}
	var code deviceCodeResponse
	if err := json.Unmarshal(data, &code); err != nil {
		return fmt.Errorf("start login: unexpected response: %w", err)
	}
	if code.DeviceCode == "" || !userCodeRE.MatchString(code.UserCode) {
		return errors.New("start login: the server returned an invalid pairing code")
	}
	interval := time.Duration(max(code.Interval, 1)) * time.Second
	deadline := time.Now().Add(time.Duration(max(code.ExpiresIn, 60)) * time.Second)

	link := verificationURL(base, code.UserCode)
	fmt.Printf("To sign in %q, open this page and approve the request:\n\n", name)
	fmt.Printf("  %s\n\n", link)
	fmt.Printf("Confirm that the page shows this code: %s\n\n", code.UserCode)
	if !cfg.Flags.NoBrowser {
		openBrowser(link)
	}
	fmt.Println("Waiting for approval (Ctrl-C to cancel)...")

	for {
		time.Sleep(interval)
		if time.Now().After(deadline) {
			return errors.New("the login request expired; run ambb login again")
		}
		data, err := client.do(http.MethodPost, "/auth/device/token",
			map[string]string{"deviceCode": code.DeviceCode})
		if err != nil {
			var apiErr *apiError
			if errors.As(err, &apiErr) && apiErr.status == http.StatusTooManyRequests {
				interval += 5 * time.Second
				continue
			}
			return fmt.Errorf("wait for approval: %w", err)
		}
		var tok deviceTokenResponse
		if err := json.Unmarshal(data, &tok); err != nil {
			return fmt.Errorf("wait for approval: unexpected response: %w", err)
		}
		switch tok.Status {
		case "pending":
		case "slow_down":
			interval += 5 * time.Second
		case "denied":
			return errors.New("the login request was denied")
		case "expired":
			return errors.New("the login request expired or was already used; run ambb login again")
		case "approved":
			if !strings.HasPrefix(tok.APIKey, "ak_") {
				return errors.New("the server returned an invalid API key")
			}
			store.Servers[base] = storedLogin{
				APIKey:    tok.APIKey,
				Email:     tok.Email,
				Access:    tok.Access,
				ExpiresAt: tok.ExpiresAt,
			}
			store.Current = base
			if err := store.save(); err != nil {
				return fmt.Errorf("save credentials: %w", err)
			}
			path, _ := credentialsPath()
			expiry := "never expires"
			if tok.ExpiresAt != "" {
				if t, err := time.Parse(time.RFC3339, tok.ExpiresAt); err == nil {
					expiry = "expires " + t.Local().Format("2006-01-02")
				}
			}
			fmt.Printf("\nLogged in to %s as %s (%s access, key %s).\nCredentials saved to %s\n",
				base, tok.Email, tok.Access, expiry, path)
			return nil
		default:
			return fmt.Errorf("wait for approval: unexpected status %q", tok.Status)
		}
	}
}

// runLogout implements `ambb logout [server]`: revoke the stored key on the
// server, then remove it locally (also when the server no longer knows it).
func runLogout(cfg *Config, server string) error {
	store, err := loadCredentials()
	if err != nil {
		return err
	}
	if server == "" {
		server = cfg.URL
	}
	base := store.Current
	if server != "" {
		if base, err = normalizeServerURL(server); err != nil {
			return usageErrorf("%s", err)
		}
	}
	login, ok := store.Servers[base]
	if base == "" {
		return errors.New("not logged in")
	}
	if !ok {
		return fmt.Errorf("not logged in to %s", base)
	}

	client := NewClient(&Config{URL: base, APIKey: login.APIKey})
	_, revokeErr := client.do(http.MethodDelete, "/auth/device/key", nil)
	var apiErr *apiError
	if revokeErr != nil && !(errors.As(revokeErr, &apiErr) && apiErr.status == http.StatusUnauthorized) {
		// Unreachable server or unexpected error: keep the local copy so the
		// user can retry instead of losing track of a still-valid key.
		return fmt.Errorf("revoke API key on %s: %w (credentials kept; retry, or revoke the key under Settings → API keys)", base, revokeErr)
	}

	delete(store.Servers, base)
	if store.Current == base {
		store.Current = ""
	}
	if err := store.save(); err != nil {
		return fmt.Errorf("save credentials: %w", err)
	}
	fmt.Printf("Logged out of %s\n", base)
	return nil
}
