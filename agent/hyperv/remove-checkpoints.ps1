# Removes checkpoints of one VM by name and waits for Hyper-V to merge them
# back into the disks (the next backup needs a settled chain).
#
# args: vmId, names[]

Invoke-OnHost {
    param($a)
    $ErrorActionPreference = 'Stop'
    $vm = Get-VM -Id ([string]$a.vmId)
    foreach ($name in @($a.names)) {
        Get-VMSnapshot -VM $vm -Name ([string]$name) -ErrorAction SilentlyContinue |
            Remove-VMSnapshot -Confirm:$false
    }
    $deadline = (Get-Date).AddHours(1)
    while (@((Get-VM -Id ([string]$a.vmId)).OperationalStatus) -contains 'MergingDisks') {
        if ((Get-Date) -gt $deadline) { throw 'The checkpoint is still merging after an hour' }
        Start-Sleep -Seconds 5
    }
} | Out-Null

Write-AmberResult $true $true
