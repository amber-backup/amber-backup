package main

// Container archives for `pct restore`: the rootfs tree of a files snapshot
// (`restic dump --archive tar`) rewritten into the layout vzdump produces for
// CTs — paths relative to the container root ("./…"), the container config at
// ./etc/vzdump/pct.conf (first), and for unprivileged containers the owners
// shifted from host ids back to container ids.
//
// ASSUMPTION(pve): pct restore reads such a tar from stdin ("-") and, like a
// vzdump archive of an unprivileged CT, expects container-side ids in it.

import (
	"archive/tar"
	"errors"
	"io"
	"strings"
	"time"
)

// rewriteCTArchive copies the entries of src below prefix (a path without
// leading slash, as restic dump writes it) to dst as a vzdump-style CT archive.
func rewriteCTArchive(dst io.Writer, src io.Reader, prefix string, pctConf []byte, idmap []idMapEntry) error {
	prefix = strings.Trim(prefix, "/")
	tw := tar.NewWriter(dst)
	now := time.Now()
	for _, d := range []string{"./etc/", "./etc/vzdump/"} {
		if err := tw.WriteHeader(&tar.Header{Typeflag: tar.TypeDir, Name: d, Mode: 0o755, ModTime: now, Format: tar.FormatPAX}); err != nil {
			return err
		}
	}
	if err := tw.WriteHeader(&tar.Header{Typeflag: tar.TypeReg, Name: "./etc/vzdump/pct.conf", Mode: 0o600,
		Size: int64(len(pctConf)), ModTime: now, Format: tar.FormatPAX}); err != nil {
		return err
	}
	if _, err := tw.Write(pctConf); err != nil {
		return err
	}

	rel := func(name string) (string, bool) {
		n := strings.TrimPrefix(name, "/")
		n = strings.TrimSuffix(n, "/")
		if n == prefix {
			return "./", true
		}
		if strings.HasPrefix(n, prefix+"/") {
			return "./" + strings.TrimPrefix(n, prefix+"/"), true
		}
		return "", false
	}
	tr := tar.NewReader(src)
	found := false
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		name, ok := rel(h.Name)
		if !ok {
			continue
		}
		found = true
		if h.Typeflag == tar.TypeDir && name != "./" && !strings.HasSuffix(name, "/") {
			name += "/"
		}
		h.Name = name
		if h.Typeflag == tar.TypeLink {
			if l, ok := rel(h.Linkname); ok {
				h.Linkname = l
			}
		}
		h.Uid = int(hostToCT(idmap, "u", int64(h.Uid)))
		h.Gid = int(hostToCT(idmap, "g", int64(h.Gid)))
		h.Uname, h.Gname = "", ""
		h.Format = tar.FormatPAX
		if err := tw.WriteHeader(h); err != nil {
			return err
		}
		if h.Typeflag == tar.TypeReg {
			if _, err := io.Copy(tw, tr); err != nil {
				return err
			}
		}
	}
	if !found {
		return errors.New("the snapshot holds no container root at " + prefix)
	}
	return tw.Close()
}
