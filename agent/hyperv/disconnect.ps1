# Ends the SMB session connect.ps1 opened.

$remote = '\\{0}\IPC$' -f $AmberConn.address
Get-SmbMapping -RemotePath $remote -ErrorAction SilentlyContinue | Remove-SmbMapping -Force -ErrorAction SilentlyContinue
Write-AmberResult $true $true
