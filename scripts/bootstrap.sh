#!/usr/bin/env bash
# ============================================================
# Claude Sessions — One-Command Bootstrap (Mac + Linux)
# Usage: curl -sL https://raw.githubusercontent.com/bigmandad/ClaudeMultiTerminalDesktopApp/main/scripts/bootstrap.sh -o /tmp/cs-bootstrap.sh && bash /tmp/cs-bootstrap.sh
# ============================================================
set -e

# Self-download guard: if piped via curl|bash, save to file and re-exec
if [ ! -t 0 ] && [ -z "$CS_BOOTSTRAP_REEXEC" ]; then
  TMPSCRIPT="$(mktemp /tmp/cs-bootstrap.XXXXXX.sh)"
  cat > "$TMPSCRIPT"
  CS_BOOTSTRAP_REEXEC=1 exec bash "$TMPSCRIPT"
fi

WORKSPACE="$HOME/Documents/ClaudeWorkspace"
PROJECTS="$WORKSPACE/ClaudeProjects"
PLUGINS="$WORKSPACE/claude-plugins-custom"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

ok()   { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}!${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1"; exit 1; }

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║     Claude Sessions — Bootstrap Setup    ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ── 1. Detect OS ──────────────────────────────────────────
OS="$(uname -s)"
case "$OS" in
  Darwin*) PLATFORM="mac";;
  Linux*)  PLATFORM="linux";;
  *)       fail "Unsupported OS: $OS";;
esac
ok "Platform: $PLATFORM ($OS)"

# ── 2. Install Homebrew (Mac) ─────────────────────────────
if [ "$PLATFORM" = "mac" ]; then
  if ! command -v brew &>/dev/null; then
    warn "Installing Homebrew..."
    NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv)"
    ok "Homebrew installed"
  else
    ok "Homebrew found"
  fi
fi

# ── 3. Install dependencies ──────────────────────────────
install_if_missing() {
  local name="$1" check="$2" install_mac="$3" install_linux="$4"
  if command -v "$check" &>/dev/null; then
    ok "$name found: $(command -v "$check")"
  else
    warn "Installing $name..."
    if [ "$PLATFORM" = "mac" ]; then
      eval "$install_mac"
    else
      eval "$install_linux"
    fi
    ok "$name installed"
  fi
}

install_if_missing "Git"      "git"    "brew install git"           "sudo apt-get install -y git"
install_if_missing "Node.js"  "node"   "brew install node"          "curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs"
install_if_missing "Python"   "python3" "brew install python"       "sudo apt-get install -y python3"
install_if_missing "Java"     "java"   "brew install openjdk"       "sudo apt-get install -y openjdk-21-jdk"
install_if_missing "Ollama"   "ollama" "brew install ollama"        "curl -fsSL https://ollama.com/install.sh | sh"
install_if_missing "GitHub CLI" "gh"   "brew install gh"            "sudo apt-get install -y gh"

# Claude CLI
if ! command -v claude &>/dev/null; then
  warn "Installing Claude CLI..."
  npm install -g @anthropic-ai/claude-code
  ok "Claude CLI installed"
else
  ok "Claude CLI found"
fi

# ── 4. GitHub auth ────────────────────────────────────────
if ! gh auth status &>/dev/null; then
  echo ""
  warn "GitHub login required. A browser will open..."
  gh auth login --web -p https
  ok "GitHub authenticated"
else
  ok "GitHub already authenticated"
fi

# ── 5. Clone all repos ───────────────────────────────────
mkdir -p "$PROJECTS"

clone_repo() {
  local repo="$1" dest="$2"
  if [ -d "$dest/.git" ]; then
    ok "$repo already cloned"
    cd "$dest" && git pull --ff-only 2>/dev/null && cd - >/dev/null
  else
    echo "  Cloning $repo..."
    gh repo clone "bigmandad/$repo" "$dest" 2>/dev/null || git clone "https://github.com/bigmandad/$repo.git" "$dest"
    ok "$repo cloned"
  fi
}

MODSHOP="$WORKSPACE/HYTALEMODWORKSHOP"
mkdir -p "$MODSHOP"

clone_repo "ClaudeMultiTerminalDesktopApp" "$PROJECTS/ClaudeMultiTerminalDesktopApp"
clone_repo "claude-plugins-custom"         "$PLUGINS"
clone_repo "KingdomsMod"                   "$PROJECTS/KingdomsMod"
clone_repo "CorruptionModSourceCode"       "$MODSHOP/CorruptionMod"
clone_repo "CorruptionModDeployment"       "$MODSHOP/CorruptionModDeployment"
clone_repo "HytaleModdingPluginRefinementWorkspace" "$PROJECTS/HytaleModdingPluginRefinementWorkspace"

# ── 6. npm install ────────────────────────────────────────
echo ""
echo "Installing app dependencies..."
cd "$PROJECTS/ClaudeMultiTerminalDesktopApp"
npm install
ok "npm dependencies installed"

# ── 7. Ollama embedding model ────────────────────────────
echo ""
echo "Pulling Ollama embedding model..."
ollama pull qwen3-embedding:4b 2>/dev/null && ok "qwen3-embedding:4b ready" || warn "Ollama not running — pull model later with: ollama pull qwen3-embedding:4b"

# ── 8. Turso credentials ─────────────────────────────────
SESSIONS_DIR="$HOME/.claude-sessions"
mkdir -p "$SESSIONS_DIR"

if [ ! -f "$SESSIONS_DIR/.env" ]; then
  echo ""
  echo "━━━ Turso Cloud Sync Setup ━━━"
  echo "Your Turso database URL and token enable cross-machine sync."
  echo "Get these from https://turso.tech (free tier)"
  echo ""
  read -p "TURSO_DATABASE_URL (or press Enter to skip): " TURSO_URL
  if [ -n "$TURSO_URL" ]; then
    read -p "TURSO_AUTH_TOKEN: " TURSO_TOKEN
    cat > "$SESSIONS_DIR/.env" << ENVEOF
TURSO_DATABASE_URL=$TURSO_URL
TURSO_AUTH_TOKEN=$TURSO_TOKEN
ENVEOF
    ok "Turso credentials saved to $SESSIONS_DIR/.env"
  else
    warn "Skipped Turso setup. App will run in local-only mode."
    warn "Run later: node scripts/setup-turso.js --write"
  fi
else
  ok "Turso credentials already configured"
fi

# ── 9. Create desktop shortcut (Mac) ─────────────────────
if [ "$PLATFORM" = "mac" ]; then
  APP_ALIAS="$HOME/Desktop/Claude Sessions.command"
  cat > "$APP_ALIAS" << 'CMDEOF'
#!/bin/bash
cd "$HOME/Documents/ClaudeWorkspace/ClaudeProjects/ClaudeMultiTerminalDesktopApp"
npm start
CMDEOF
  chmod +x "$APP_ALIAS"
  ok "Desktop launcher created: Claude Sessions.command"
fi

# ── 10. Done! ─────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════╗"
echo "║          Setup Complete!                 ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "To launch Claude Sessions:"
if [ "$PLATFORM" = "mac" ]; then
  echo "  Double-click 'Claude Sessions' on your Desktop"
  echo "  — or —"
fi
echo "  cd $PROJECTS/ClaudeMultiTerminalDesktopApp && npm start"
echo ""
echo "The app's first-run wizard will handle the rest."
echo ""
