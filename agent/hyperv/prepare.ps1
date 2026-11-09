# Takes the backup checkpoint of one VM and reports what to back up.
#
# args: vmId, checkpoint (name), mode (Production | ProductionOnly), includeConfig
#
# A production checkpoint quiesces the guest through its VSS (application-
# consistent). If the guest can't do one, mode Production falls back to a
# standard (crash-consistent) checkpoint; ProductionOnly fails instead. The
# VM's own checkpoint setting is restored afterwards.
#
# Once the checkpoint exists, the VM writes into a new differencing disk; each
# disk's parents — the chain down to its base disk — are read-only and are what
# the backup reads.

$data = Invoke-OnHost {
    param($a)
    $ErrorActionPreference = 'Stop'
    $vm = Get-VM -Id ([string]$a.vmId)
    $original = $vm.CheckpointType
    $consistency = 'application'
    try {
        Set-VM -VM $vm -CheckpointType ProductionOnly
        try {
            Checkpoint-VM -VM $vm -SnapshotName ([string]$a.checkpoint)
        } catch {
            if ([string]$a.mode -eq 'ProductionOnly') {
                throw ('Production checkpoint failed: {0}' -f $_.Exception.Message)
            }
            Set-VM -VM $vm -CheckpointType Standard
            Checkpoint-VM -VM $vm -SnapshotName ([string]$a.checkpoint)
            $consistency = 'crash'
        }
    } finally {
        Set-VM -VM $vm -CheckpointType $original
    }
    # A VM that is off has nothing in flight: its disks are consistent.
    if ([string]$vm.State -eq 'Off') { $consistency = 'application' }

    try {
        $disks = @(Get-VMHardDiskDrive -VM $vm | Where-Object { $_.Path } | ForEach-Object {
            $drive = $_
            $chain = @()
            $parent = (Get-VHD -Path $drive.Path).ParentPath
            while ($parent) {
                $chain = @([string]$parent) + $chain
                $parent = (Get-VHD -Path $parent).ParentPath
            }
            if ($chain.Count -eq 0) {
                throw ('Disk {0} was not checkpointed (shared or pass-through disks are not supported)' -f $drive.Path)
            }
            [pscustomobject]@{
                controllerType     = [string]$drive.ControllerType
                controllerNumber   = [int]$drive.ControllerNumber
                controllerLocation = [int]$drive.ControllerLocation
                chain              = $chain
            }
        })

        $configFiles = @()
        if ($a.includeConfig) {
            $folder = Join-Path $vm.ConfigurationLocation 'Virtual Machines'
            $configFiles = @(Get-ChildItem -LiteralPath $folder -File -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -like ('{0}*' -f $vm.Id) } | ForEach-Object { [string]$_.FullName })
        }

        $nics = @(Get-VMNetworkAdapter -VM $vm | ForEach-Object {
            $nic = $_
            $vlanId = 0
            $vlan = Get-VMNetworkAdapterVlan -VMNetworkAdapter $nic
            if ([string]$vlan.OperationMode -eq 'Access') { $vlanId = [int]$vlan.AccessVlanId }
            [pscustomobject]@{
                name       = [string]$nic.Name
                switchName = [string]$nic.SwitchName
                macAddress = [string]$nic.MacAddress
                staticMac  = -not [bool]$nic.DynamicMacAddressEnabled
                vlanId     = $vlanId
            }
        })

        $memory = Get-VMMemory -VM $vm
        $secureBoot = $false
        $template = ''
        if ($vm.Generation -eq 2) {
            $firmware = Get-VMFirmware -VM $vm
            $secureBoot = ([string]$firmware.SecureBoot -eq 'On')
            $template = [string]$firmware.SecureBootTemplate
        }
        $tpm = $false
        try { $tpm = [bool](Get-VMSecurity -VM $vm).TpmEnabled } catch { }

        [pscustomobject]@{
            checkpoint         = [string]$a.checkpoint
            consistency        = $consistency
            disks              = $disks
            configFiles        = $configFiles
            nics               = $nics
            dynamicMemory      = [bool]$memory.DynamicMemoryEnabled
            memoryMinimumBytes = [int64]$memory.Minimum
            memoryMaximumBytes = [int64]$memory.Maximum
            secureBoot         = $secureBoot
            secureBootTemplate = $template
            tpm                = $tpm
        }
    } catch {
        # Never leave the checkpoint behind when the backup can't go ahead.
        Get-VMSnapshot -VM $vm -Name ([string]$a.checkpoint) -ErrorAction SilentlyContinue |
            Remove-VMSnapshot -Confirm:$false
        throw
    }
}

Write-AmberResult $true (Remove-RemotingProperties $data)
