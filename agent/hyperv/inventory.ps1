# Lists the host's VMs with what Amber needs to show and back them up.

$data = Invoke-OnHost {
    param($a)
    $ErrorActionPreference = 'Stop'
    # Backup (volume shadow copy) integration service; its id ends in this GUID
    # on every Windows version (names are localized).
    $vssGuid = '6C09BB55-D683-4DA0-8931-C9BF705F6480'
    $os = Get-CimInstance -ClassName Win32_OperatingSystem
    $vms = @(Get-VM | ForEach-Object {
        $vm = $_
        $disks = @(Get-VMHardDiskDrive -VM $vm | Where-Object { $_.Path } | ForEach-Object {
            $drive = $_
            $vhd = $null
            try { $vhd = Get-VHD -Path $drive.Path } catch { }
            $fileSize = 0
            $size = 0
            if ($vhd) { $fileSize = $vhd.FileSize; $size = $vhd.Size }
            [pscustomobject]@{
                path               = [string]$drive.Path
                controllerType     = [string]$drive.ControllerType
                controllerNumber   = [int]$drive.ControllerNumber
                controllerLocation = [int]$drive.ControllerLocation
                fileSizeBytes      = [int64]$fileSize
                sizeBytes          = [int64]$size
            }
        })
        $vss = @(Get-VMIntegrationService -VM $vm | Where-Object { ([string]$_.Id).ToUpperInvariant().EndsWith($vssGuid) })
        $backup = ($vss.Count -gt 0) -and $vss[0].Enabled -and ([string]$vss[0].PrimaryOperationalStatus -eq 'Ok')
        $stale = @(Get-VMSnapshot -VM $vm -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like 'amber-*' } | ForEach-Object { [string]$_.Name })
        [pscustomobject]@{
            id                    = ([string]$vm.Id).ToLowerInvariant()
            name                  = [string]$vm.Name
            state                 = [string]$vm.State
            generation            = [int]$vm.Generation
            version               = [string]$vm.Version
            processorCount        = [int]$vm.ProcessorCount
            memoryStartupBytes    = [int64]$vm.MemoryStartup
            checkpointType        = [string]$vm.CheckpointType
            backupIntegration     = [bool]$backup
            configurationLocation = [string]$vm.ConfigurationLocation
            disks                 = $disks
            staleCheckpoints      = $stale
            notes                 = [string]$vm.Notes
        }
    })
    [pscustomobject]@{
        computerName = [string]$env:COMPUTERNAME
        os           = '{0} (build {1})' -f $os.Caption, $os.BuildNumber
        vms          = $vms
    }
}

Write-AmberResult $true (Remove-RemotingProperties $data)
