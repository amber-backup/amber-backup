//go:build linux

package main

// FUSE view of a block snapshot's disks as raw images (concatImage), plus
// the Linux-only helpers around it: `restic mount` of the repository and
// ownership-preserving copies.

import (
	"context"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	gofs "github.com/hanwen/go-fuse/v2/fs"
	"github.com/hanwen/go-fuse/v2/fuse"
)

type concatRoot struct {
	gofs.Inode
	imgs []*concatImage
	now  time.Time
}

type concatFile struct {
	gofs.Inode
	img *concatImage
	now time.Time
}

var (
	_ gofs.NodeOnAdder   = (*concatRoot)(nil)
	_ gofs.NodeGetattrer = (*concatRoot)(nil)
	_ gofs.NodeGetattrer = (*concatFile)(nil)
	_ gofs.NodeOpener    = (*concatFile)(nil)
	_ gofs.NodeReader    = (*concatFile)(nil)
)

func (r *concatRoot) OnAdd(ctx context.Context) {
	for i, img := range r.imgs {
		ch := r.NewPersistentInode(ctx, &concatFile{img: img, now: r.now},
			gofs.StableAttr{Mode: fileMode, Ino: uint64(2 + i)})
		r.AddChild(imageName(img.Key), ch, false)
	}
}

func (r *concatRoot) Getattr(ctx context.Context, fh gofs.FileHandle, out *fuse.AttrOut) syscall.Errno {
	out.Mode = dirMode
	setTimes(&out.Attr, r.now)
	return 0
}

func (f *concatFile) Getattr(ctx context.Context, fh gofs.FileHandle, out *fuse.AttrOut) syscall.Errno {
	out.Mode = fileMode
	out.Size = uint64(f.img.Size)
	out.Blksize = 1 << 16
	out.Blocks = (uint64(f.img.Size) + 511) / 512
	setTimes(&out.Attr, f.now)
	return 0
}

func (f *concatFile) Open(ctx context.Context, flags uint32) (gofs.FileHandle, uint32, syscall.Errno) {
	if flags&(syscall.O_WRONLY|syscall.O_RDWR) != 0 {
		return nil, 0, syscall.EROFS
	}
	// ASSUMPTION(pve): QEMU opens a backing file with O_DIRECT for cache=none
	// drives; answering such an open with FOPEN_DIRECT_IO keeps it working.
	if flags&syscall.O_DIRECT != 0 {
		return nil, fuse.FOPEN_DIRECT_IO, 0
	}
	return nil, fuse.FOPEN_KEEP_CACHE, 0
}

func (f *concatFile) Read(ctx context.Context, fh gofs.FileHandle, dest []byte, off int64) (fuse.ReadResult, syscall.Errno) {
	n, err := f.img.ReadAt(dest, off)
	if err != nil && err != io.EOF {
		return nil, syscall.EIO
	}
	return fuse.ReadResultData(dest[:n]), 0
}

// mountConcatView serves the images read-only as <dir>/<key>.raw.
func mountConcatView(dir string, imgs []*concatImage) (func() error, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	timeout := time.Minute
	server, err := gofs.Mount(dir, &concatRoot{imgs: imgs, now: time.Now()}, &gofs.Options{
		MountOptions: fuse.MountOptions{
			FsName:       "amber-pve-img",
			Name:         "amberimg",
			Options:      []string{"ro"},
			MaxReadAhead: 1 << 20,
		},
		EntryTimeout: &timeout,
		AttrTimeout:  &timeout,
		UID:          uint32(os.Getuid()),
		GID:          uint32(os.Getgid()),
	})
	if err != nil {
		return nil, fmt.Errorf("mounting the disk image view at %s: %w", dir, err)
	}
	return func() error {
		err := server.Unmount()
		if err != nil {
			if derr := unmountDetach(dir); derr == nil {
				err = nil
			}
		}
		server.Wait()
		for _, img := range imgs {
			img.Close()
		}
		return err
	}, nil
}

// startResticMount runs `restic mount` at dir until the returned stop func;
// it returns once the mount serves the repository.
func (a *agent) startResticMount(ctx context.Context, t *Task, dir string, appendLog func(string)) (func(), error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	workDir, err := os.MkdirTemp(tempBaseDir(), "amber-restic-")
	if err != nil {
		return nil, err
	}
	r := a.runner
	env, credPaths, err := r.prepareEnv(t, workDir)
	if err != nil {
		os.RemoveAll(workDir)
		return nil, err
	}
	os.MkdirAll(r.cacheDir, 0o700)
	args := append(substituteCredentialPaths(t.ExtraArgs, credPaths), "mount", dir)
	// Not CommandContext: the mount must outlive ctx until stop unmounts it.
	cmd := exec.Command(r.binary, args...)
	cmd.Env = env
	var out strings.Builder
	cmd.Stdout, cmd.Stderr = &out, &out
	if err := cmd.Start(); err != nil {
		os.RemoveAll(workDir)
		return nil, err
	}
	exited := make(chan struct{})
	go func() { cmd.Wait(); close(exited) }()
	stop := func() {
		select {
		case <-exited:
		default:
			cmd.Process.Signal(os.Interrupt)
			select {
			case <-exited:
			case <-time.After(15 * time.Second):
				unmountDetach(dir)
				cmd.Process.Kill()
				<-exited
			}
		}
		if len(mountsBelow(dir)) > 0 {
			unmountDetach(dir)
		}
		os.RemoveAll(workDir)
	}
	ready := waitFor(2*time.Minute, func() bool {
		select {
		case <-exited:
			return true
		default:
		}
		if ctx.Err() != nil {
			return true
		}
		_, err := os.Stat(filepath.Join(dir, "ids"))
		return err == nil
	})
	select {
	case <-exited:
		stop()
		return nil, fmt.Errorf("restic mount exited: %s", strings.TrimSpace(out.String()))
	default:
	}
	if ctx.Err() != nil || !ready {
		stop()
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fmt.Errorf("restic mount did not come up: %s", strings.TrimSpace(out.String()))
	}
	appendLog("repository mounted at " + dir)
	return stop, nil
}

// snapshotMountDir finds a snapshot below a restic mount's ids/ directory
// (restic names it by its short id there).
func snapshotMountDir(mount, id string) (string, error) {
	entries, err := os.ReadDir(filepath.Join(mount, "ids"))
	if err != nil {
		return "", err
	}
	for _, e := range entries {
		if strings.HasPrefix(id, e.Name()) || strings.HasPrefix(e.Name(), id) {
			return filepath.Join(mount, "ids", e.Name()), nil
		}
	}
	return "", fmt.Errorf("snapshot %s not found in the mounted repository", id)
}

// chownLike gives dst the owner of info's file when running as root.
func chownLike(dst string, info fs.FileInfo, link bool) {
	if os.Geteuid() != 0 {
		return
	}
	sys, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return
	}
	if link {
		os.Lchown(dst, int(sys.Uid), int(sys.Gid))
	} else {
		os.Chown(dst, int(sys.Uid), int(sys.Gid))
	}
}

func mountsBelowOrNone(dir string) []string { return mountsBelow(dir) }
