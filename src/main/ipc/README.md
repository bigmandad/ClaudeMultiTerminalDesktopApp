# IPC namespace modules (`src/main/ipc/`)

Per-namespace IPC handler modules. Each file exports a single `register(ipcMain, deps)` function that wires up the handlers for one logical area (logs, metrics, watchdog, providers, etc.).

## Migration in progress

`src/main/ipc-handlers.js` was a 2000+ line monolith spanning 21 IPC namespaces. The audit on 2026-05-17 flagged this as Tier C architectural debt:

> S3-1: ipc-handlers.js is a 2071-line monolith spanning 21 IPC namespaces

This directory is the destination. The migration is intentionally incremental — each namespace can be moved independently and the original handler block removed only after the new module is shown to work in production.

## Migration order (recommended)

Easiest / least coupled first, riskiest last:

1. `log` + `metrics` — done (`observability.js`).
2. `watchdog` — already has its own backing module; extract is mechanical.
3. `clipboard`, `shell`, `notify` — tiny, no shared state.
4. `recentPaths`, `appState`, `transcript` — DB-coupled but localized.
5. `fs`, `workspace`, `git` — file-system + git, share no state with each other.
6. `mcp`, `openviking`, `blackboard`, `hooks` — coupled to module singletons; pass via deps.
7. `pty`, `session`, `group` — touch a lot of state; do these last.
8. `auth`, `provider`, `multiLlm`, `research`, `discord`, `remote`, `setup`, `pluginSync`, `plugins`, `app` — domain-specific, mostly self-contained.

## Module contract

```js
// src/main/ipc/<namespace>.js
function register(ipcMain, deps = {}) {
  ipcMain.handle('<ns>:foo', async (event, ...args) => {
    // ...
    return result;
  });
}
module.exports = { register };
```

`deps` is whatever the namespace needs (db, getMainWindow, mcpManager, etc.). Pass explicitly — no late `require()` reaching back into `main.js`.
