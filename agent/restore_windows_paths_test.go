package main

import (
	"reflect"
	"testing"
)

func TestPlanDriveRestoresWholeSnapshot(t *testing.T) {
	got := planDriveRestores("abc", nil, []string{"/D", "/C", "/not-a-drive"})
	want := []driveRestore{
		{Drive: "C", Snapshot: "abc:/C", Target: `C:\`, whole: true},
		{Drive: "D", Snapshot: "abc:/D", Target: `D:\`, whole: true},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("plan = %+v\nwant %+v", got, want)
	}
}

func TestPlanDriveRestoresIncludesRelativeToDrive(t *testing.T) {
	got := planDriveRestores("abc", []string{"/C/Users/bob", "/c/Data/x.txt", "/D", "/D/ignored", "relative"}, nil)
	want := []driveRestore{
		{Drive: "C", Snapshot: "abc:/C", Target: `C:\`, Includes: []string{"/Users/bob", "/Data/x.txt"}},
		// "/D" restores the whole drive, so its narrower include is moot.
		{Drive: "D", Snapshot: "abc:/D", Target: `D:\`, whole: true},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("plan = %+v\nwant %+v", got, want)
	}
}

func TestRestoreArgsForSubfolder(t *testing.T) {
	got := restoreArgsFor("abc:/C", `C:\`, []string{"/Users/bob"}, &RestoreOptions{Overwrite: "if-newer"})
	want := []string{"restore", "--json", "--target", `C:\`, "--overwrite", "if-newer", "--include", "/Users/bob", "--", "abc:/C"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("args = %v\nwant %v", got, want)
	}
}

func TestAddRestoreStats(t *testing.T) {
	a := restoreSummaryToStats(map[string]any{"total_files": float64(2), "total_bytes": float64(10)})
	b := restoreSummaryToStats(map[string]any{"total_files": float64(3), "total_bytes": float64(5)})
	sum := addRestoreStats(addRestoreStats(nil, a), b)
	if sum["totalFiles"] != float64(5) || sum["totalBytesProcessed"] != float64(15) {
		t.Fatalf("sum = %v", sum)
	}
}
