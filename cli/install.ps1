# Installs the ambb CLI (Amber Backup) on Windows (PowerShell 5.1 and 7+).
#
#   irm https://<your-amber-server>/api/cli/install.ps1 | iex
#
# Downloads the release archive for this architecture from GitHub Releases,
# verifies its SHA-256 against the release's checksums.txt and installs the
# binary. Safe to re-run; it replaces an existing ambb in the install dir.
#
# Environment:
#   AMBB_VERSION      release to install, e.g. 1.36.0 (default: latest)
#   AMBB_INSTALL_DIR  target directory (default: %LOCALAPPDATA%\Programs\ambb)
#   AMBER_URL         Amber server, only used for the "next step" hint
#
# The script runs inside `iex` in the caller's session, so everything lives in
# one script block (no variables leak into the session) and errors are thrown
# rather than calling `exit`, which would close the user's shell.

& {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'

    # Defaults. The Amber server rewrites these two lines when it serves the
    # script; a variable set in the environment always wins.
    $Version = if ($env:AMBB_VERSION) { $env:AMBB_VERSION } else { 'latest' }
    $AmberUrl = if ($env:AMBER_URL) { $env:AMBER_URL } else { '' }

    $Repo = 'amber-backup/amber-backup'

    # Windows PowerShell 5.1 may still default to TLS 1.0/1.1, which GitHub rejects.
    if ($PSVersionTable.PSVersion.Major -lt 6) {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    }

    $arch = switch ($env:PROCESSOR_ARCHITECTURE) {
        'AMD64' { 'amd64' }
        'ARM64' { 'arm64' }
        default { throw "ambb install: unsupported architecture: $($env:PROCESSOR_ARCHITECTURE)" }
    }

    if ($Version -eq 'latest') {
        $release = Invoke-RestMethod -UseBasicParsing -Uri "https://api.github.com/repos/$Repo/releases/latest"
        $tag = [string]$release.tag_name
        if (-not $tag) { throw "ambb install: could not determine the latest release of $Repo" }
    } else {
        $tag = 'v' + $Version.TrimStart('v')
    }
    $ver = $tag.Substring(1)
    if ($ver -notmatch '^\d+\.\d+\.\d+$') {
        throw "ambb install: invalid version: $ver (expected e.g. 1.36.0)"
    }

    $name = "ambb_${ver}_windows_${arch}"
    $archive = "$name.zip"
    $base = "https://github.com/$Repo/releases/download/v$ver"

    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('ambb-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
        Write-Host "Downloading ambb $ver (windows/$arch)"
        $archivePath = Join-Path $tmp $archive
        $checksumsPath = Join-Path $tmp 'checksums.txt'
        Invoke-WebRequest -UseBasicParsing -Uri "$base/$archive" -OutFile $archivePath
        Invoke-WebRequest -UseBasicParsing -Uri "$base/checksums.txt" -OutFile $checksumsPath

        $expected = $null
        foreach ($line in Get-Content -LiteralPath $checksumsPath) {
            $parts = $line -split '\s+', 2
            if ($parts.Count -eq 2 -and $parts[1].TrimStart('*') -eq $archive) {
                $expected = $parts[0].ToLowerInvariant()
                break
            }
        }
        if (-not $expected) { throw "ambb install: no checksum for $archive in checksums.txt" }
        $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToLowerInvariant()
        if ($actual -ne $expected) {
            throw "ambb install: checksum mismatch for $archive (expected $expected, got $actual)"
        }
        Write-Host 'Checksum verified'

        $extractDir = Join-Path $tmp 'x'
        Expand-Archive -LiteralPath $archivePath -DestinationPath $extractDir
        $exe = Join-Path (Join-Path $extractDir $name) 'ambb.exe'
        if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
            throw "ambb install: archive does not contain $name\ambb.exe"
        }

        $dir = if ($env:AMBB_INSTALL_DIR) { $env:AMBB_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\ambb' }
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        $target = Join-Path $dir 'ambb.exe'
        Copy-Item -LiteralPath $exe -Destination $target -Force
    } finally {
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }

    $installed = & $target --version
    Write-Host "Installed $installed to $target"

    # Add the install dir to the user PATH (persistent) and to this session.
    $dirTrimmed = $dir.TrimEnd('\')
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $userEntries = @($userPath -split ';' | Where-Object { $_ } | ForEach-Object { $_.TrimEnd('\') })
    if ($userEntries -notcontains $dirTrimmed) {
        $newUserPath = if ($userPath) { $userPath.TrimEnd(';') + ';' + $dir } else { $dir }
        [Environment]::SetEnvironmentVariable('Path', $newUserPath, 'User')
        Write-Host "Added $dir to your user PATH"
    }
    $sessionEntries = @($env:Path -split ';' | Where-Object { $_ } | ForEach-Object { $_.TrimEnd('\') })
    if ($sessionEntries -notcontains $dirTrimmed) {
        $env:Path = $env:Path.TrimEnd(';') + ';' + $dir
    }

    Write-Host ''
    if ($AmberUrl) {
        Write-Host "Next step: ambb login $AmberUrl"
    } else {
        Write-Host 'Next step: ambb login <your-amber-server>'
    }
}
