package main

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"text/tabwriter"
)

// column maps a display header to the JSON field it renders.
type column struct {
	header string
	field  string
}

// renderList prints a JSON array either as pretty JSON or as a text table using
// the given columns.
func renderList(cfg *Config, value any, cols []column) error {
	if cfg.Format == FormatJSON {
		return printJSON(value)
	}

	rows, ok := value.([]any)
	if !ok {
		// Not an array — fall back to a single record view.
		return renderRecord(cfg, value)
	}
	if len(rows) == 0 {
		fmt.Fprintln(os.Stderr, "(no results)")
		return nil
	}

	tw := tabwriter.NewWriter(os.Stdout, 0, 4, 2, ' ', 0)
	headers := make([]string, len(cols))
	for i, c := range cols {
		headers[i] = c.header
	}
	fmt.Fprintln(tw, strings.Join(headers, "\t"))

	for _, r := range rows {
		obj, _ := r.(map[string]any)
		cells := make([]string, len(cols))
		for i, c := range cols {
			cells[i] = stringify(obj[c.field])
		}
		fmt.Fprintln(tw, strings.Join(cells, "\t"))
	}
	return tw.Flush()
}

// renderRecord prints a single object either as pretty JSON or as an aligned
// key/value block in a stable, readable order.
func renderRecord(cfg *Config, value any) error {
	if cfg.Format == FormatJSON {
		return printJSON(value)
	}

	obj, ok := value.(map[string]any)
	if !ok {
		fmt.Println(stringify(value))
		return nil
	}

	tw := tabwriter.NewWriter(os.Stdout, 0, 4, 2, ' ', 0)
	for _, key := range orderedKeys(obj) {
		fmt.Fprintf(tw, "%s\t%s\n", key, stringify(obj[key]))
	}
	return tw.Flush()
}

// orderedKeys returns the object's keys with a few well-known identifiers
// hoisted to the top, then the rest alphabetically.
func orderedKeys(obj map[string]any) []string {
	priority := []string{"id", "name", "status", "enabled"}
	seen := map[string]bool{}
	var keys []string
	for _, p := range priority {
		if _, ok := obj[p]; ok {
			keys = append(keys, p)
			seen[p] = true
		}
	}
	var rest []string
	for k := range obj {
		if !seen[k] {
			rest = append(rest, k)
		}
	}
	sort.Strings(rest)
	return append(keys, rest...)
}

// stringify renders a JSON value as a compact, terminal-friendly string.
func stringify(v any) string {
	switch t := v.(type) {
	case nil:
		return "-"
	case string:
		if t == "" {
			return "-"
		}
		return t
	case bool:
		return strconv.FormatBool(t)
	case float64:
		// Integers should not print with a trailing ".0".
		if t == float64(int64(t)) {
			return strconv.FormatInt(int64(t), 10)
		}
		return strconv.FormatFloat(t, 'f', -1, 64)
	case []any:
		if len(t) == 0 {
			return "-"
		}
		b, _ := json.Marshal(t)
		return string(b)
	case map[string]any:
		if len(t) == 0 {
			return "-"
		}
		b, _ := json.Marshal(t)
		return string(b)
	default:
		b, _ := json.Marshal(t)
		return string(b)
	}
}

// printJSON writes an indented JSON representation of value to stdout.
func printJSON(value any) error {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(value)
}
