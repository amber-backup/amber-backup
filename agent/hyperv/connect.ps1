# Opens an SMB session to a remote Hyper-V host with the stored credential, so
# the agent (and restic, running as the same account) can read and write the
# host's files through its administrative shares (\\host\D$\...).

$remote = '\\{0}\IPC$' -f $AmberConn.address
Get-SmbMapping -RemotePath $remote -ErrorAction SilentlyContinue | Remove-SmbMapping -Force -ErrorAction SilentlyContinue
New-SmbMapping -RemotePath $remote -UserName ([string]$AmberConn.username) -Password ([string]$AmberConn.password) | Out-Null

# Fail early with a clear message when remoting is not set up.
Invoke-OnHost { param($a) $env:COMPUTERNAME } | Out-Null

Write-AmberResult $true $true
