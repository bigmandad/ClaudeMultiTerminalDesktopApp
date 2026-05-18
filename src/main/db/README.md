# Database module (`src/main/db/`)

Two-tier API. Pick the tier that fits the call site.

## Tier 1: Namespaced helpers (preferred)

These wrap common operations and handle JSON encoding / column-name mapping for
you. Reach for these first.

```js
const db = require('./db/database');

await db.init();                         // run schema, return better-sqlite3 instance
db.sessions.list();                      // → [{ id, name, ... }]
db.appState.get('discord_bot_enabled');  // → parsed value (or null)
db.appState.set('feature_flag', true);   // value is JSON-stringified on write
db.researchTargets.update(id, { status: 'idle' });
db.experiments.record({ targetId, metricName, metricValue, status, ... });
db.peerReview.record({ sessionId, qualityScore, jaccardOverlap, ... });
```

Available namespaces (from `database.js` exports):
- `sessions` — terminal session metadata
- `groups` — session groups
- `usage` — token/cost stats
- `appState` — generic key/value (JSON-encoded values)
- `recentPaths` — file/folder MRU per session
- `researchTargets` — AutoResearch target rows
- `experiments` — AutoResearch experiment results
- `peerReview` — multi-LLM peer review quality scores
- `blackboard` — cross-session shared state with optional TTL
- `hookEvents` — Claude Code lifecycle event log
- `channelBindings` — Discord channel ↔ session mappings

Every namespace's methods are documented inline in `database.js`. Read those
before adding a new operation — chances are it already exists.

## Tier 2: Raw SQL (escape hatch)

For ad-hoc queries that don't fit a namespace — `PRAGMA` calls, schema
introspection, one-off reporting — use `db.raw()` to get the underlying
better-sqlite3 instance.

```js
const db = require('./db/database');

const result = db.raw().prepare('PRAGMA integrity_check(1)').get();
const cols   = db.raw().prepare('PRAGMA table_info(experiments)').all();
const count  = db.raw().prepare('SELECT COUNT(*) AS c FROM experiments').get().c;
```

**`db.raw()` returns the same singleton each call** — calling `init()`
under the hood. Cache the return value if you make many calls in a tight loop.

### When to add a new namespace vs. use `db.raw`

- Use `db.raw` for one-shot, ad-hoc, or non-table-coupled queries (PRAGMAs,
  schema migrations, debugging).
- Add a new namespace when:
  - Two or more call sites would otherwise duplicate the same prepared
    statement.
  - The data involves JSON encoding/decoding of fields.
  - The operation participates in a domain concept (research, sessions, etc.).

## Why this two-tier design

The audit on 2026-05-17 found that `watchdog.js` and `health/probes.js` were
calling `db.get(sql)` / `db.run(sql)` as if `db` were a raw `better-sqlite3`
instance, but the module exports namespaced wrappers — so those calls hit
`undefined.get` and silently no-op'd. The git-push consent flag was never
persisted, the DB integrity probe was a no-op, and the WAL checkpoint never
ran. By formalizing the two contracts (`db.<namespace>.<op>` for everything
domain-coupled, `db.raw()` for raw SQL), future call sites have a clear
contract instead of two incompatible implicit ones.

## Schema migrations

The schema is in `schema.sql` and applied via `db.exec()` on every `init()`
(idempotent — all `CREATE TABLE` and `CREATE INDEX` statements use
`IF NOT EXISTS`).

SQLite has no `ALTER TABLE ADD COLUMN IF NOT EXISTS`. For new columns on
existing tables, see the migration block at the top of `init()` in
`database.js` — probe `PRAGMA table_info` for the column and run `ALTER TABLE`
only when missing.

## Turso sync layer

The local SQLite database is the source of truth. A background sync engine
(see `turso-db.js` and `sync/sync-engine.js`) mirrors changes to a remote
Turso replica every 60s when configured. Failures never block the local DB.
Turso credentials live in `~/.omniclaw/.env` (`TURSO_DATABASE_URL` and
`TURSO_AUTH_TOKEN`).
