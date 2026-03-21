#!/usr/bin/env bash
# ============================================================
# OmniClaw — Bootstrap Installer (Mac + Linux)
# Installs bare minimum, then launches the app's setup wizard.
#
# Usage:
#   curl -sL https://raw.githubusercontent.com/bigmandad/ClaudeMultiTerminalDesktopApp/main/scripts/bootstrap.sh -o /tmp/cs-bootstrap.sh && bash /tmp/cs-bootstrap.sh
# ============================================================
set -e

# Self-download guard: if piped via curl|bash, save to temp file and re-exec
if [ ! -t 0 ] && [ -z "$CS_BOOTSTRAP_REEXEC" ]; then
  TMPSCRIPT="$(mktemp /tmp/cs-bootstrap.XXXXXX.sh)"
  cat > "$TMPSCRIPT"
  CS_BOOTSTRAP_REEXEC=1 exec bash "$TMPSCRIPT"
fi

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}!${NC} $1"; }

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║     OmniClaw — Quick Setup        ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ── 1. Install Homebrew (Mac only) ───────────────────────
if [ "$(uname -s)" = "Darwin" ]; then
  if ! command -v brew &>/dev/null; then
    warn "Installing Homebrew..."
    NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  fi
  # Persist brew to PATH for this script AND future terminal sessions
  eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv 2>/dev/null)" || true
  if ! grep -q 'brew shellenv' ~/.zprofile 2>/dev/null; then
    echo '' >> ~/.zprofile
    echo 'eval "$(/opt/homebrew/bin/brew shellenv zsh)"' >> ~/.zprofile
  fi
  ok "Homebrew ready"
fi

# ── 2. Install Git + Node.js ────────────────────────────
if ! command -v git &>/dev/null; then
  if [ "$(uname -s)" = "Darwin" ]; then brew install git; else sudo apt-get install -y git; fi
fi
ok "Git found"

if ! command -v node &>/dev/null; then
  if [ "$(uname -s)" = "Darwin" ]; then brew install node; else curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs; fi
  # Refresh PATH after node install
  eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null)" || true
fi
ok "Node.js found: $(node --version)"

# ── 3. Clone app repo ───────────────────────────────────
APP_DIR="$HOME/Documents/ClaudeWorkspace/ClaudeProjects/ClaudeMultiTerminalDesktopApp"
if [ ! -d "$APP_DIR/.git" ]; then
  mkdir -p "$(dirname "$APP_DIR")"
  git clone https://github.com/bigmandad/ClaudeMultiTerminalDesktopApp.git "$APP_DIR"
  ok "App cloned"
else
  ok "App already present"
  cd "$APP_DIR" && git pull --ff-only 2>/dev/null || true
fi

# ── 4. npm install ───────────────────────────────────────
cd "$APP_DIR"
npm install
ok "Dependencies installed"

# ── 5. Create desktop launcher (Mac) ────────────────────
if [ "$(uname -s)" = "Darwin" ]; then
  cat > "$HOME/Desktop/OmniClaw.command" << 'EOF'
#!/bin/bash
cd "$HOME/Documents/ClaudeWorkspace/ClaudeProjects/ClaudeMultiTerminalDesktopApp" && npm start
EOF
  chmod +x "$HOME/Desktop/OmniClaw.command"
  ok "Desktop launcher created"
fi

# ── 6. Launch the app (wizard handles everything else) ──
echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   Launching OmniClaw...           ║"
echo "║   The setup wizard will guide you.       ║"
echo "╚══════════════════════════════════════════╝"
echo ""
npm start
