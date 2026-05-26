# cork-ai installer for Windows — https://github.com/mathys62/cork-ai
#
# Usage (PowerShell):
#   irm https://raw.githubusercontent.com/mathys62/cork-ai/main/scripts/install.ps1 | iex
#
# Or save and run:
#   powershell -ExecutionPolicy Bypass -File install.ps1

$ErrorActionPreference = "Stop"

function Write-Ok   { param($m) Write-Host "  ✔  $m" -ForegroundColor Green }
function Write-Warn { param($m) Write-Host "  !  $m" -ForegroundColor Yellow }
function Write-Info { param($m) Write-Host "     $m" -ForegroundColor DarkGray }
function Write-Fail { param($m) Write-Host "  ✗  $m" -ForegroundColor Red; exit 1 }
function Write-Sep  { Write-Host "────────────────────────────────────────────────────" }

Write-Host ""
Write-Host "cork-ai" -ForegroundColor White -NoNewline
Write-Host " — Context optimization for Claude Code"
Write-Sep
Write-Host ""

# ─── Node.js check ────────────────────────────────────────────────────────────

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Warn "Node.js not found."
    Write-Host ""
    Write-Host "  Install Node.js 18+ from: https://nodejs.org/en/download"
    Write-Host "  Or via winget: " -NoNewline
    Write-Host "winget install OpenJS.NodeJS" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  Then re-run this installer."
    Write-Host ""
    exit 1
}

$nodeVersion = (node --version).TrimStart('v').Split('.')[0]
if ([int]$nodeVersion -lt 18) {
    Write-Fail "Node.js 18+ required (found: $(node --version)). Upgrade at https://nodejs.org"
}

Write-Ok "Node.js $(node --version)"

# ─── Package manager detection ────────────────────────────────────────────────

$pkgManager = "npm"
$globalInstall = "npm install -g cork-ai"

if (Get-Command bun -ErrorAction SilentlyContinue) {
    $pkgManager = "bun"
    $globalInstall = "bun install -g cork-ai"
} elseif (Get-Command pnpm -ErrorAction SilentlyContinue) {
    $pkgManager = "pnpm"
    $globalInstall = "pnpm install -g cork-ai"
} elseif (Get-Command yarn -ErrorAction SilentlyContinue) {
    $pkgManager = "yarn"
    $globalInstall = "yarn global add cork-ai"
}

Write-Info "Package manager: $pkgManager"
Write-Host ""

# ─── Install ──────────────────────────────────────────────────────────────────

Write-Host "  Installing cork-ai globally via " -NoNewline
Write-Host $pkgManager -ForegroundColor Cyan -NoNewline
Write-Host "..."
Write-Host ""

try {
    Invoke-Expression $globalInstall
} catch {
    Write-Fail "Installation failed. Try manually: $globalInstall"
}

Write-Host ""

# Verify cork-ai is in PATH
if (-not (Get-Command cork-ai -ErrorAction SilentlyContinue)) {
    Write-Warn "cork-ai installed but not found in PATH."
    Write-Host ""
    Write-Host "  Restart your shell or add the global bin to PATH, then run:"
    Write-Host "    cork-ai hooks install" -ForegroundColor Cyan
    Write-Host ""
    exit 0
}

$installedVersion = (cork-ai --version 2>$null)
Write-Ok $installedVersion

# ─── Claude Code hooks ────────────────────────────────────────────────────────

Write-Host ""
Write-Host "  Setting up Claude Code integration..."

try {
    cork-ai hooks install | Out-Null
    Write-Ok "Claude Code hook installed (PreToolUse Read compression)"
    Write-Info "All Claude Code sessions will compress file reads automatically."
    Write-Info "No per-project setup needed — works globally across all projects."
} catch {
    Write-Warn "Could not auto-configure Claude Code hooks."
    Write-Host ""
    Write-Host "  Run manually: " -NoNewline
    Write-Host "cork-ai hooks install" -ForegroundColor Cyan
}

# ─── Done ─────────────────────────────────────────────────────────────────────

Write-Host ""
Write-Sep
Write-Host "  " -NoNewline
Write-Host "All done." -ForegroundColor Green -NoNewline
Write-Host " Restart Claude Code to activate."
Write-Host ""
Write-Host "  After your first session:"
Write-Host "    " -NoNewline; Write-Host "cork-ai gain" -ForegroundColor Cyan -NoNewline; Write-Host "              see token savings"
Write-Host "    " -NoNewline; Write-Host "cork-ai report" -ForegroundColor Cyan -NoNewline; Write-Host "            full enterprise report"
Write-Host "    " -NoNewline; Write-Host "cork-ai report --forecast" -ForegroundColor Cyan -NoNewline; Write-Host "  annual cost projection"
Write-Host ""
Write-Host "  To use cork-ai in your own code too:"
Write-Host "    cd your-project"
Write-Host "    " -NoNewline; Write-Host "cork-ai init" -ForegroundColor Cyan -NoNewline; Write-Host "              auto-integrate into this project"
Write-Host ""
