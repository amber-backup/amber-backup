# Shared prelude of the agent's Hyper-V scripts (prepended to each one).
#
# Input: JSON on stdin, {"conn": {"mode", "address", "username", "password"}, "args": {...}}.
# Output: exactly one line "AMBER-RESULT:<json>" with {"ok": true, "data": ...}
# or {"ok": false, "error": "..."}; anything else on stdout is ignored.
#
# Invoke-OnHost runs a script block on the Hyper-V host: in this process for a
# local host, through PowerShell remoting with the stored credential for a
# remote one. Blocks must only return plain data ([pscustomobject], strings,
# numbers), which survives remoting's serialization.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'

function Write-AmberResult($Ok, $Data, $Message) {
    $payload = [ordered]@{ ok = [bool]$Ok }
    if ($Ok) { $payload.data = $Data } else { $payload.error = [string]$Message }
    [Console]::Out.WriteLine('AMBER-RESULT:' + ($payload | ConvertTo-Json -Depth 12 -Compress))
}

trap {
    Write-AmberResult $false $null $_.Exception.Message
    exit 1
}

$AmberInput = [Console]::In.ReadToEnd() | ConvertFrom-Json
$AmberConn = $AmberInput.conn
$AmberArgs = $AmberInput.args

function Get-AmberCredential {
    $secure = ConvertTo-SecureString ([string]$AmberConn.password) -AsPlainText -Force
    New-Object System.Management.Automation.PSCredential([string]$AmberConn.username, $secure)
}

function Invoke-OnHost([scriptblock]$Block) {
    if ($AmberConn.mode -eq 'remote') {
        Invoke-Command -ComputerName ([string]$AmberConn.address) -Credential (Get-AmberCredential) -ScriptBlock $Block -ArgumentList (, $AmberArgs)
    } else {
        & $Block $AmberArgs
    }
}

# Remoting decorates returned objects with these; they are not part of the data.
function Remove-RemotingProperties($Object) {
    if ($null -eq $Object) { return $null }
    $Object | Select-Object -Property * -ExcludeProperty PSComputerName, RunspaceId, PSShowComputerName
}
