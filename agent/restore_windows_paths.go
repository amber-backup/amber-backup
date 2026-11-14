package main

import (
	"regexp"
	"sort"
	"strings"
)

// Restic stores Windows paths as /C/Users/…, one top-level directory per drive.
// Restoring "to the original location" therefore can't use a single --target
// (it would recreate C:\C\Users\…): each drive's subtree is restored with
// restic's <snapshot>:<subfolder> syntax into that drive's root.

var driveDirRE = regexp.MustCompile(`^/([A-Za-z])(/|$)`)

// isOriginalLocation reports whether a restore targets the original location;
// the server sends "/" for it.
func isOriginalLocation(target string) bool {
	return target == "" || target == "/"
}

// driveRestore is one restic restore of a drive's subtree.
type driveRestore struct {
	Drive    string   // "C"
	Snapshot string   // "<snapshot>:/C"
	Target   string   // `C:\`
	Includes []string // relative to the drive root, e.g. "/Users/bob"; empty = whole drive
	whole    bool
}

// driveOf returns the drive letter of a snapshot path like /C/Users, or "".
func driveOf(p string) string {
	m := driveDirRE.FindStringSubmatch(p)
	if m == nil {
		return ""
	}
	return strings.ToUpper(m[1])
}

// planDriveRestores splits an original-location restore into one restore per
// drive. With includes, only their drives are restored and each include is
// rewritten relative to its drive; without, every drive among topLevel (the
// snapshot's top-level directories) is restored whole. Paths outside a drive
// have no original location on Windows and are skipped.
func planDriveRestores(snapshot string, includes, topLevel []string) []driveRestore {
	byDrive := map[string]*driveRestore{}
	get := func(d string) *driveRestore {
		r, ok := byDrive[d]
		if !ok {
			r = &driveRestore{Drive: d, Snapshot: snapshot + ":/" + d, Target: d + `:\`}
			byDrive[d] = r
		}
		return r
	}
	if len(includes) > 0 {
		for _, inc := range includes {
			d := driveOf(inc)
			if d == "" {
				continue
			}
			r := get(d)
			if rel := strings.TrimRight(inc[2:], "/"); rel == "" {
				r.whole = true // "/C" itself: the whole drive
			} else {
				r.Includes = append(r.Includes, rel)
			}
		}
	} else {
		for _, p := range topLevel {
			if d := driveOf(p); d != "" {
				get(d).whole = true
			}
		}
	}
	out := make([]driveRestore, 0, len(byDrive))
	for _, r := range byDrive {
		if r.whole {
			r.Includes = nil
		}
		out = append(out, *r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Drive < out[j].Drive })
	return out
}
