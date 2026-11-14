//go:build !linux

package main

import (
	"context"
	"errors"
	"io/fs"
)

var errNoConcatView = errors.New("disk image views need Linux (FUSE)")

func mountConcatView(dir string, imgs []*concatImage) (func() error, error) {
	return nil, errNoConcatView
}

func (a *agent) startResticMount(ctx context.Context, t *Task, dir string, appendLog func(string)) (func(), error) {
	return nil, errNoConcatView
}

func snapshotMountDir(mount, id string) (string, error) { return "", errNoConcatView }

func chownLike(dst string, info fs.FileInfo, link bool) {}

func mountsBelowOrNone(dir string) []string { return nil }
