# ============================================================
# Claude Sessions — One-Command Bootstrap (Windows PowerShell)
# Usage: irm https://raw.githubusercontent.com/bigmandad/ClaudeMultiTerminalDesktopApp/main/scripts/bootstrap.ps1 | iex
# ============================================================
$ErrorActionPreference = "Stop"

$Workspace = "$env:USERPROFILE\Documents\ClaudeWorkspace"
$Projects  = "$Workspace\ClaudeProjects"
$Plugins   = "$Workspace\claude-plugins-custom"

function Ok($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  [!!] $msg" -ForegroundColor Yellow }
function Fail($msg) { Write-Host "  [X]  $msg" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "  ==========================================" -ForegroundColor Cyan
Write-Host "    Claude Sessions - Bootstrap Setup        " -ForegroundColor Cyan
Write-Host "  ==========================================" -ForegroundColor Cyan
Write-Host ""

# ── 1. Install dependencies via winget ────────────────────
function Install-IfMissing($Name, $Check, $WingetId) {
    if (Get-Command $Check -ErrorAction SilentlyContinue) {
        Ok "$Name found"
    } else {
        Warn "Installing $Name..."
        winget install $WingetId --accept-source-agreements --accept-package-agreements
        $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
        Ok "$Name installed"
    }
}

Install-IfMissing "Git"       "git"     "Git.Git"
Install-IfMissing "Node.js"   "node"    "OpenJS.NodeJS.LTS"
Install-IfMissing "Python"    "python"  "Python.Python.3.12"
Install-IfMissing "Java 21"   "java"    "EclipseAdoptium.Temurin.21.JDK"
Install-IfMissing "Ollama"    "ollama"  "Ollama.Ollama"
Install-IfMissing "GitHub CLI" "gh"     "GitHub.cli"

# Claude CLI
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    Warn "Installing Claude CLI..."
    npm install -g @anthropic-ai/claude-code
    Ok "Claude CLI installed"
} else {
    Ok "Claude CLI found"
}

# ── 2. GitHub auth ────────────────────────────────────────
$authStatus = gh auth status 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Warn "GitHub login required. A browser will open..."
    gh auth login --web -p https
    Ok "GitHub authenticated"
} else {
    Ok "GitHub already authenticated"
}

# ── 3. Clone all repos ───────────────────────────────────
New-Item -ItemType Directory -Path $Projects -Force | Out-Null

function Clone-Repo($Repo, $Dest) {
    if (Test-Path "$Dest\.git") {
        Ok "$Repo already cloned"
        Push-Location $Dest; git pull --ff-only 2>$null; Pop-Location
    } else {
        Write-Host "  Cloning $Repo..."
        gh repo clone "bigmandad/$Repo" $Dest 2>$null
        if ($LASTEXITCODE -ne 0) {
            git clone "https://github.com/bigmandad/$Repo.git" $Dest
        }
        Ok "$Repo cloned"
    }
}

Clone-Repo "ClaudeMultiTerminalDesktopApp" "$Projects\ClaudeMultiTerminalDesktopApp"
Clone-Repo "claude-plugins-custom"         $Plugins
Clone-Repo "KingdomsMod"                   "$Projects\KingdomsMod"
Clone-Repo "HytaleModdingPluginRefinementWorkspace" "$Projects\HytaleModdingPluginRefinementWorkspace"
Clone-Repo "MoneyBot"                      "$Projects\MoneyBot"

# ── 4. npm install ────────────────────────────────────────
Write-Host ""
Write-Host "Installing app dependencies..."
Push-Location "$Projects\ClaudeMultiTerminalDesktopApp"
npm install
Pop-Location
Ok "npm dependencies installed"

# ── 5. Ollama embedding model ────────────────────────────
Write-Host ""
Write-Host "Pulling Ollama embedding model..."
try {
    ollama pull qwen3-embedding:4b 2>$null
    Ok "qwen3-embedding:4b ready"
} catch {
    Warn "Ollama not running. Pull model later: ollama pull qwen3-embedding:4b"
}

# ── 6. Turso credentials ─────────────────────────────────
$SessionsDir = "$env:USERPROFILE\.claude-sessions"
New-Item -ItemType Directory -Path $SessionsDir -Force | Out-Null

if (-not (Test-Path "$SessionsDir\.env")) {
    Write-Host ""
    Write-Host "--- Turso Cloud Sync Setup ---" -ForegroundColor Cyan
    Write-Host "Get URL + token from https://turso.tech (free tier)"
    Write-Host ""
    $url = Read-Host "TURSO_DATABASE_URL (or press Enter to skip)"
    if ($url) {
        $token = Read-Host "TURSO_AUTH_TOKEN"
        @"
TURSO_DATABASE_URL=$url
TURSO_AUTH_TOKEN=$token
"@ | Set-Content "$SessionsDir\.env" -Encoding UTF8
        Ok "Turso credentials saved"
    } else {
        Warn "Skipped. App runs local-only. Run later: node scripts\setup-turso.js --write"
    }
} else {
    Ok "Turso credentials already configured"
}

# ── 7. Desktop shortcut ──────────────────────────────────
$Desktop = [Environment]::GetFolderPath("Desktop")
$Shell = New-Object -ComObject WScript.Shell
$Shortcut = $Shell.CreateShortcut("$Desktop\Claude Sessions.lnk")
$Shortcut.TargetPath = (Get-Command npm).Source
$Shortcut.Arguments = "start"
$Shortcut.WorkingDirectory = "$Projects\ClaudeMultiTerminalDesktopApp"
$Shortcut.IconLocation = "$Projects\ClaudeMultiTerminalDesktopApp\assets\icon.ico"
$Shortcut.WindowStyle = 7
$Shortcut.Save()
Ok "Desktop shortcut created"

# ── 8. Done! ──────────────────────────────────────────────
Write-Host ""
Write-Host "  ==========================================" -ForegroundColor Green
Write-Host "          Setup Complete!                    " -ForegroundColor Green
Write-Host "  ==========================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Double-click 'Claude Sessions' on your Desktop to launch."
Write-Host "  The app's first-run wizard will handle the rest."
Write-Host ""
