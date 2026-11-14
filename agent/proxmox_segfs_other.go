//go:build !linux

package main

import "errors"

// Proxmox VE runs on Linux only; the segment view needs Linux FUSE.
func mountSegmentView(dir string, view *segmentView) (func() error, error) {
	return nil, errors.New("the block method needs a Linux agent")
}

func cleanupMountsBelow(dir string) []string { return nil }
