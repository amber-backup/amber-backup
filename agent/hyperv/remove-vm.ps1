# Stops and unregisters a VM (its files stay where they are). Used before a
# restore replaces the original VM.
#
# args: vmId

Invoke-OnHost {
    param($a)
    $ErrorActionPreference = 'Stop'
    $vm = Get-VM -Id ([string]$a.vmId) -ErrorAction SilentlyContinue
    if (-not $vm) { return }
    if ([string]$vm.State -ne 'Off') { Stop-VM -VM $vm -TurnOff -Force }
    Get-VMSnapshot -VM $vm -ErrorAction SilentlyContinue | Remove-VMSnapshot -Confirm:$false
    Remove-VM -VM $vm -Force
} | Out-Null

Write-AmberResult $true $true
