# OmniClaw Diagnostic & Implementation Plan — 2026-05-17

**Auditor:** Chief Orchestrator (acting as primary auditor — specialist sub-agent dispatch unavailable in this session, so all five role audits collapsed into a single direct codebase pass).
**Scope:** Full audit + auto-fix wiring issues. No code modified.
**OpenViking note:** OV server is hung (Finding #1 from prior session). All context-gathering done by direct codebase reading.

---

## Executive Summary

OmniClaw is feature-rich but riddled with **silently failing integrations** — the kind of bugs that don't crash but produce wrong/empty results that erode trust over time. The five headline issues:

1. **The Watchdog — the very subsystem responsible for self-recovery — is partially broken itself.** Its DB persistence calls (`db.get(sql)`, `db.run(sql)`) target methods that don't exist on the project's namespaced `db` module. Git-push consent never persists across launches. Database integrity probe always returns "File exists" instead of running `PRAGMA integrity_check`. WAL checkpoint auto-fix is a no-op.
2. **MCP tools are silently absent from every multi-LLM / API-provider call.** `ipc-handlers.js:737` and `:784` both reference `mcpManager.instance` — that property never existed; the actual singleton is the closure-captured `mcpManager` declared at `:17`. Result: OpenAI / Gemini / Ollama API providers run with **zero tools** despite all the MCP-bridge plumbing existing.
3. **Peer review (the self-improvement loop's quality gate) double-calls the LLM**, billing tokens twice and producing junk on the second call. `peer-review.js:62-73` streams synthesis to the UI, then re-invokes `sendMessage` on the same session to "collect text" — but the session already has the prior exchange appended, so call #2 is a continuation, not a fresh synthesis.
4. **OpenViking context-seeding blocks PTY spawn for ~30s when OV is hung.** `ipc-handlers.js:38-58` does `await ovClientLocal.search(...)` inside `pty:spawn` with no timeout guard. Every session create stalls if OV is unresponsive (which it currently is, per Finding #1).
5. **The Watchdog UI is completely unwired.** `watchdog.start/stop/status/runNow/consentGitPush/onStatus` are all exposed in preload, registered as IPC handlers, but **zero renderer files reference them.** The watchdog runs in the background invisibly, with no panel, button, toast, or status display. The owner has no way to see what it's doing or grant git-push consent.

Beyond the headliners: ~25 additional findings ranging from orphan preload exports (multi-LLM cancel, OV ingestion controls, plugin-sync UI, all of hooks beyond recent/stats/onEvent), to module-coupling smells (a 2071-line `ipc-handlers.js` doing 21 different concerns, `getMainWindow()` resolved by reaching back into `require('./main')` creating a circular dependency), to a broken `db` interface contract that any future probe author will trip on.

**Headline recommendation:** Tier A auto-fixes are small but high-leverage — fixing the `db.get/run` shim, the `mcpManager.instance` typo, the peer-review double-call, and adding a timeout to OV context-seeding eliminates the most embarrassing silent failures in one short PR. Tier B and Tier C then rebuild reliability infrastructure properly (watchdog UI, zombie detection, observable autoresearch).

---

## Findings by Severity

### Severity 1 — Broken / Silently Failing

#### S1-1: Watchdog `db.get` / `db.run` calls hit undefined methods
- **Location:** `src/main/health/watchdog.js:44`, `:171`, `:181`. Probes in `src/main/health/probes.js:121-130` (turso age check), `:163-173` (DB integrity probe check), `:178-186` (DB integrity fix).
- **Symptom:** Watchdog's git-push consent is never persisted (every launch resets to false). DB integrity probe silently falls through to "File exists" branch. Turso last-sync age check is never read.
- **Root cause:** `src/main/db/database.js:548` exports `{ init, close, sync, runMaintenance, sessions, groups, usage, appState, ... }` — there is no `.get(sql)` or `.run(sql)` method on the exported object. Watchdog and probes were written assuming a raw `better-sqlite3` instance interface; project uses namespaced wrappers.
- **Severity rationale:** Self-recovery layer cannot persist its own state. Whole class of failure modes silently invisible.
- **Self-improvement impact:** YES — watchdog is supposed to be the reliability backbone for the self-improving system.
- **Fix tier:** **A** (add raw `.get`/`.run`/`.prepare` passthrough on the db module, or fix call sites to use `db.appState.get/set` for consent and `db.init().prepare(...)` for ad-hoc SQL).

#### S1-2: `mcpManager.instance` is undefined — MCP tools never reach API providers
- **Location:** `src/main/ipc-handlers.js:737-741` (`provider:send` handler), `:782-786` (`multiLlm:sendToAll` handler).
- **Symptom:** OpenAI / Gemini / Ollama providers and the OmniMode multi-LLM fanout always run with `tools = []` — even when MCP servers are connected and have tools.
- **Root cause:** `src/main/mcp/mcp-manager.js:264` exports only `{ McpManager }` (the class), no `.instance` static. The intended singleton is the `mcpManager = new McpManager()` declared at `ipc-handlers.js:17` — closure-captured. The buggy handlers fetch the module again and look for a non-existent `.instance` property; the `if (mcpManager.instance)` branch is always false.
- **Severity rationale:** Silent feature loss. Multi-LLM peer review is competing answers without tool-use parity, biasing every comparison.
- **Self-improvement impact:** YES — autoresearch headless path (`headless-runner.js`) uses `claude` CLI directly so its tool path is OK, but any multi-provider research / peer review through API providers is tool-less.
- **Fix tier:** **A** (replace `require('./mcp/mcp-manager')` re-import + `.instance` with the closure-captured `mcpManager` singleton).

#### S1-3: Peer review double-calls the LLM with a contaminated session
- **Location:** `src/main/orchestration/peer-review.js:62-73`.
- **Symptom:** Synthesis is billed twice. The user-facing streamed synthesis is the "right" one. The returned synthesis string is a second call on the same session — by then `session.messages` already contains the synthesis-prompt + synthesis-response from call #1 (see `openai-provider.js:70` + `:129`), so call #2 produces a continuation/follow-up, not the synthesis. The orchestrator returns junk.
- **Root cause:** Author wanted both "stream to UI" and "return text for IPC response" but `streamResponse()` doesn't return content, so they re-invoked `sendMessage`. The fix is to collect text DURING the streamed iteration, or to use `streamResponse`'s return-channel.
- **Severity rationale:** Worst kind of bug — looks right in the UI, wrong in the data layer. Any caller that uses the returned synthesis (e.g., `omni-mode.js:78-83` displays it as `_showSynthesis(synthesis.synthesis)`) sees a non-sensical follow-up.
- **Self-improvement impact:** YES — peer review IS the self-improvement quality gate.
- **Fix tier:** **A** (replace the double-call with a single iteration that simultaneously streams to emitter and accumulates `fullSynthesis`).

#### S1-4: OpenViking context-seeding blocks PTY spawn for ~30s when OV is hung
- **Location:** `src/main/ipc-handlers.js:38-58` (inside `pty:spawn`). `ov-client.js:12-56` (`request()` default `timeoutMs=30000`). `ov-client.js:94-101` (`search()` uses default timeout).
- **Symptom:** When OV is hung (current state), creating a new session via the form stalls 30 seconds before the PTY actually spawns. The user sees a frozen UI.
- **Root cause:** Synchronous `await ovClientLocal.search(...)` with no upper time-bound. The catch swallows the error and continues, but only after the timeout elapses.
- **Severity rationale:** Visible UX freeze whenever OV is dead. The OV zombie isn't auto-detected, so this happens silently for days.
- **Self-improvement impact:** YES — OV context-seeding is part of the self-improvement signal; when it fails it should fail FAST, not stall.
- **Fix tier:** **A** (wrap with `Promise.race` and a 2-3s ceiling, or pass `{ timeout: 2000 }` through to `search()`).

#### S1-5: OpenViking server has no zombie detection
- **Location:** `src/main/openviking/ov-server.js:96-118` (`startServer`), `:211-219` (`checkHealth`).
- **Symptom:** Live finding from Finding #1 — `python.exe` PID 30472 has held port 1933 for 2+ days, event-loop deadlocked, every HTTP call times out. OmniClaw's startup detects the port is "in use" (skipping its own spawn) but never tests health; subsequent launches all run with silently-dead OV.
- **Root cause:** `startServer()` line 112 calls `checkHealth()` and treats truthy as "already running externally" (line 113-117), but falsy is the only case that proceeds to spawn. When the port is bound by a corpse, `checkHealth` returns false → tries to spawn a new server → spawn fails to bind → server stays dead.
- **Severity rationale:** Direct cause of Finding #1; affects the entire self-improvement system.
- **Self-improvement impact:** YES — critical.
- **Fix tier:** **B** (need port-occupancy detection + ability to kill the corpse by PID. Cross-platform: needs `lsof` on macOS/Linux, `netstat -ano` + `taskkill` on Windows. Plus watchdog liveness probe + restart-on-failure beyond the current "health check returns true once" semantics.)

#### S1-6: Watchdog UI is completely unwired
- **Location:** Preload `src/preload/preload.js:336-348`. Handlers `src/main/health/watchdog-ipc.js`. Renderer: nothing (verified via grep — no `window.api.watchdog` references anywhere in `src/renderer/`).
- **Symptom:** Watchdog runs every 30s in the background. There is no UI panel, no status badge, no consent button. Git-push remediation cannot be approved by the user. Probe failures produce native notifications via `notifier.showNative` (`watchdog.js:206-208`) but no inline UI.
- **Root cause:** Backend was built without a corresponding renderer panel. Likely deferred during the rebrand.
- **Severity rationale:** Major feature exists but is invisible. User cannot observe self-recovery, cannot grant consent, cannot stop a runaway probe.
- **Self-improvement impact:** YES — self-recovery is opaque.
- **Fix tier:** **B** (build a renderer panel: status badges per probe, last-check time, fix-attempt history, manual "run now" / "grant git push consent" buttons. Should live in the existing system-status panel area at `src/renderer/js/stats/system-status.js`.)

#### S1-7: Discord auto-start runs even when `discord_bot_enabled` is false
- **Location:** `src/main/main.js:204-227`.
- **Symptom:** The auto-start logic only checks `discord_bot_token` exists, then **forces** `discord_bot_enabled = true` (line 210) before starting. A user who explicitly disables the bot will find it re-enabled and reconnected on next launch.
- **Root cause:** The "enabled" flag is treated as a derived value of "token exists" rather than as a user preference.
- **Severity rationale:** Surprising; violates user intent.
- **Self-improvement impact:** No.
- **Fix tier:** **A** (check `db.appState.get('discord_bot_enabled') !== false` before auto-starting; do not write the flag here).

#### S1-8: `mcp:writeTempConfig` handler exposed but no renderer caller — and signature is broken
- **Location:** `src/main/ipc-handlers.js:409-411`. Preload `preload.js:99`.
- **Symptom:** Orphan. Inspection of the handler shows it passes `servers` directly to `writeTempConfig` but the renderer never invokes it. Lower priority — orphan rather than buggy.
- **Self-improvement impact:** No.
- **Fix tier:** **C** (decide: remove or wire up MCP override-per-session feature).

#### S1-9: `app:update` git pull can fast-forward divergent branches into a wedged state
- **Location:** `src/main/ipc-handlers.js:613-661`.
- **Symptom:** `git pull origin main` with `pull.rebase=true` can leave a half-rebased state if there are local commits + conflicts. The handler does `npm install` and `node build.js` regardless of the pull outcome. No verification step that the new code actually loaded.
- **Root cause:** No pre-flight `git status` check; no `git rebase --abort` rescue path.
- **Severity rationale:** Self-update can brick the app. User must manually `git rebase --abort` from a terminal.
- **Self-improvement impact:** No, but it's the channel through which all fixes ship.
- **Fix tier:** **B** (pre-flight clean check; on conflict, abort rebase and surface a "manual update required" toast).

#### S1-10: `app:uploadLog` git push uses `git push origin main` unconditionally
- **Location:** `src/main/ipc-handlers.js:925`.
- **Symptom:** Uploading a diagnostic log always pushes the current branch as `main`, overwriting in flight changes if user is on a feature branch.
- **Root cause:** Hard-coded `main`.
- **Severity rationale:** Data loss risk on non-main branches.
- **Self-improvement impact:** No.
- **Fix tier:** **A** (change to `git push origin HEAD`).

#### S1-11: Multi-LLM cancel button missing — preload export orphan
- **Location:** Preload `preload.js:170`. Handler `ipc-handlers.js:813-820`. Renderer: not called anywhere.
- **Symptom:** OmniMode UI has no way to cancel a fan-out mid-stream. A slow provider blocks `Promise.allSettled` for the full timeout. Users wait without recourse.
- **Self-improvement impact:** YES — long peer reviews can't be interrupted, killing iteration speed.
- **Fix tier:** **B** (add cancel button to OmniMode overlay).

---

### Severity 2 — Degraded / Unreliable Under Load

#### S2-1: `cleanup` is declared twice in `ipc-handlers.js` (function + export)
- **Location:** `src/main/ipc-handlers.js:2039` (function declaration) is referenced at top-level export `:2071`. The module also imports its own `getMainWindow` via `require('./main')` at line 21 (executed inside `registerIpcHandlers`).
- **Symptom:** Latent circular dependency. `main.js` requires `ipc-handlers.js` at top (line 5), then `ipc-handlers.js` requires `main.js` at handler-registration time. Works because the require is inside a function, but fragile.
- **Self-improvement impact:** No (immediate). Refactor risk: YES.
- **Fix tier:** **C** (pass `mainWindow` in as a dependency rather than reaching back).

#### S2-2: Watchdog probe `attemptFix` does not check `gitPushConsented` for non-git probes
- **Location:** `src/main/health/watchdog.js:135-144`.
- **Symptom:** Only the git probe gets the consent flag passed in. Other probes that might want destructive actions (clone repos, pip install) get no equivalent gating. Today `plugins` probe will silently `gh repo clone` + `pip install openviking` — both arguably need consent.
- **Self-improvement impact:** Indirect — autonomous repair without consent can mask deeper problems.
- **Fix tier:** **C** (extend consent system to a finer-grained per-probe consent map).

#### S2-3: Watchdog cooldown logic resets attempts on a successful fix but not on probe-now-healthy
- **Location:** `src/main/health/watchdog.js:145-149`.
- **Symptom:** If a probe spontaneously recovers between checks (e.g., user manually restarts Ollama), the fixHistory still shows attempts=N until the next failure. Cosmetic, but skews the "exhausted" decision.
- **Self-improvement impact:** No.
- **Fix tier:** **C** (also reset fixHistory when probe returns healthy after being down).

#### S2-4: MCP server stdin write has no backpressure handling
- **Location:** `src/main/mcp/mcp-manager.js:98-105` (`_sendJsonRpc`).
- **Symptom:** `proc.stdin.write(json + '\n')` ignores the return value (false → backpressure). Large tool calls or slow servers can OOM the buffer.
- **Self-improvement impact:** Indirect.
- **Fix tier:** **C** (queue writes; respect drain events).

#### S2-5: MCP tool call timeout (30s) is per-call but `proc.on('exit')` cleanup doesn't reject pending promises
- **Location:** `src/main/mcp/mcp-manager.js:55-60` (exit handler), `:211-234` (callTool).
- **Symptom:** If an MCP server crashes mid-call, the pending tool-call Promise stays open until the 30s timeout fires. With many in-flight calls, the system can hang on shutdown.
- **Self-improvement impact:** Indirect.
- **Fix tier:** **B** (in `proc.on('exit')`, reject all `server._pendingCalls`).

#### S2-6: AutoResearch experiment loop has no crash recovery
- **Location:** `src/main/autoresearch/research-engine.js:22-25` (`activeResearch` in-memory Map).
- **Symptom:** All active research state is in-memory. App crash, OS reboot, or `app:restart` wipes the state. The `research_targets` DB row's `status` field is updated to 'running' but the in-memory loop is gone. UI shows "running" forever; restart isn't automatic.
- **Self-improvement impact:** YES — this is THE self-improving loop. It cannot survive a crash.
- **Fix tier:** **B** (on `app.whenReady`, scan `research_targets` for `status='running'` and either auto-resume or mark them `stopped` with a `crashed` flag).

#### S2-7: Headless research per-iteration timeout is 10 min but global session timeout doesn't exist
- **Location:** `src/main/autoresearch/headless-research.js:103`, `headless-runner.js:69-78`.
- **Symptom:** A 20-iteration loop can run up to 20×10min=3h20m. There's a `maxExperiments` cap but no wall-clock cap; the PTY-mode engine has one (`DEFAULTS.timeoutMinutes`) but it isn't enforced for headless.
- **Self-improvement impact:** YES — autoresearch can burn API budget for hours past intent.
- **Fix tier:** **B** (port `timeoutMinutes` check into headless-research loop).

#### S2-8: Headless research stops on `maxConsecutiveDiscards` but not on stagnation
- **Location:** `src/main/autoresearch/headless-research.js:111-114`, `:127-131`, `:195-199`.
- **Symptom:** PTY-mode has stagnation detection (`research-engine.js:387-399`). Headless mode does not. Asymmetric self-improvement signal between the two modes — the "better" headless path is actually less safe.
- **Self-improvement impact:** YES.
- **Fix tier:** **B** (port stagnation check to headless).

#### S2-9: No structured improvement-rate signal anywhere
- **Location:** Entire `src/main/autoresearch/`.
- **Symptom:** The autoresearch system tracks `bestMetricValue` and discards, but there's no rolling improvement-rate metric (e.g., "% experiments that produced a new best in the last 20"). The user has no signal that the system is actually getting better.
- **Self-improvement impact:** YES — this is the meta-loop.
- **Fix tier:** **C** (add a `learning_rate` field computed from `experiments` table: count of `status='keep' AND metric_value=new_best` per window).

#### S2-10: `ApiPtyEmitter` constructed twice per multi-LLM call
- **Location:** `src/main/orchestration/multi-llm-session.js:26` (`_initSubSessions`) creates an emitter per subsession. `ipc-handlers.js:748` creates another for the orchestrator. Doesn't double-emit because they target different sessions, but adds confusion.
- **Self-improvement impact:** No.
- **Fix tier:** **C** (unify emitter ownership).

#### S2-11: `openviking:status` swallows errors when OV is reachable but stats fail
- **Location:** `src/main/ipc-handlers.js:1452-1463`.
- **Symptom:** If the OV server responds to `getStatus()` but the `stats()` call fails (e.g., partial outage), the handler returns the spawn-side `status` without stats. UI sees "running" but no resource counts. No log of the underlying failure.
- **Self-improvement impact:** Minor — visibility.
- **Fix tier:** **C** (include `statsError: e.message` in the response).

#### S2-12: `provider:list` and `provider:models` swallow ALL errors as `[]`
- **Location:** `src/main/ipc-handlers.js:699-720`.
- **Symptom:** If the provider registry hasn't initialized (e.g., `main.js:162` skipped because module load failed), the UI shows "no providers" with no error. Same for `models`.
- **Self-improvement impact:** Diagnostic blind spot.
- **Fix tier:** **A** (log the error before returning `[]`; better: return `{ error: e.message }` envelope).

#### S2-13: Plugin file watcher debounce loses changes during a long burst
- **Location:** `src/main/ipc-handlers.js:1253-1277`.
- **Symptom:** 1.5s debounce — but a steady stream of changes (e.g., during a clone) keeps resetting the timer, so the renderer might not receive `plugins:changed` until the burst ends. For long clones this might be tens of seconds.
- **Self-improvement impact:** Minor.
- **Fix tier:** **C** (add a max-wait of, say, 10s so the renderer at least gets periodic refreshes).

#### S2-14: Discord bot `setupGuild` and `syncExistingSessions` not guarded against partial failures
- **Location:** `src/main/remote/discord-bot.js:102-111`.
- **Symptom:** `setupGuild` errors are caught and logged but `syncExistingSessions` runs even when guild setup failed. Sessions may try to create channels in a category that doesn't exist.
- **Self-improvement impact:** No.
- **Fix tier:** **B** (track which guilds have valid setup; skip session sync for failed ones).

#### S2-15: `openviking.search` in `pty:spawn` uses `tier: 'L0'` without verifying the field is in the response
- **Location:** `src/main/ipc-handlers.js:38-58`.
- **Symptom:** Result parsing assumes `results.resources` and `results.memories` exist on the response. If OV changes its API shape (or returns an error envelope), the parser silently produces empty `ovContext`.
- **Self-improvement impact:** Indirect.
- **Fix tier:** **C** (validate shape, log when results structure differs).

---

### Severity 3 — Architectural Smell / Future Risk

#### S3-1: `ipc-handlers.js` is a 2071-line monolith spanning 21 IPC namespaces
- **Location:** `src/main/ipc-handlers.js`.
- **Symptom:** Single file does PTY, sessions, groups, usage, fs, workspace, MCP, git, transcript, recentPaths, shell, app, auth, providers, multi-LLM, clipboard, notifications, remote, discord, appState, openviking, autoresearch, blackboard, hooks. Reviewing any individual concern requires holding the whole file in mind.
- **Self-improvement impact:** Indirect — the more handlers, the higher the bug rate per change.
- **Fix tier:** **C** (split per-namespace: `ipc/pty.js`, `ipc/openviking.js`, etc., each exporting a `register(ipcMain)` function. Main `ipc-handlers.js` becomes a registry of registries).

#### S3-2: Database module exports namespaces but probes/watchdog expect a SQL-cursor interface
- **Location:** `src/main/db/database.js:548`. Compare expectations at `health/watchdog.js:44`, `health/probes.js:121, 163, 178`.
- **Symptom:** Two implicit contracts for "the db module" coexist in the codebase. New developers will pick one and be wrong half the time.
- **Self-improvement impact:** Indirect.
- **Fix tier:** **C** (formalize: expose `db.raw` for SQL access, keep namespaces as the high-level API. Document in `db/README.md`).

#### S3-3: `getMainWindow` circular require pattern
- **Location:** `src/main/ipc-handlers.js:21` (`const { getMainWindow } = require('./main')`). `src/main/main.js:5` (`require('./ipc-handlers')`).
- **Symptom:** Circular dependency works only because the require in `ipc-handlers.js` is inside `registerIpcHandlers`, executed after `main.js` finishes loading. Refactoring either file's import order will break things.
- **Self-improvement impact:** No.
- **Fix tier:** **C** (pass `mainWindow` accessor as a parameter to `registerIpcHandlers(ipcMain, { getMainWindow })`).

#### S3-4: No central event bus / observability layer
- **Location:** Throughout. Many `console.log` calls, no structured logs, no metrics endpoint, no `npm run logs` tooling.
- **Symptom:** Diagnosing failures (e.g., this very audit) requires reading source. There's no "show me everything that happened in the last 5 minutes" view.
- **Self-improvement impact:** YES — autoresearch is supposed to learn from operational data. There IS no operational data store.
- **Fix tier:** **C** (build a `src/main/observability/event-log.js` that any subsystem can `log({source, level, message, context})` to; surface in a renderer panel; persist to SQLite for 7 days).

#### S3-5: Provider interface has no tool-result feedback path for Gemini / Ollama
- **Location:** `src/main/providers/openai-provider.js:147-151` (`addToolResult`). Compare `gemini-provider.js`, `ollama-provider.js`.
- **Symptom:** Tool use is one-shot — the provider yields `tool_call`, the orchestrator runs the tool, but there's no defined way to feed the result back into the conversation and continue generation. OpenAI provider has `addToolResult` but it's not called from the orchestrator. Gemini and Ollama lack the method entirely.
- **Self-improvement impact:** YES — tool-using multi-LLM responses are crippled.
- **Fix tier:** **B** (define a complete tool-execute loop in the orchestrator that calls `addToolResult` and continues `sendMessage`).

#### S3-6: Lots of orphan preload exports
- **Location:** `src/preload/preload.js`. Grep evidence: zero renderer references to `window.api.watchdog.*`, `window.api.providers.send/cancel/allModels`, `window.api.multiLlm.cancel`, `window.api.openviking.{addResource,extractMemory,ingestHytaleRefs,ingestCodex,ingestTranscript,listMemories}`, `window.api.discord.bindings`, `window.api.pluginSync.*`, `window.api.setup.{detectHytalePath,getMachineId,getWorkspaceRoot,saveTurso,testTurso,checkOllama}`, `window.api.research.{pause,analyzeTarget,bestMetrics,dbTargets,deleteTarget,experiments,stats,status}`, `window.api.hooks.bySession`, `window.api.appState` write paths, `window.api.git.{autoCommit,status,log}`, `window.api.mcp.{listTools,mergedConfig,writeTempConfig}`, `window.api.openviking.tree` (only in pre-cached search but not in OV panel), `window.api.fs.{readFile,stat,readDirDeep}`.
- **Symptom:** Each orphan is either a feature waiting for UI, a feature that was removed but the IPC stayed, or dead code. No way to tell from grep alone.
- **Self-improvement impact:** No, but it inflates the attack surface and confuses future auditors.
- **Fix tier:** **C** (triage each orphan into wire-up / remove / document-as-API-for-future).

#### S3-7: No version-pinning / fingerprint for `program.md` autoresearch programs
- **Location:** `src/main/autoresearch/research-engine.js:85-90`, `program-templates.js`.
- **Symptom:** Each research start overwrites `program.md` with a freshly generated template. If the template-generation logic changes between runs, prior experiments become non-comparable. No record of "which template version produced this metric value".
- **Self-improvement impact:** YES — reproducibility is core to the experiment loop.
- **Fix tier:** **C** (include a template hash in the `experiments` table; persist program.md per-run not per-target).

#### S3-8: OpenViking ingestion has no idempotency guard
- **Location:** `src/main/openviking/ov-ingest.js` (full file). Auto-ingest from `pty:exit` (`ipc-handlers.js:168-188`) sends the entire transcript on every session end.
- **Symptom:** If a user resumes a session multiple times, the same transcript gets re-ingested repeatedly. OV may dedupe by hash, but the round-trip is wasted work.
- **Self-improvement impact:** Minor.
- **Fix tier:** **C** (track last-ingested-hash per session; skip if unchanged).

#### S3-9: Native modules have no rebuild verification on launch
- **Location:** `package.json` rebuild scripts. `better-sqlite3` and `@homebridge/node-pty-prebuilt-multiarch` are native.
- **Symptom:** When the user runs `npm install` via the in-app update, native modules may need rebuilding against the current Electron ABI. No verification step. Silent failures look like "DB not found" or "PTY won't spawn".
- **Self-improvement impact:** No.
- **Fix tier:** **C** (add a startup pre-flight that `require()`s both modules in a try/catch and surfaces a "rebuild required" toast).

#### S3-10: No tests
- **Location:** No `test/` directory; `package.json` has no test script.
- **Symptom:** Every fix is unverified except by running the app. The peer-review double-call bug, the `db.get` bug, the `mcpManager.instance` bug — all would be caught by a 10-line unit test.
- **Self-improvement impact:** YES — autoresearch IS a test framework for code, but the code under test isn't tested itself.
- **Fix tier:** **C** (add minimal unit tests for: `db` exports surface, `watchdog.probes[].check` returns expected shape, `peer-review.synthesize` returns a string, IPC handler registration completes without throw).

---

## Implementation Plan

### Tier A — Auto-Fix Candidates (apply immediately, low risk)

Each item below is one localized change. No architectural decisions required.

1. **Fix watchdog DB persistence** — `src/main/health/watchdog.js:42-48` and `:168-184`
   Replace `deps.db.get("SELECT...")` / `deps.db.run("INSERT/DELETE...")` with `deps.db.appState.get('watchdog_git_push_consented')` (returns parsed JSON) and `deps.db.appState.set('watchdog_git_push_consented', true|null)`.
   Also at `health/probes.js:121-130` (turso last-sync read) and `:163-186` (DB integrity check + WAL checkpoint), either:
   (a) add a thin `db.raw()` getter that returns `db.init()` (the better-sqlite3 instance), then call `.prepare(...).get()/.run()`; or
   (b) move the queries into namespace helpers inside `database.js` (`db.appState.getLastTursoSync()`, `db.maintenance.walCheckpoint()`, `db.maintenance.integrityCheck()`).
   Recommend (a) for minimal surface change.

2. **Fix `mcpManager.instance` bug** — `src/main/ipc-handlers.js:737-741` and `:782-786`
   Inside both handlers, change:
   ```
   const mcpManager = require('./mcp/mcp-manager');
   if (mcpManager.instance) {
     const bridge = new McpBridge(mcpManager.instance);
   ```
   to the closure-captured singleton (already named `mcpManager` at module scope, line 17). Remove the inner `require` — let the outer-scope `mcpManager` be the one used. (Note: rename the outer to `mcpManagerInstance` if the closure shadow is a concern.)

3. **Fix peer-review double-call** — `src/main/orchestration/peer-review.js:62-73`
   Replace the two `sendMessage` calls with a single iteration that both streams to the emitter AND accumulates `fullSynthesis`. Pattern:
   ```js
   const emitter = opts.webContents ? new ApiPtyEmitter(...) : null;
   const generator = actualReviewer.sendMessage(synthesisSessionId, synthesisPrompt);
   let fullSynthesis = '';
   if (emitter) emitter.writeHeader(`Synthesis (${actualReviewer.displayName})`);
   for await (const chunk of generator) {
     if (chunk.type === 'text') {
       fullSynthesis += chunk.content;
       if (emitter) emitter.writeChunk(chunk.content);
     } else if (chunk.type === 'error' && emitter) {
       emitter.writeError(chunk.content);
     }
   }
   if (emitter) emitter.writeDone();
   ```

4. **Add 2s timeout to OV context-seeding** — `src/main/ipc-handlers.js:38-58`
   Wrap the `await ovClientLocal.search(...)` in `Promise.race` with a 2000ms timeout, OR (cleaner) call with explicit timeout:
   Already supported via `ov-client.js:12` — pass a `timeoutMs` arg through. Simplest: `Promise.race([ovClientLocal.search(...), new Promise((_, r) => setTimeout(() => r(new Error('OV seed timeout')), 2000))])`. The catch already swallows errors gracefully.

5. **Discord auto-start respects user-disabled state** — `src/main/main.js:204-227`
   Add at line 208: `const enabled = db.appState.get('discord_bot_enabled'); if (enabled === false) return;` BEFORE the start block. Remove line 210 (`db.appState.set('discord_bot_enabled', true)`) — let the explicit start handler in `ipc-handlers.js:1387-1395` be the only writer of that flag.

6. **`app:uploadLog` push to HEAD not main** — `src/main/ipc-handlers.js:925`
   Change `run('git push origin main')` to `run('git push origin HEAD')`.

7. **Log errors in `provider:list` / `provider:models` instead of swallowing** — `src/main/ipc-handlers.js:699-720`
   Add `console.error('[provider:*] failed:', e.message)` in each catch before returning `[]`.

8. **Add micro-ingest timeout guard** — `src/main/openviking/ov-micro-ingest.js:124-128`
   The `addResource` call already has its own timeout but the default is 120s. For micro-ingest specifically pass `timeout: 5000` to fail fast when OV is hung — micro-ingest is fire-and-forget so we never want it sitting in a 2-min hang.

Estimated apply time for all of Tier A: ~30 minutes including localized testing.

---

### Tier B — Owner-Approval Items (larger / debatable)

1. **Build the watchdog renderer panel.** (Addresses S1-6, S2-2.)
   Add `src/renderer/js/health/watchdog-panel.js`. Show per-probe status badges, last-check time, fix-attempt history. Add a "Run all probes now" button and a "Grant git push consent" / "Revoke" toggle. Integrate into the existing system-status panel area. Estimated: 2-3 hours.

2. **OV zombie detection + auto-recovery.** (Addresses S1-5.)
   Modify `ov-server.js:96-118` to: if `checkHealth()` returns false but the port is bound (cross-platform port-probe via `net.createServer().listen(OV_PORT)` failing with EADDRINUSE), then find and kill the holder by PID, then proceed to spawn. Cross-platform pid-by-port: a small helper `getPidByPort(port)` using `lsof -i:PORT -t` on POSIX and `netstat -ano | findstr :PORT` on Windows. Owner approval needed because killing PIDs by port is destructive. Estimated: 1-2 hours.

3. **AutoResearch crash recovery + headless timeout/stagnation.** (Addresses S2-6, S2-7, S2-8.)
   On `app.whenReady`, scan `research_targets` for `status='running'` and mark them `crashed`. Optionally auto-resume if the user opts in.
   Port `timeoutMinutes` and stagnation detection into `headless-research.js` loop.
   Estimated: 2 hours.

4. **Tool-execution loop completion.** (Addresses S3-5.)
   Wire up `addToolResult` → continue `sendMessage` for OpenAI; add equivalents for Gemini and Ollama. Estimated: 3-4 hours.

5. **Update flow: pre-flight clean check + rebase-abort rescue.** (Addresses S1-9.)
   In `app:update`: before pull, run `git status --porcelain` — if dirty, surface "uncommitted changes, please commit/stash first" toast. After pull, if rebase fails, run `git rebase --abort` and surface a clear error.

6. **MCP server crash cleanup.** (Addresses S2-5.)
   In `mcp-manager.js` `proc.on('exit')` handler, reject all `server._pendingCalls` Promises.

7. **OmniMode cancel button.** (Addresses S1-11.)
   Add a Cancel button to the OmniMode results overlay; wire to `window.api.multiLlm.cancel`.

---

### Tier C — Future-Proofing Roadmap (reliability, observability, self-recovery infrastructure)

#### Reliability & self-recovery

- **Formal probe contract.** Define a `Probe` interface (`check(): Promise<{status, message, fixable, severity}>`, `fix?(): Promise<{success, message}>`, `cooldown?: ms`). Move probes out of `health/probes.js` into per-service modules. Allow third-party probes (plugin probes).
- **Probe coverage gaps.** Add probes for: Discord bot connection health, Turso sync lag, native-module loadability, Claude CLI version + auth state, disk space in `~/.omniclaw/`, `node_modules` integrity (check `package-lock.json` checksum).
- **Liveness probes vs readiness probes.** Today every probe is a readiness probe (does it respond?). Add liveness probes (is it making progress? — e.g., has OV's `ov.conf`-mtime changed in the last hour? has autoresearch produced an experiment in the last N minutes?).
- **Restart back-pressure.** Watchdog's cooldown is per-probe; add a global cap of "no more than 1 destructive fix every 60s" to prevent restart storms.
- **Per-subsystem on/off switches surfaced in settings.** User should be able to disable: Discord auto-start, OV auto-start, Watchdog, micro-ingest, OV context-seeding, Turso sync, AutoResearch persistence.

#### Observability

- **Structured logging.** Replace `console.log` with a `log.js` helper that writes JSON lines to `~/.omniclaw/logs/YYYY-MM-DD.jsonl` and rotates. Each entry: `{ts, source, level, message, ctx}`.
- **In-app log viewer.** A renderer panel that tails today's log file. Filter by source. (Already an `app:uploadLog` for diagnostic — generalize.)
- **Metrics surface.** A simple in-memory ring buffer of `{name, value, ts}` exposed via `window.api.metrics.snapshot()`. Subsystems push metrics; renderer renders sparklines. Most valuable: `experiments_per_hour`, `ov_seed_duration_ms_p95`, `mcp_tool_call_duration_ms_p95`, `watchdog_fixes_per_hour`.
- **Crash dump on uncaughtException.** Currently `EPIPE` swallow only. Add a structured crash dump under `~/.omniclaw/crashes/` for everything else, with the last 50 log lines included.

#### Self-improving intelligence operations

- **Improvement-rate metric for AutoResearch.** (Addresses S2-9.) Add `learning_rate` column to `research_targets`: rolling-window `keep / total` ratio. Surface as a chart per target. Stop research automatically if it drops below 5% over 20 experiments.
- **Program version pinning.** (Addresses S3-7.) Persist program.md per-run under `~/.omniclaw/autoresearch/{targetId}/runs/{startedAt}/program.md`. Include `program_hash` column in `experiments`.
- **Peer-review quality scoring.** Today synthesis just produces text. Score it: did each model agree? Was there a high-confidence consensus? Did the synthesizer cite both/all sources? Add this as a separate `peer_review_quality` table.
- **OV idempotency.** (Addresses S3-8.) Track `transcript_hash` per session — skip auto-ingest if unchanged.
- **End-to-end test for self-improvement.** A reference target (something with deterministic metrics, e.g., "minimize a known JS function's runtime") run nightly via the headless path; metric should monotonically improve. If it doesn't, page the user.

#### Architecture

- **Split `ipc-handlers.js`.** (Addresses S3-1.) Each IPC namespace → own file in `src/main/ipc/`. Single registrar in `src/main/ipc/index.js`.
- **Eliminate circular `main` ↔ `ipc-handlers` require.** (Addresses S3-3.) Pass `getMainWindow` accessor in via DI.
- **Formalize db interface.** (Addresses S3-2.) Document the two-tier API (namespaced helpers + escape-hatch `.raw`). Add JSDoc and a `db/README.md`.
- **Provider interface unification.** All providers should support: `models()`, `createSession(id, opts)`, `sendMessage(id, msg, tools)` returning AsyncIterable, `addToolResult(id, callId, result)`, `cancelGeneration(id)`, `destroy(id)`. Today only OpenAI is complete.
- **Tests.** (Addresses S3-10.) Vitest + jsdom or just a tiny `node:test` runner. Cover: db exports, watchdog probe shapes, peer-review fan-out, IPC registration.

---

## Sequencing

**Phase 1 (this week, after Tier A applied):**
Tier A all (1-8). Verify with a fresh launch: kill OV → confirm pty:spawn no longer stalls; toggle watchdog git consent → confirm it persists across restart; trigger OmniMode with MCP tools → confirm tools are visible to providers; trigger synthesis → confirm streamed and returned text match.

**Phase 2 (next 1-2 weeks, after Tier A verification):**
Tier B in this order:
1. Watchdog renderer panel (B-1) — gives the owner visibility into everything else
2. OV zombie detection (B-2) — directly fixes Finding #1
3. AutoResearch crash recovery + headless timeout (B-3) — protects the self-improvement loop
4. Update flow safety (B-5) — protects all future fixes
5. MCP server crash cleanup (B-6)
6. Tool-execution loop completion (B-4) — bigger change, may need its own PR
7. OmniMode cancel button (B-7)

**Phase 3 (ongoing, Tier C):**
Start with: structured logging (Observability) and the formal probe contract (Reliability). These unlock everything else in C — once you have logs and probes-as-data, the rest of C is straightforward to incrementally add.

**Hard dependencies:**
- B-1 (watchdog panel) depends on A-1 (db persistence) — otherwise the panel will show wrong consent state.
- B-2 (zombie detection) depends on A-4 (OV timeout guard) being live — so the panel that displays the zombie state doesn't itself hang.
- B-3 (autoresearch crash recovery) depends on B-1 being shippable — the renderer needs a way to show "crashed" state.
- All C-Observability work depends on Phase 1 being verified — adding metrics around buggy code masks bugs.

---

## Final notes for the apply step

When applying Tier A, the touch list is:
- `src/main/health/watchdog.js` (2 spots: ~line 44, ~line 171-184)
- `src/main/health/probes.js` (3 spots: ~line 121, ~line 163, ~line 178) — only if option (a) chosen (add `db.raw`)
- `src/main/db/database.js` (1 spot: ~line 548 to add `raw` getter) — only if option (a)
- `src/main/ipc-handlers.js` (5 spots: ~line 38, ~line 698-720, ~line 737, ~line 784, ~line 925)
- `src/main/orchestration/peer-review.js` (1 spot: lines 62-73)
- `src/main/main.js` (1 spot: ~line 207-211)
- `src/main/openviking/ov-micro-ingest.js` (1 spot: ~line 124)

Suggest applying as a single commit titled "Fix silent failures in watchdog, MCP bridge, peer review, and OV seeding" with body listing all 8 changes. After commit, the owner should restart the app and:
1. Confirm a fresh launch is faster (no OV 30s stall).
2. Confirm `window.api.watchdog.consentGitPush()` from devtools persists across reload (open devtools → run → reload → run `window.api.watchdog.status()` → verify `gitPushConsented: true`).
3. Confirm OmniMode peer-review synthesis shown in UI matches what's returned (compare streamed text with `synthesis.synthesis` value in devtools).

End of audit.
