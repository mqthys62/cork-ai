#!/bin/sh
# cork-ai installer — https://github.com/mqthys62/cork-ai
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/mqthys62/cork-ai/main/scripts/install.sh | sh

set -e

REPO="mqthys62/cork-ai"
INSTALL_DIR="$HOME/.local/bin"

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

# ─── OS / Arch detection ──────────────────────────────────────────────────────

OS="$(uname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m 2>/dev/null)"

case "$OS" in
  linux*)  PLATFORM="linux"  ;;
  darwin*) PLATFORM="darwin" ;;
  msys*|cygwin*|mingw*) PLATFORM="windows" ;;
  *) fail "Unsupported OS: $OS — download manually from https://github.com/${REPO}/releases" ;;
esac

case "$ARCH" in
  x86_64|amd64)  ARCH_NAME="x64"   ;;
  aarch64|arm64) ARCH_NAME="arm64" ;;
  *) warn "Unknown arch: $ARCH — defaulting to x64"; ARCH_NAME="x64" ;;
esac

BINARY_NAME="cork-ai-${PLATFORM}-${ARCH_NAME}"
info "Platform: ${PLATFORM}-${ARCH_NAME}"

# ─── Find latest release ──────────────────────────────────────────────────────

printf "\n  Fetching latest release...\n"

if command -v curl >/dev/null 2>&1; then
  FETCH="curl -fsSL"
elif command -v wget >/dev/null 2>&1; then
  FETCH="wget -qO-"
else
  fail "curl or wget is required. Install one and retry."
fi

API_URL="https://api.github.com/repos/${REPO}/releases/latest"
LATEST_TAG="$(eval "$FETCH \"$API_URL\"" 2>/dev/null | grep '"tag_name"' | sed 's/.*"tag_name": *"\(.*\)".*/\1/' | head -1)"

if [ -z "$LATEST_TAG" ]; then
  fail "Could not fetch latest release. Check https://github.com/${REPO}/releases"
fi

DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${LATEST_TAG}/${BINARY_NAME}"
ok "Latest: ${LATEST_TAG}"

# ─── Download ─────────────────────────────────────────────────────────────────

mkdir -p "$INSTALL_DIR"
DEST="${INSTALL_DIR}/cork-ai"

printf "\n  Downloading ${BINARY_NAME}...\n"

if command -v curl >/dev/null 2>&1; then
  curl -fsSL --progress-bar -o "$DEST" "$DOWNLOAD_URL" || fail "Download failed: $DOWNLOAD_URL"
else
  wget -q --show-progress -O "$DEST" "$DOWNLOAD_URL" || fail "Download failed: $DOWNLOAD_URL"
fi

chmod +x "$DEST"
ok "Downloaded to ${DEST}"

# ─── PATH setup ───────────────────────────────────────────────────────────────

if ! echo ":$PATH:" | grep -q ":$INSTALL_DIR:"; then
  warn "${INSTALL_DIR} is not in your PATH."
  printf "\n  Adding it now...\n"

  SHELL_NAME="$(basename "${SHELL:-sh}")"
  RC=""
  case "$SHELL_NAME" in
    zsh)  RC="$HOME/.zshrc"  ;;
    bash) RC="$HOME/.bashrc" ;;
    *)    RC="$HOME/.profile" ;;
  esac

  LINE="export PATH=\"\$HOME/.local/bin:\$PATH\""

  if [ -n "$RC" ] && [ -f "$RC" ] && ! grep -q '.local/bin' "$RC" 2>/dev/null; then
    printf '\n%s\n' "$LINE" >> "$RC"
    info "Added to ${RC}"
    info "Run: source ${RC}   (or open a new terminal)"
  else
    info "Add this line to your shell config:"
    printf "\n    ${CYAN}${LINE}${RESET}\n\n"
  fi

  export PATH="$INSTALL_DIR:$PATH"
fi

# Verify
if ! command -v cork-ai >/dev/null 2>&1; then
  # Try running directly
  if "$DEST" --version >/dev/null 2>&1; then
    ok "$($DEST --version)"
    warn "cork-ai not in PATH yet — open a new terminal or run: source ~/.bashrc"
    printf "\n  Continuing setup with direct path...\n"
    CORK_AI="$DEST"
  else
    fail "Binary downloaded but not executable. Try: chmod +x $DEST"
  fi
else
  ok "$(cork-ai --version)"
  CORK_AI="cork-ai"
fi

# ─── Claude Code hooks ────────────────────────────────────────────────────────

printf "\n  Setting up Claude Code integration...\n"

if "$CORK_AI" hooks install 2>/dev/null; then
  ok "Claude Code hook installed"
  info "All your Claude Code sessions will now compress Read outputs automatically."
  info "No per-project setup needed — works across all projects."
else
  warn "Could not configure Claude Code hooks automatically."
  printf "\n  Run once your shell is refreshed: ${CYAN}cork-ai hooks install${RESET}\n"
fi

# ─── Done ─────────────────────────────────────────────────────────────────────

printf "\n"
printf '%s\n' "────────────────────────────────────────────────────"
printf "  ${BOLD}${GREEN}Done.${RESET} Restart Claude Code to activate.\n"
printf "\n"
printf "  ${CYAN}cork-ai gain${RESET}              see token savings\n"
printf "  ${CYAN}cork-ai report${RESET}            full enterprise report\n"
printf "  ${CYAN}cork-ai report --forecast${RESET}  annual projection\n"
printf "\n"
printf "  To integrate into your own code:\n"
printf "  cd your-project && ${CYAN}cork-ai init${RESET}\n"
printf "\n"
