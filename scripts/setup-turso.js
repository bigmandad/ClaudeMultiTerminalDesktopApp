#!/usr/bin/env node
/**
 * Turso setup helper for Claude Sessions.
 *
 * Usage:
 *   node scripts/setup-turso.js          — Check status and print instructions
 *   node scripts/setup-turso.js --write  — Interactively write env vars to ~/.claude-sessions/.env
 *
 * This script does NOT modify any application code. It only:
 *   1. Checks if the Turso CLI is installed
 *   2. Reports whether TURSO_DATABASE_URL / TURSO_AUTH_TOKEN are already set
 *   3. Prints clear manual-setup instructions
 *   4. Optionally writes the vars to ~/.claude-sessions/.env (with --write flag)
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const readline = require('readline');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ENV_DIR = path.join(os.homedir(), '.claude-sessions');
const ENV_PATH = path.join(ENV_DIR, '.env');

function heading(text) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${text}`);
  console.log('='.repeat(60));
}

function bullet(label, value) {
  console.log(`  ${label.padEnd(24)} ${value}`);
}

// ---------------------------------------------------------------------------
// 1. Check Turso CLI
// ---------------------------------------------------------------------------

function checkTursoCLI() {
  heading('Turso CLI');
  try {
    const version = execSync('turso --version', { encoding: 'utf8', timeout: 5000 }).trim();
    bullet('Installed:', version);
    return true;
  } catch {
    bullet('Installed:', 'NO');
    console.log('\n  Install the Turso CLI:');
    console.log('    Windows (PowerShell):  irm https://get.tur.so/install.ps1 | iex');
    console.log('    macOS / Linux:         curl -sSfL https://get.tur.so/install.sh | bash');
    console.log('    npm:                   npm install -g @tursodatabase/cli');
    return false;
  }
}

// ---------------------------------------------------------------------------
// 2. Check existing env vars
// ---------------------------------------------------------------------------

function checkEnvVars() {
  heading('Environment Variables');

  const url = process.env.TURSO_DATABASE_URL || null;
  const token = process.env.TURSO_AUTH_TOKEN || null;

  bullet('TURSO_DATABASE_URL:', url ? url : '(not set)');
  bullet('TURSO_AUTH_TOKEN:', token ? `${token.slice(0, 8)}...` : '(not set)');

  // Also check the .env file
  if (fs.existsSync(ENV_PATH)) {
    console.log(`\n  .env file found at: ${ENV_PATH}`);
    const content = fs.readFileSync(ENV_PATH, 'utf8');
    const lines = content.split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#'));
    for (const line of lines) {
      const eqIdx = line.indexOf('=');
      if (eqIdx > 0) {
        const key = line.slice(0, eqIdx).trim();
        const val = line.slice(eqIdx + 1).trim();
        if (key === 'TURSO_DATABASE_URL') {
          bullet('.env URL:', val);
        } else if (key === 'TURSO_AUTH_TOKEN') {
          bullet('.env TOKEN:', val.length > 8 ? `${val.slice(0, 8)}...` : val);
        }
      }
    }
  } else {
    console.log(`\n  No .env file at: ${ENV_PATH}`);
  }

  return { url, token };
}

// ---------------------------------------------------------------------------
// 3. Print manual setup instructions
// ---------------------------------------------------------------------------

function printInstructions() {
  heading('Setup Instructions');
  console.log(`
  1. Create a Turso account:
       turso auth signup          (or visit https://turso.tech)

  2. Create a database:
       turso db create claude-sessions

  3. Get the database URL:
       turso db show claude-sessions --url
     Copy the libsql://... URL.

  4. Create an auth token:
       turso db tokens create claude-sessions
     Copy the token string.

  5. Save them so Claude Sessions can find them.
     Either run this script with --write:
       node scripts/setup-turso.js --write

     Or manually create ${ENV_PATH} with:
       TURSO_DATABASE_URL=libsql://your-db-name-your-org.turso.io
       TURSO_AUTH_TOKEN=your-token-here

  6. Restart Claude Sessions. The app will pick up the .env file
     automatically and switch to embedded-replica mode.
`);
}

// ---------------------------------------------------------------------------
// 4. Interactive --write mode
// ---------------------------------------------------------------------------

async function writeEnvFile() {
  heading('Write .env File');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(resolve => rl.question(q, resolve));

  // Check for existing file
  if (fs.existsSync(ENV_PATH)) {
    const overwrite = await ask(`  ${ENV_PATH} already exists. Overwrite? (y/N) `);
    if (overwrite.toLowerCase() !== 'y') {
      console.log('  Aborted.');
      rl.close();
      return;
    }
  }

  const url = await ask('  TURSO_DATABASE_URL (libsql://...): ');
  const token = await ask('  TURSO_AUTH_TOKEN: ');
  rl.close();

  if (!url.trim() || !token.trim()) {
    console.log('\n  Both values are required. Aborted.');
    return;
  }

  // Ensure directory exists
  if (!fs.existsSync(ENV_DIR)) {
    fs.mkdirSync(ENV_DIR, { recursive: true });
  }

  const content = [
    '# Turso Cloud configuration for Claude Sessions',
    `# Generated by setup-turso.js on ${new Date().toISOString()}`,
    '',
    `TURSO_DATABASE_URL=${url.trim()}`,
    `TURSO_AUTH_TOKEN=${token.trim()}`,
    '',
  ].join('\n');

  fs.writeFileSync(ENV_PATH, content, 'utf8');
  console.log(`\n  Written to ${ENV_PATH}`);
  console.log('  Restart Claude Sessions to activate cloud sync.');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('Claude Sessions — Turso Setup Helper');

  checkTursoCLI();
  checkEnvVars();

  if (process.argv.includes('--write')) {
    await writeEnvFile();
  } else {
    printInstructions();
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
