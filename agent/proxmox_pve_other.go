//go:build !linux

package main

// Proxmox VE nodes run Linux; elsewhere only the mock backend exists.
func newRealPveBackend() pveBackend { return nil }
