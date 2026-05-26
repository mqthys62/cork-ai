#!/bin/sh
# cork-ai installer — https://github.com/mathysthery/cork-ai
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/mathysthery/cork-ai/main/scripts/install.sh | sh
#
# Or with a specific version:
#   curl -fsSL https://raw.githubusercontent.com/mathysthery/cork-ai/main/scripts/install.sh | sh -s -- --version 0.1.0

set -e

# ─── Colors ───────────────────────────────────────────────────────────────────

BOLD='\033[1m'
GREEN='\033[32m'
CYAN='\033[36m'
YELLOW='\033[33m'
RED='\033[31m'
DIM='\033[2m'
RESET='\033[0m'

ok()   { printf "  ${GREEN}✔${RESET}  %s\n" "$1"; }
warn() { printf "  ${YELLOW}!${RESET}  %s\n" "$1"; }
fail() { printf "  ${RED}✗${RESET}  %s\n" "$1"; exit 1; }
info() { printf "  ${DIM}%s${RESET}\n" "$1"; }

# ─── Header ───────────────────────────────────────────────────────────────────

printf "\n${BOLD}cork-ai${RESET} — Context optimization for Claude Code\n"
printf '%s\n' "────────────────────────────────────────────────────"
printf "\n"

# ─── OS detection ─────────────────────────────────────────────────────────────

OS="$(uname -s 2>/dev/null || echo 'unknown')"
case "$OS" in
  Linux*)   PLATFORM="linux" ;;
  Darwin*)  PLATFORM="macos" ;;
  CYGWIN*|MINGW*|MSYS*) PLATFORM="windows" ;;
  *)        PLATFORM="unknown" ;;
esac

info "Platform: $PLATFORM"

# ─── Node.js check ────────────────────────────────────────────────────────────

if ! command -v node >/dev/null 2>&1; then
  warn "Node.js not found."
  printf "\n  Install Node.js 18+ first:\n"
  if [ "$PLATFORM" = "macos" ]; then
    printf "    ${CYAN}brew install node${RESET}\n"
  elif [ "$PLATFORM" = "linux" ]; then
    printf "    ${CYAN}curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -\n"
    printf "    sudo apt-get install -y nodejs${RESET}\n"
  else
    printf "    ${CYAN}https://nodejs.org/en/download${RESET}\n"
  fi
  printf "\n  Then re-run this installer.\n\n"
  exit 1
fi

NODE_MAJOR="$(node --version | tr -d 'v' | cut -d. -f1)"
if [ "$NODE_MAJOR" -lt 18 ] 2>/dev/null; then
  fail "Node.js 18+ required (found: $(node --version)). Upgrade at https://nodejs.org"
fi

ok "Node.js $(node --version)"

# ─── Package manager detection ────────────────────────────────────────────────

if command -v bun >/dev/null 2>&1; then
  PKG="bun"
  GLOBAL_INSTALL="bun install -g cork-ai"
elif command -v pnpm >/dev/null 2>&1; then
  PKG="pnpm"
  GLOBAL_INSTALL="pnpm install -g cork-ai"
elif command -v yarn >/dev/null 2>&1; then
  PKG="yarn"
  GLOBAL_INSTALL="yarn global add cork-ai"
else
  PKG="npm"
  GLOBAL_INSTALL="npm install -g cork-ai"
fi

info "Package manager: $PKG"
printf "\n"

# ─── Install ──────────────────────────────────────────────────────────────────

printf "  Installing cork-ai globally via ${CYAN}${PKG}${RESET}...\n\n"

if ! eval "$GLOBAL_INSTALL" 2>&1 | sed 's/^/    /'; then
  printf "\n"
  fail "Installation failed. Try manually: ${GLOBAL_INSTALL}"
fi

printf "\n"

# Verify cork-ai is in PATH
if ! command -v cork-ai >/dev/null 2>&1; then
  warn "cork-ai installed but not found in PATH."
  printf "\n  You may need to add the global bin directory to your PATH.\n"
  if [ "$PKG" = "yarn" ]; then
    printf "  Run: ${CYAN}export PATH=\"\$(yarn global bin):\$PATH\"${RESET}\n"
    printf "  Then add that line to your ~/.bashrc or ~/.zshrc\n"
  elif [ "$PKG" = "pnpm" ]; then
    printf "  Run: ${CYAN}export PATH=\"\$(pnpm root -g)/.bin:\$PATH\"${RESET}\n"
  fi
  printf "\n  After fixing PATH, run: ${CYAN}cork-ai hooks install${RESET}\n\n"
  exit 0
fi

INSTALLED_VERSION="$(cork-ai --version 2>/dev/null || echo 'cork-ai')"
ok "$INSTALLED_VERSION"

# ─── Claude Code hooks ────────────────────────────────────────────────────────

printf "\n  Setting up Claude Code integration...\n"

if cork-ai hooks install 2>/dev/null; then
  ok "Claude Code hook installed (PreToolUse Read compression)"
  info "All your Claude Code sessions will compress file reads automatically."
  info "No per-project setup needed — works globally across all projects."
else
  warn "Could not auto-configure Claude Code hooks."
  printf "\n  Run manually: ${CYAN}cork-ai hooks install${RESET}\n"
fi

# ─── Done ─────────────────────────────────────────────────────────────────────

printf "\n"
printf '%s\n' "────────────────────────────────────────────────────"
printf "  ${BOLD}${GREEN}All done.${RESET} Restart Claude Code to activate.\n"
printf "\n"
printf "  After your first session:\n"
printf "    ${CYAN}cork-ai gain${RESET}              see token savings\n"
printf "    ${CYAN}cork-ai report${RESET}            full enterprise report\n"
printf "    ${CYAN}cork-ai report --forecast${RESET}  annual cost projection\n"
printf "\n"
printf "  To use cork-ai in your own code too:\n"
printf "    cd your-project\n"
printf "    ${CYAN}cork-ai init${RESET}              auto-integrate into this project\n"
printf "\n"
