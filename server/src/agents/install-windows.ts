/**
 * The Windows agent installer served at GET /api/agents/install.ps1. It runs in
 * an elevated PowerShell (5.1 or 7+) on the target host:
 *
 *   $env:AMBER_TOKEN='<token>'; $env:AMBER_NAME='<name>'; irm https://<server>/api/agents/install.ps1 | iex
 *
 * It installs the agent and the server's bundled restic (verified against the
 * server's SHA256SUMS) into %ProgramData%\AmberAgent, locks that directory down
 * to SYSTEM and Administrators (it holds the agent key and the enrollment
 * token), writes agent.env, and registers the AmberAgent service with restart
 * recovery actions (the agent exits after a self-update and relies on them).
 * Safe to re-run: it updates an installed agent in place.
 *
 * Kept as a String.raw literal so backslashes survive; the script must contain
 * no backtick and no dollar-brace sequence (TypeScript would interpret them).
 * The server rewrites the AMBER_URL_MARKER line with its PUBLIC_BASE_URL.
 */

/** The default-URL line the server rewrites (see AgentsService.installPowerShellScript). */
export const AMBER_URL_MARKER =
  "$AmberUrl = if ($env:AMBER_URL) { $env:AMBER_URL } else { '' }";

/** Renders the marker line with the server's URL filled in. */
export const amberUrlLine = (url: string): string =>
  `$AmberUrl = if ($env:AMBER_URL) { $env:AMBER_URL } else { '${url}' }`;

export const INSTALL_PS1 = String.raw`# Amber Backup agent installer for Windows (PowerShell 5.1 and 7+).
# Run in an elevated PowerShell on the host to protect:
#
#   $env:AMBER_TOKEN='<token>'; $env:AMBER_NAME='<name>'; irm https://<your-amber-server>/api/agents/install.ps1 | iex
#
# Installs the agent and the server's bundled restic into %ProgramData%\AmberAgent
# and registers the AmberAgent service. Safe to re-run: it updates in place.
#
# Environment:
#   AMBER_URL      Amber server (default: the server that served this script)
#   AMBER_TOKEN    enrollment token (only for the first enrollment)
#   AMBER_NAME     agent name (default: the host name)
#   INSTALL_DIR    install directory (default: %ProgramData%\AmberAgent)
#   RESTIC_BINARY  use this restic instead of the bundled one

& {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'

    # Default server. The Amber server rewrites this line when it serves the
    # script; a variable set in the environment always wins.
    $AmberUrl = if ($env:AMBER_URL) { $env:AMBER_URL } else { '' }
    if (-not $AmberUrl) { throw 'amber-agent install: AMBER_URL is required' }
    $AmberUrl = $AmberUrl.TrimEnd('/')

    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'amber-agent install: run this in an elevated PowerShell (Run as administrator)'
    }

    # Windows PowerShell 5.1 may still default to TLS 1.0/1.1.
    if ($PSVersionTable.PSVersion.Major -lt 6) {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    }

    $arch = switch ($env:PROCESSOR_ARCHITECTURE) {
        'AMD64' { 'amd64' }
        'ARM64' { 'arm64' }
        default { throw "amber-agent install: unsupported architecture: $($env:PROCESSOR_ARCHITECTURE)" }
    }
    $target = "windows-$arch"
    $serviceName = 'AmberAgent'
    $dir = if ($env:INSTALL_DIR) { $env:INSTALL_DIR } else { Join-Path $env:ProgramData 'AmberAgent' }
    $agentExe = Join-Path $dir 'amber-agent.exe'
    $resticExe = Join-Path $dir 'restic.exe'
    $envFile = Join-Path $dir 'agent.env'

    # A token is only needed for the first enrollment; a re-run of an enrolled
    # agent (state.json present) reuses its stored credential.
    if (-not (Test-Path -LiteralPath (Join-Path $dir 'state.json')) -and -not $env:AMBER_TOKEN) {
        throw 'amber-agent install: AMBER_TOKEN is required for the first enrollment'
    }

    Write-Host "Installing/updating the Amber agent in $dir ($target)"
    New-Item -ItemType Directory -Path $dir -Force | Out-Null

    # The directory holds the agent key and the enrollment token: SYSTEM and
    # Administrators only, nothing inherited from ProgramData (Users can read it).
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in 'S-1-5-18', 'S-1-5-32-544') {
        $identity = New-Object Security.Principal.SecurityIdentifier($sid)
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $dir -AclObject $acl

    # Checksums of the server's bundle guard against a corrupt download.
    $sums = @{}
    $sumsText = (Invoke-WebRequest -UseBasicParsing -Uri "$AmberUrl/api/agents/SHA256SUMS").Content
    if ($sumsText -is [byte[]]) { $sumsText = [Text.Encoding]::UTF8.GetString($sumsText) }
    foreach ($line in ($sumsText -split "\r?\n")) {
        $parts = $line.Trim() -split '\s+', 2
        if ($parts.Count -eq 2) { $sums[$parts[1].TrimStart('*')] = $parts[0].ToLowerInvariant() }
    }

    function Get-Verified([string]$Url, [string]$Name, [string]$Dest) {
        $expected = $sums[$Name]
        if (-not $expected) { throw "amber-agent install: the server has no $Name (SHA256SUMS lists no checksum for it)" }
        Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Dest
        $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Dest).Hash.ToLowerInvariant()
        if ($actual -ne $expected) {
            Remove-Item -LiteralPath $Dest -Force -ErrorAction SilentlyContinue
            throw "amber-agent install: checksum mismatch for $Name (expected $expected, got $actual)"
        }
    }

    Get-Verified "$AmberUrl/api/agents/binary/$target" "amber-agent-$target.exe" "$agentExe.new"
    $bundleRestic = -not $env:RESTIC_BINARY
    if ($bundleRestic) {
        Get-Verified "$AmberUrl/api/agents/restic/$target" "restic-$target.exe" "$resticExe.new"
    } elseif (-not (Test-Path -LiteralPath $env:RESTIC_BINARY -PathType Leaf)) {
        throw "amber-agent install: RESTIC_BINARY not found: $($env:RESTIC_BINARY)"
    }
    Write-Host 'Checksums verified'

    # Stop a running agent so its binaries can be replaced.
    $existing = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    if ($existing -and $existing.Status -ne 'Stopped') {
        Stop-Service -Name $serviceName -Force
        $existing.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(60))
    }
    Move-Item -LiteralPath "$agentExe.new" -Destination $agentExe -Force
    if ($bundleRestic) { Move-Item -LiteralPath "$resticExe.new" -Destination $resticExe -Force }

    $lines = @(
        "AMBER_URL=$AmberUrl",
        "AMBER_TOKEN=$($env:AMBER_TOKEN)",
        "AMBER_NAME=$($env:AMBER_NAME)",
        "INSTALL_DIR=$dir"
    )
    if (-not $bundleRestic) { $lines += "RESTIC_BINARY=$($env:RESTIC_BINARY)" }
    [IO.File]::WriteAllLines($envFile, [string[]]$lines)

    if (-not $existing) {
        New-Service -Name $serviceName -BinaryPathName ('"' + $agentExe + '"') -DisplayName 'Amber Backup Agent' -Description 'Runs Amber Backup tasks (restic) on this host.' -StartupType Automatic | Out-Null
    }
    # Restart after any exit: the agent exits on purpose after a self-update.
    & sc.exe failure $serviceName reset= 86400 actions= restart/10000/restart/10000/restart/60000 | Out-Null
    & sc.exe failureflag $serviceName 1 | Out-Null
    Start-Service -Name $serviceName

    $version = & $agentExe --version
    Write-Host "Amber agent $version installed and started (service $serviceName)."
}
`;
