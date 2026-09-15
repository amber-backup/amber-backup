package main

import (
	"fmt"
	"os"
	"strings"
)

// Version of the ambb CLI. Kept in sync with the server release line: release
// builds inject the tag via -ldflags "-X main.Version=<version>".
var Version = "dev"

// OutputFormat controls how command results are rendered.
type OutputFormat string

const (
	FormatText OutputFormat = "text"
	FormatJSON OutputFormat = "json"
)

// CommandFlags holds the flags a single command accepts. They are parsed by the
// same pass as the global flags (which may appear anywhere, so the command is
// not yet known) and validated by the command that accepts them; a command that
// does not accept them rejects their use.
type CommandFlags struct {
	// Username and Password are nil when the flag was not given at all, which
	// is what keeps a stored value untouched.
	Username      *string
	Password      *string
	PasswordStdin bool
	Clear         bool

	// Check and Force belong to 'update'.
	Check bool
	Force bool

	// Name, NoBrowser and InsecureHTTP belong to 'login'.
	Name         *string
	NoBrowser    bool
	InsecureHTTP bool

	// Method and Expires belong to 'agent create'; Expires is the raw
	// --expires value (minutes), validated by the command.
	Method  *string
	Expires *string
}

// credentialsUsed reports whether any 'job credentials' flag was given.
func (f *CommandFlags) credentialsUsed() bool {
	return f.Username != nil || f.Password != nil || f.PasswordStdin || f.Clear
}

// updateUsed reports whether any 'update' flag was given.
func (f *CommandFlags) updateUsed() bool {
	return f.Check || f.Force
}

// loginUsed reports whether any 'login' flag was given.
func (f *CommandFlags) loginUsed() bool {
	return f.Name != nil || f.NoBrowser || f.InsecureHTTP
}

// agentCreateUsed reports whether any 'agent create' flag was given.
func (f *CommandFlags) agentCreateUsed() bool {
	return f.Method != nil || f.Expires != nil
}

// rejectFlagsExcept fails when a command flag belonging to another command
// than `allowed` ("credentials", "agent-create", "update", "login" or "") was
// given.
func (f *CommandFlags) rejectFlagsExcept(allowed string) error {
	if allowed != "credentials" && f.credentialsUsed() {
		return usageErrorf("--username/--password/--password-stdin/--clear are only valid for 'job credentials'")
	}
	if allowed != "update" && f.updateUsed() {
		return usageErrorf("--check/--force are only valid for 'update'")
	}
	if allowed != "login" && f.loginUsed() {
		return usageErrorf("--name/--no-browser/--insecure-http are only valid for 'login'")
	}
	if allowed != "agent-create" && f.agentCreateUsed() {
		return usageErrorf("--method/--expires are only valid for 'agent create'")
	}
	return nil
}

// strPtr returns a pointer to v (flag values are optional by pointer).
func strPtr(v string) *string { return &v }

// Config is the resolved runtime configuration, merged from CLI flags and
// environment variables (flags win).
type Config struct {
	URL    string
	APIKey string
	Format OutputFormat
	Flags  CommandFlags
}

// firstEnv returns the first non-empty value among the given env vars.
func firstEnv(keys ...string) string {
	for _, k := range keys {
		if v := strings.TrimSpace(os.Getenv(k)); v != "" {
			return v
		}
	}
	return ""
}

// resolve fills in URL and APIKey from the environment when the flags left them
// empty, normalizes the base URL, and validates the output format.
func (c *Config) resolve() error {
	if c.URL == "" {
		c.URL = firstEnv("AMBB_URL", "AMBER_URL")
	}
	if c.APIKey == "" {
		c.APIKey = firstEnv("AMBB_API_KEY", "AMBER_API_KEY")
	}
	if c.Format == "" {
		if f := firstEnv("AMBB_OUTPUT_FORMAT"); f != "" {
			c.Format = OutputFormat(f)
		} else {
			c.Format = FormatText
		}
	}

	c.URL = strings.TrimRight(strings.TrimSpace(c.URL), "/")

	switch c.Format {
	case FormatText, FormatJSON:
	default:
		return fmt.Errorf("invalid --output-format %q (want: text or json)", c.Format)
	}
	return nil
}

// requireCredentials ensures the URL and API key are present before a request.
// Without an explicit API key it falls back to the credentials saved by
// `ambb login` — for the given server only, or for the current login when no
// server was given — so a stored key never reaches another server.
func (c *Config) requireCredentials() error {
	if c.APIKey == "" {
		store, err := loadCredentials()
		if err != nil {
			return err
		}
		if c.URL == "" {
			c.URL = store.Current
		}
		if c.URL != "" {
			if base, err := normalizeServerURL(c.URL); err == nil {
				if login, ok := store.Servers[base]; ok {
					c.URL, c.APIKey = base, login.APIKey
				}
			}
		}
	}
	if c.URL == "" {
		return fmt.Errorf("no server: run 'ambb login <server>', or pass --url or set AMBER_URL")
	}
	if c.APIKey == "" {
		return fmt.Errorf("not logged in to %s: run 'ambb login %s', or pass --api-key or set AMBER_API_KEY", c.URL, c.URL)
	}
	return nil
}
