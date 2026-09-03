package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// stdinReader stands in for reading a password from stdin.
func stdinReader(s string) func() (string, error) {
	return func() (string, error) { return s, nil }
}

func encode(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(b)
}

func TestCredentialPayloadSetsGivenFields(t *testing.T) {
	flags := &CommandFlags{Username: strPtr("job-user"), Password: strPtr("job-pw")}

	body, err := buildCredentialPayload(flags, stdinReader(""))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if got, want := encode(t, body), `{"repoCredentials":{"password":"job-pw","username":"job-user"}}`; got != want {
		t.Errorf("payload = %s, want %s", got, want)
	}
}

func TestCredentialPayloadSendsOnlyWhatWasGiven(t *testing.T) {
	flags := &CommandFlags{Password: strPtr("only-pw")}

	body, err := buildCredentialPayload(flags, stdinReader(""))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if got, want := encode(t, body), `{"repoCredentials":{"password":"only-pw"}}`; got != want {
		t.Errorf("payload = %s, want %s", got, want)
	}
}

func TestCredentialPayloadClearSendsNull(t *testing.T) {
	body, err := buildCredentialPayload(&CommandFlags{Clear: true}, stdinReader(""))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if got, want := encode(t, body), `{"repoCredentials":null}`; got != want {
		t.Errorf("payload = %s, want %s", got, want)
	}
}

func TestCredentialPayloadReadsPasswordFromStdin(t *testing.T) {
	flags := &CommandFlags{PasswordStdin: true}

	body, err := buildCredentialPayload(flags, stdinReader("piped-pw"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if got, want := encode(t, body), `{"repoCredentials":{"password":"piped-pw"}}`; got != want {
		t.Errorf("payload = %s, want %s", got, want)
	}
}

func TestCredentialPayloadRejectsClearWithValues(t *testing.T) {
	flags := &CommandFlags{Clear: true, Username: strPtr("u")}

	if _, err := buildCredentialPayload(flags, stdinReader("")); err == nil {
		t.Fatal("expected an error when --clear is combined with a value")
	}
}

func TestCredentialPayloadRejectsBothPasswordSources(t *testing.T) {
	flags := &CommandFlags{Password: strPtr("p"), PasswordStdin: true}

	if _, err := buildCredentialPayload(flags, stdinReader("")); err == nil {
		t.Fatal("expected an error when both password sources are given")
	}
}

func TestCredentialPayloadRejectsEmptyRequest(t *testing.T) {
	if _, err := buildCredentialPayload(&CommandFlags{}, stdinReader("")); err == nil {
		t.Fatal("expected an error when no credential flag is given")
	}
}

func TestParseArgsCollectsCredentialFlags(t *testing.T) {
	cfg := &Config{}
	positionals, err := parseArgs(
		[]string{"job", "credentials", "daily", "--username=u", "--password", "p", "--clear"},
		cfg,
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if strings.Join(positionals, " ") != "job credentials daily" {
		t.Errorf("positionals = %v", positionals)
	}
	if cfg.Flags.Username == nil || *cfg.Flags.Username != "u" {
		t.Errorf("username = %v", cfg.Flags.Username)
	}
	if cfg.Flags.Password == nil || *cfg.Flags.Password != "p" {
		t.Errorf("password = %v", cfg.Flags.Password)
	}
	if !cfg.Flags.Clear {
		t.Error("clear flag not set")
	}
}
