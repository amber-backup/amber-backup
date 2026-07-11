package main

import (
	"fmt"
	"os"
	"strings"
)

// Version of the ambb CLI. Kept in sync with the server release line.
const Version = "0.1.0"

// OutputFormat controls how command results are rendered.
type OutputFormat string

const (
	FormatText OutputFormat = "text"
	FormatJSON OutputFormat = "json"
)

// Config is the resolved runtime configuration, merged from CLI flags and
// environment variables (flags win).
type Config struct {
	URL    string
	APIKey string
	Format OutputFormat
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
func (c *Config) requireCredentials() error {
	if c.URL == "" {
		return fmt.Errorf("no server URL: pass --url or set AMBER_URL")
	}
	if c.APIKey == "" {
		return fmt.Errorf("no API key: pass --api-key or set AMBER_API_KEY")
	}
	return nil
}
