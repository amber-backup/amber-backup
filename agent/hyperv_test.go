package main

import (
	"reflect"
	"testing"
)

func TestSelectVMs(t *testing.T) {
	inv := &HypervInventory{VMs: []HypervVM{
		{ID: "AAAAAAAA-0000-0000-0000-000000000001", Name: "web"},
		{ID: "aaaaaaaa-0000-0000-0000-000000000002", Name: "DC"},
		{ID: "aaaaaaaa-0000-0000-0000-000000000003", Name: "app"},
	}}
	names := func(vms []HypervVM) []string {
		var out []string
		for _, v := range vms {
			out = append(out, v.Name)
		}
		return out
	}

	all, missing := selectVMs(inv, &HypervTask{AllVMs: true, ExcludeVMIDs: []string{"aaaaaaaa-0000-0000-0000-000000000001"}})
	if got := names(all); !reflect.DeepEqual(got, []string{"app", "DC"}) || missing != nil {
		t.Fatalf("all minus excluded = %v (missing %v)", got, missing)
	}

	some, missing := selectVMs(inv, &HypervTask{VMIDs: []string{"aaaaaaaa-0000-0000-0000-000000000001", "bbbbbbbb-0000-0000-0000-000000000009"}})
	if got := names(some); !reflect.DeepEqual(got, []string{"web"}) {
		t.Fatalf("selected = %v", got)
	}
	if !reflect.DeepEqual(missing, []string{"bbbbbbbb-0000-0000-0000-000000000009"}) {
		t.Fatalf("missing = %v", missing)
	}
}

func TestFindRestoredPathMatchesLongestSuffix(t *testing.T) {
	files := []string{
		"/stage/D/VMs/web/Virtual Hard Disks/disk0.vhdx",
		"/stage/D/VMs/db/Virtual Hard Disks/disk0.vhdx",
		"/stage/C/ProgramData/AmberAgent/hyperv/x/amber-vm.json",
	}
	got := findRestoredPath(files, `D:\VMs\db\Virtual Hard Disks\disk0.vhdx`)
	if got != files[1] {
		t.Fatalf("got %q", got)
	}
	// A UNC path read by a proxy lands under another prefix; the suffix still matches.
	got = findRestoredPath([]string{`/stage/\\hv01\D$/VMs/db/Virtual Hard Disks/disk0.vhdx`}, `D:\VMs\db\Virtual Hard Disks\disk0.vhdx`)
	if got == "" {
		t.Fatal("UNC-restored file not found")
	}
	if findRestoredPath(files, `E:\other\thing.vhdx`) != "" {
		t.Fatal("matched a file with a different name")
	}
}

func TestAgentPathFor(t *testing.T) {
	remote := HypervConnection{Mode: "remote", Address: "hv01.corp.local"}
	if got := agentPathFor(remote, `d:\VMs\a.vhdx`); got != `\\hv01.corp.local\D$\VMs\a.vhdx` {
		t.Fatalf("remote path = %q", got)
	}
	if got := agentPathFor(HypervConnection{Mode: "local"}, `D:\VMs\a.vhdx`); got != `D:\VMs\a.vhdx` {
		t.Fatalf("local path = %q", got)
	}
}

func TestHypervForgetGroupsPerVM(t *testing.T) {
	keep := 7
	args := hypervForgetArgs(&Retention{KeepDaily: &keep})
	want := []string{"forget", "--json", "--keep-daily", "7", "--tag", "amber-hyperv", "--group-by", "host,tags"}
	if !reflect.DeepEqual(args, want) {
		t.Fatalf("args = %v", args)
	}
}

func TestHypervBackupArgs(t *testing.T) {
	task := &Task{Options: &ResticOptions{Tags: []string{"prod"}, Compression: "max"}}
	vm := HypervVM{ID: "AAAAAAAA-0000-0000-0000-000000000001"}
	args := hypervBackupArgs(task, "HV01", vm, []string{"/m.json", `D:\a.vhdx`}, true)
	want := []string{"backup", "--json", "--host", "HV01", "--tag", "amber-hyperv",
		"--tag", "vm:aaaaaaaa-0000-0000-0000-000000000001", "--tag", "prod", "--compression", "max"}
	if supportsFsSnapshot() {
		want = append(want, "--use-fs-snapshot")
	}
	want = append(want, "--", "/m.json", `D:\a.vhdx`)
	if !reflect.DeepEqual(args, want) {
		t.Fatalf("args = %v\nwant %v", args, want)
	}
}

func TestParsePSResult(t *testing.T) {
	out := []byte("WARNING: noise\r\nAMBER-RESULT:{\"ok\":true,\"data\":{\"id\":\"x\"}}\r\n")
	r, err := parsePSResult(out)
	if err != nil || !r.OK || string(r.Data) != `{"id":"x"}` {
		t.Fatalf("r=%+v err=%v", r, err)
	}
	if _, err := parsePSResult([]byte("Get-VM : not recognized")); err == nil {
		t.Fatal("output without a result line parsed")
	}
}

func TestJoinHostPathKeepsSeparator(t *testing.T) {
	if got := joinHostPath(`D:\Restore\`, "web (restored)"); got != `D:\Restore\web (restored)` {
		t.Fatalf("windows join = %q", got)
	}
	if got := joinHostPath("/tmp/r", "x"); got != "/tmp/r/x" {
		t.Fatalf("posix join = %q", got)
	}
}

func TestMockConnectNeedsRemoteCredentials(t *testing.T) {
	m := &mockHyperv{dir: t.TempDir()}
	if _, err := m.Connect(nil, HypervConnection{Mode: "remote", Address: "hv"}); err == nil {
		t.Fatal("remote connection without credentials accepted")
	}
}
