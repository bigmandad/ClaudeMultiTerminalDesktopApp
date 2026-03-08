# Claude Sessions

Multi-pane Electron terminal manager for running multiple `claude` CLI sessions simultaneously.

## Architecture

- **Main process** (`src/main/`): Electron app, IPC handlers, PTY management, SQLite database, MCP server lifecycle, git ops, transcription, notifications
- **Preload** (`src/preload/preload.js`): contextBridge API exposing namespaced IPC channels
- **Renderer** (`src/renderer/`): Single-page app with xterm.js terminals, bundled via esbuild

## Key Technical Details

- **Native modules**: `@homebridge/node-pty-prebuilt-multiarch` (prebuilt, no Python needed) and `better-sqlite3` (prebuild-install for Electron)
- **Bundler**: esbuild bundles `src/renderer/js/app.js` → `dist/renderer.js`
- **PTY strategy**: Spawns PowerShell, then writes `claude [args]\r` into it
- **Database**: SQLite with WAL mode at `~/.claude-sessions/claude-sessions.db`
- **Transcripts**: Written to `~/.claude-sessions/transcripts/{sessionId}/{date}.md`

## Commands

- `npm start` — Build and run
- `npm run dev` — Build and run (dev mode)
- `npm run bundle` — Build renderer bundle only
- `npm run build` — Build for distribution (electron-builder)

## File Structure

- `src/main/` — Main process (14 files)
- `src/preload/` — Preload script (1 file)
- `src/renderer/` — UI layer (40 files: HTML, CSS, JS modules)
- `dist/` — Bundled output (renderer.js, xterm.css)
- `assets/` — Icons, sounds

## IPC Namespaces

`pty:*`, `session:*`, `group:*`, `usage:*`, `fs:*`, `workspace:*`, `mcp:*`, `git:*`, `transcript:*`, `recentPaths:*`, `shell:*`, `app:*`, `clipboard:*`, `notify:*`, `appState:*`
