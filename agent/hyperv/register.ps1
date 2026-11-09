# Builds a VM from restored files and the backup's manifest.
#
# args: manifest {vm, set}, name, vmPath, disks[] {controllerType,
#       controllerNumber, controllerLocation, chain[] (restored paths, base
#       first)}, start, connectNetwork, keepMac, clusterRole
#
# Each restored disk chain is merged into its base disk first, so the VM starts
# without checkpoints. The VM is created anew (new id) from the manifest rather
# than imported, which works on any host; the backed-up configuration files are
# kept next to it for a manual Import-VM. Network adapters stay disconnected
# unless connectNetwork is set (a copy next to the original would clash).

$data = Invoke-OnHost {
    param($a)
    $ErrorActionPreference = 'Stop'
    $m = $a.manifest
    $name = [string]$a.name
    $warnings = @()
    if (Get-VM -Name $name -ErrorAction SilentlyContinue) {
        throw ("A VM named '{0}' already exists" -f $name)
    }

    $disks = @()
    foreach ($d in @($a.disks)) {
        $chain = @($d.chain)
        for ($i = 1; $i -lt $chain.Count; $i++) {
            # The restored differencing disks still point at the old parents.
            Set-VHD -Path ([string]$chain[$i]) -ParentPath ([string]$chain[$i - 1])
        }
        if ($chain.Count -gt 1) {
            Merge-VHD -Path ([string]$chain[$chain.Count - 1]) -DestinationPath ([string]$chain[0])
        }
        $disks += [pscustomobject]@{
            path               = [string]$chain[0]
            controllerType     = [string]$d.controllerType
            controllerNumber   = [int]$d.controllerNumber
            controllerLocation = [int]$d.controllerLocation
        }
    }

    $vm = New-VM -Name $name -Generation ([int]$m.vm.generation) -MemoryStartupBytes ([int64]$m.vm.memoryStartupBytes) -Path ([string]$a.vmPath) -NoVHD
    try {
        Set-VM -VM $vm -ProcessorCount ([int]$m.vm.processorCount)
        if ($m.vm.checkpointType) { Set-VM -VM $vm -CheckpointType ([string]$m.vm.checkpointType) }
        if ($m.vm.notes) { Set-VM -VM $vm -Notes ([string]$m.vm.notes) }
        if ($m.set.dynamicMemory) {
            Set-VMMemory -VM $vm -DynamicMemoryEnabled $true -MinimumBytes ([int64]$m.set.memoryMinimumBytes) -MaximumBytes ([int64]$m.set.memoryMaximumBytes) -StartupBytes ([int64]$m.vm.memoryStartupBytes)
        }

        Get-VMNetworkAdapter -VM $vm | Remove-VMNetworkAdapter
        foreach ($n in @($m.set.nics)) {
            $params = @{ VM = $vm; Name = [string]$n.name; Passthru = $true }
            if ($a.connectNetwork -and $n.switchName) {
                if (Get-VMSwitch -Name ([string]$n.switchName) -ErrorAction SilentlyContinue) {
                    $params.SwitchName = [string]$n.switchName
                } else {
                    $warnings += ("Switch '{0}' does not exist on this host; adapter '{1}' is not connected" -f $n.switchName, $n.name)
                }
            }
            if ($a.keepMac -and $n.staticMac -and $n.macAddress) { $params.StaticMacAddress = [string]$n.macAddress }
            $nic = Add-VMNetworkAdapter @params
            if ([int]$n.vlanId -gt 0) { Set-VMNetworkAdapterVlan -VMNetworkAdapter $nic -Access -VlanId ([int]$n.vlanId) }
        }

        foreach ($d in $disks) {
            if ($d.controllerType -eq 'SCSI') {
                while (@(Get-VMScsiController -VM $vm).Count -le $d.controllerNumber) { Add-VMScsiController -VM $vm }
            }
            Add-VMHardDiskDrive -VM $vm -ControllerType $d.controllerType -ControllerNumber $d.controllerNumber -ControllerLocation $d.controllerLocation -Path $d.path
        }

        if ([int]$m.vm.generation -eq 2) {
            if ($m.set.secureBoot) {
                $fw = @{ VM = $vm; EnableSecureBoot = 'On' }
                if ($m.set.secureBootTemplate) { $fw.SecureBootTemplate = [string]$m.set.secureBootTemplate }
                Set-VMFirmware @fw
            } else {
                Set-VMFirmware -VM $vm -EnableSecureBoot Off
            }
            $boot = Get-VMHardDiskDrive -VM $vm | Sort-Object ControllerNumber, ControllerLocation | Select-Object -First 1
            if ($boot) { Set-VMFirmware -VM $vm -FirstBootDevice $boot }
        }

        if ($m.set.tpm) {
            Set-VMKeyProtector -VM $vm -NewLocalKeyProtector
            Enable-VMTPM -VM $vm
            $warnings += 'The VM had a virtual TPM. The restored VM has a new one, so BitLocker inside the guest will ask for its recovery key.'
        }

        # On a cluster the VM becomes a clustered role (highly available) when its
        # files are on cluster storage; otherwise it stays a node-local VM.
        if ($a.clusterRole) {
            if (([string]$a.vmPath) -like '*\ClusterStorage\*') {
                Add-ClusterVirtualMachineRole -VMName $name | Out-Null
            } else {
                $warnings += 'The VM is not on cluster storage (C:\ClusterStorage), so it was not made highly available.'
            }
        }

        if ($a.start) { Start-VM -VM $vm }
    } catch {
        Remove-VM -VM $vm -Force -ErrorAction SilentlyContinue
        throw
    }

    [pscustomobject]@{
        id       = ([string]$vm.Id).ToLowerInvariant()
        name     = [string]$vm.Name
        warnings = $warnings
    }
}

Write-AmberResult $true (Remove-RemotingProperties $data)
