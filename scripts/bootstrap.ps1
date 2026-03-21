# ============================================================
# Claude Sessions — Bootstrap Installer (Windows PowerShell)
# Installs bare minimum, then launches the app's setup wizard.
#
# Usage:
#   irm https://raw.githubusercontent.com/bigmandad/ClaudeMultiTerminalDesktopApp/main/scripts/bootstrap.ps1 | iex
# ============================================================
$ErrorActionPreference = "Stop"

function Ok($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  [!!] $msg" -ForegroundColor Yellow }

Write-Host ""
Write-Host "  ==========================================" -ForegroundColor Cyan
Write-Host "    Claude Sessions - Quick Setup            " -ForegroundColor Cyan
Write-Host "  ==========================================" -ForegroundColor Cyan
Write-Host ""

# ── 1. Install Git + Node.js ────────────────────────────
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Warn "Installing Git..."
    winget install Git.Git --accept-source-agreements --accept-package-agreements
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
}
Ok "Git found"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Warn "Installing Node.js..."
    winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
}
Ok "Node.js found: $(node --version)"

# ── 2. Clone app repo ───────────────────────────────────
$AppDir = "$env:USERPROFILE\Documents\ClaudeWorkspace\ClaudeProjects\ClaudeMultiTerminalDesktopApp"
if (-not (Test-Path "$AppDir\.git")) {
    $Parent = Split-Path $AppDir -Parent
    New-Item -ItemType Directory -Path $Parent -Force | Out-Null
    git clone https://github.com/bigmandad/ClaudeMultiTerminalDesktopApp.git $AppDir
    Ok "App cloned"
} else {
    Ok "App already present"
    Push-Location $AppDir; git pull --ff-only 2>$null; Pop-Location
}

# ── 3. npm install ───────────────────────────────────────
Push-Location $AppDir
npm install
Pop-Location
Ok "Dependencies installed"

# ── 4. Create desktop shortcut ───────────────────────────
$Desktop = [Environment]::GetFolderPath("Desktop")
$Shell = New-Object -ComObject WScript.Shell
$Shortcut = $Shell.CreateShortcut("$Desktop\Claude Sessions.lnk")
$Shortcut.TargetPath = (Get-Command npm).Source
$Shortcut.Arguments = "start"
$Shortcut.WorkingDirectory = $AppDir
$IconPath = "$AppDir\assets\icon.ico"
if (Test-Path $IconPath) { $Shortcut.IconLocation = $IconPath }
$Shortcut.WindowStyle = 7
$Shortcut.Save()
Ok "Desktop shortcut created"

# ── 5. Launch the app ────────────────────────────────────
Write-Host ""
Write-Host "  ==========================================" -ForegroundColor Green
Write-Host "    Launching Claude Sessions...             " -ForegroundColor Green
Write-Host "    The setup wizard will guide you.         " -ForegroundColor Green
Write-Host "  ==========================================" -ForegroundColor Green
Write-Host ""
Push-Location $AppDir
npm start
Pop-Location
