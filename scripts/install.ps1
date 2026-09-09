# cork-ai installer for Windows — https://github.com/mqthys62/cork-ai
#
# Usage (PowerShell):
#   irm https://raw.githubusercontent.com/mqthys62/cork-ai/main/scripts/install.ps1 | iex
#
# Everything lives in one function: under `irm | iex` there is no script scope,
# so a bare `exit` would close the user's console and `$ErrorActionPreference`
# would leak into their session. `return` and `throw` stay inside the function.

function Install-CorkAi {
    $prevEap = $ErrorActionPreference
    $prevProgress = $ProgressPreference
    $ErrorActionPreference = "Stop"
    # The progress bar makes Invoke-WebRequest painfully slow on PowerShell 5.1 for a ~90 MB file.
    $ProgressPreference = "SilentlyContinue"

    $Repo       = "mqthys62/cork-ai"
    $InstallDir = "$env:LOCALAPPDATA\cork-ai\bin"
    $BinaryName = "cork-ai-windows-x64.exe"
    $DestName   = "cork-ai.exe"

    function Write-Ok   { param($m) Write-Host "  [OK] $m" -ForegroundColor Green }
    function Write-Warn { param($m) Write-Host "  [!]  $m" -ForegroundColor Yellow }
    function Write-Info { param($m) Write-Host "       $m" -ForegroundColor DarkGray }
    function Write-Fail { param($m) Write-Host "  [X] $m" -ForegroundColor Red }
    function Write-Sep  { Write-Host "────────────────────────────────────────────────────" }

    $tmp = $null
    try {
        Write-Host ""
        Write-Host "cork-ai" -ForegroundColor White -NoNewline
        Write-Host " — Context optimization for Claude Code"
        Write-Sep
        Write-Host ""

        # ─── Fetch latest release ─────────────────────────────────────────────

        Write-Host "  Fetching latest release..."
        try {
            # $env:CORK_AI_PRERELEASE = 1 installs the newest release candidate
            # (GitHub keeps /releases/latest clear of pre-releases).
            $pre = $env:CORK_AI_PRERELEASE -and $env:CORK_AI_PRERELEASE -ne "0"
            if ($pre) {
                $api = "https://api.github.com/repos/$Repo/releases?per_page=10"
                $release = @(Invoke-RestMethod -Uri $api -Headers @{ "User-Agent" = "cork-ai-installer" }) | Where-Object { -not $_.draft } | Select-Object -First 1
            } else {
                $api = "https://api.github.com/repos/$Repo/releases/latest"
                $release = Invoke-RestMethod -Uri $api -Headers @{ "User-Agent" = "cork-ai-installer" }
            }
            $tag = $release.tag_name
            if (-not $tag) { throw "no tag_name in the API response" }
        } catch {
            throw "Could not fetch latest release ($($_.Exception.Message)). Check: https://github.com/$Repo/releases"
        }

        $downloadUrl = "https://github.com/$Repo/releases/download/$tag/$BinaryName"
        $sumsUrl     = "https://github.com/$Repo/releases/download/$tag/checksums.txt"
        Write-Ok "Latest: $tag"

        # ─── Download to a temp file, verify, then move into place ────────────

        New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
        $dest = Join-Path $InstallDir $DestName
        $tmp  = Join-Path $InstallDir "$DestName.new.$PID"

        Write-Host ""
        Write-Host "  Downloading $BinaryName..."
        try {
            Invoke-WebRequest -Uri $downloadUrl -OutFile $tmp -UseBasicParsing
        } catch {
            throw "Download failed from: $downloadUrl ($($_.Exception.Message))"
        }

        $expected = $null
        try {
            $sums = (Invoke-WebRequest -Uri $sumsUrl -UseBasicParsing).Content
            $line = ($sums -split "`n") | Where-Object { $_ -match "\s$([regex]::Escape($BinaryName))\s*$" } | Select-Object -First 1
            if ($line) { $expected = ($line -split "\s+")[0].ToLower() }
        } catch { }
        if ($expected) {
            $actual = (Get-FileHash -Path $tmp -Algorithm SHA256).Hash.ToLower()
            if ($actual -ne $expected) { throw "Checksum mismatch for $BinaryName (expected $expected, got $actual). Not installed." }
            Write-Ok "Checksum verified"
        } else {
            Write-Warn "No checksum published for $tag; skipping verification"
        }

        # A running cork-ai.exe (a hook mid-call) cannot be overwritten: park it
        # aside first, like `cork-ai update` does, then move the new one in.
        if (Test-Path $dest) {
            $old = "$dest.old"
            Remove-Item -Force $old -ErrorAction SilentlyContinue
            try { Move-Item -Force $dest $old } catch { throw "Could not replace $dest (is Claude Code running a hook right now? retry in a moment)" }
        }
        Move-Item -Force $tmp $dest
        $tmp = $null
        Remove-Item -Force "$dest.old" -ErrorAction SilentlyContinue
        Write-Ok "Downloaded to $dest"

        # ─── PATH setup ───────────────────────────────────────────────────────

        $userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
        if ($userPath -notlike "*$InstallDir*") {
            [Environment]::SetEnvironmentVariable("PATH", "$userPath;$InstallDir", "User")
            Write-Ok "Added $InstallDir to user PATH"
            Write-Info "Restart your terminal for PATH to take effect in all sessions."
        } else {
            Write-Info "PATH already contains $InstallDir"
        }
        if ($env:PATH -notlike "*$InstallDir*") { $env:PATH = "$env:PATH;$InstallDir" }

        # ─── Verify ───────────────────────────────────────────────────────────

        try {
            $version = & $dest --version 2>$null
            Write-Ok $version
        } catch {
            Write-Warn "Binary downloaded but could not verify. Try running: cork-ai --version"
        }

        # ─── Claude Code hooks ────────────────────────────────────────────────

        Write-Host ""
        Write-Host "  Setting up Claude Code integration..."

        # Not piped to Out-Null: `hooks install` asks two questions (telemetry,
        # auto-compaction) on the terminal, and a hidden prompt looks like a hang.
        try {
            if ($pre) { & $dest config set channel pre | Out-Null }
            $env:CORK_AI_INSTALLER = "ps1"
            & $dest hooks install
            if ($LASTEXITCODE -ne 0) { throw "hooks install exited with $LASTEXITCODE" }
            Write-Ok "Claude Code hook installed"
            Write-Info "All Claude Code sessions will compress Read outputs automatically."
            Write-Info "No per-project setup needed — works across all projects."
        } catch {
            Write-Warn "Could not configure Claude Code hooks automatically."
            Write-Host ""
            Write-Host "  Run after restarting terminal: " -NoNewline
            Write-Host "cork-ai hooks install" -ForegroundColor Cyan
        }

        # ─── Doctor ───────────────────────────────────────────────────────────

        Write-Host ""
        try { & $dest doctor } catch { }

        # ─── Done ─────────────────────────────────────────────────────────────

        Write-Host ""
        Write-Sep
        Write-Host "  Done." -ForegroundColor Green -NoNewline
        Write-Host " Restart Claude Code and your terminal to activate."
        Write-Host ""
        Write-Host "  cork-ai gain              " -NoNewline; Write-Host "see token savings" -ForegroundColor DarkGray
        Write-Host "  cork-ai context           " -NoNewline; Write-Host "where the money goes (context size per turn)" -ForegroundColor DarkGray
        Write-Host "  cork-ai doctor            " -NoNewline; Write-Host "check the install after a claude update" -ForegroundColor DarkGray
        Write-Host ""
        Write-Host "  cork-ai telemetry on      " -NoNewline; Write-Host "help improve it (anonymous, opt-in)" -ForegroundColor DarkGray
        Write-Host ""
    } catch {
        Write-Fail $_.Exception.Message
        Write-Host ""
    } finally {
        if ($tmp -and (Test-Path $tmp)) { Remove-Item -Force $tmp -ErrorAction SilentlyContinue }
        $ErrorActionPreference = $prevEap
        $ProgressPreference = $prevProgress
    }
}

Install-CorkAi
