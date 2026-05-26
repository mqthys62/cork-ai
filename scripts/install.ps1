# cork-ai installer for Windows — https://github.com/mqthys62/cork-ai
#
# Usage (PowerShell):
#   irm https://raw.githubusercontent.com/mqthys62/cork-ai/main/scripts/install.ps1 | iex

$ErrorActionPreference = "Stop"

$Repo      = "mqthys62/cork-ai"
$InstallDir = "$env:LOCALAPPDATA\cork-ai\bin"
$BinaryName = "cork-ai-windows-x64.exe"
$DestName   = "cork-ai.exe"

function Write-Ok   { param($m) Write-Host "  [OK] $m" -ForegroundColor Green }
function Write-Warn { param($m) Write-Host "  [!]  $m" -ForegroundColor Yellow }
function Write-Info { param($m) Write-Host "       $m" -ForegroundColor DarkGray }
function Write-Fail { param($m) Write-Host "  [X] $m" -ForegroundColor Red; exit 1 }
function Write-Sep  { Write-Host "────────────────────────────────────────────────────" }

Write-Host ""
Write-Host "cork-ai" -ForegroundColor White -NoNewline
Write-Host " — Context optimization for Claude Code"
Write-Sep
Write-Host ""

# ─── Fetch latest release ─────────────────────────────────────────────────────

Write-Host "  Fetching latest release..."

try {
    $api = "https://api.github.com/repos/$Repo/releases/latest"
    $release = Invoke-RestMethod -Uri $api -Headers @{ "User-Agent" = "cork-ai-installer" }
    $tag = $release.tag_name
} catch {
    Write-Fail "Could not fetch latest release. Check: https://github.com/$Repo/releases"
}

$downloadUrl = "https://github.com/$Repo/releases/download/$tag/$BinaryName"
Write-Ok "Latest: $tag"

# ─── Download ─────────────────────────────────────────────────────────────────

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$dest = Join-Path $InstallDir $DestName

Write-Host ""
Write-Host "  Downloading $BinaryName..."
try {
    Invoke-WebRequest -Uri $downloadUrl -OutFile $dest -UseBasicParsing
} catch {
    Write-Fail "Download failed from: $downloadUrl"
}

Write-Ok "Downloaded to $dest"

# ─── PATH setup ───────────────────────────────────────────────────────────────

$userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
if ($userPath -notlike "*$InstallDir*") {
    [Environment]::SetEnvironmentVariable("PATH", "$userPath;$InstallDir", "User")
    $env:PATH = "$env:PATH;$InstallDir"
    Write-Ok "Added $InstallDir to user PATH"
    Write-Info "Restart your terminal for PATH to take effect in all sessions."
} else {
    Write-Info "PATH already contains $InstallDir"
}

# ─── Verify ───────────────────────────────────────────────────────────────────

try {
    $version = & $dest --version 2>$null
    Write-Ok $version
} catch {
    Write-Warn "Binary downloaded but could not verify. Try running: cork-ai --version"
}

# ─── Claude Code hooks ────────────────────────────────────────────────────────

Write-Host ""
Write-Host "  Setting up Claude Code integration..."

try {
    & $dest hooks install | Out-Null
    Write-Ok "Claude Code hook installed"
    Write-Info "All Claude Code sessions will compress Read outputs automatically."
    Write-Info "No per-project setup needed — works across all projects."
} catch {
    Write-Warn "Could not configure Claude Code hooks automatically."
    Write-Host ""
    Write-Host "  Run after restarting terminal: " -NoNewline
    Write-Host "cork-ai hooks install" -ForegroundColor Cyan
}

# ─── Done ─────────────────────────────────────────────────────────────────────

Write-Host ""
Write-Sep
Write-Host "  Done." -ForegroundColor Green -NoNewline
Write-Host " Restart Claude Code and your terminal to activate."
Write-Host ""
Write-Host "  cork-ai gain              " -NoNewline; Write-Host "see token savings" -ForegroundColor DarkGray
Write-Host "  cork-ai report            " -NoNewline; Write-Host "full enterprise report" -ForegroundColor DarkGray
Write-Host "  cork-ai report --forecast " -NoNewline; Write-Host "annual projection" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  To integrate into your own code:"
Write-Host "  cd your-project && " -NoNewline
Write-Host "cork-ai init" -ForegroundColor Cyan
Write-Host ""
