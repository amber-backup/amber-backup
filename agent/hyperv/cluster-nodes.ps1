# Lists the failover cluster's nodes that are up (run against the cluster name).

$nodes = Invoke-OnHost {
    param($a)
    $ErrorActionPreference = 'Stop'
    @(Get-ClusterNode | Where-Object { [string]$_.State -eq 'Up' } | ForEach-Object { [string]$_.Name })
}
Write-AmberResult $true @($nodes)
