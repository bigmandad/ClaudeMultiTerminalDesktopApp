# AutoResearch Integration Plan

## Concept: Adapting Karpathy's AutoResearch for Plugin/MCP/Skill Self-Improvement

Karpathy's autoresearch gives an AI agent one file to modify (`train.py`), one fixed evaluation harness (`prepare.py`), and a set of instructions (`program.md`), then loops forever: **modify → run → measure → keep/discard → repeat**. We adapt this exact pattern — but instead of optimizing val_bpb on a neural net, we optimize **quality metrics on Claude plugins, MCPs, and skills**.

The agent runs in a dedicated Claude Sessions terminal pane, autonomously modifying selected targets, testing them, and committing improvements — with all findings ingested into OpenViking for cross-session knowledge persistence.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│  Electron App (Claude Sessions)                             │
│  ┌──────────────────┐  ┌──────────────────────────────────┐ │
│  │  Icon Rail        │  │  AutoResearch Panel              │ │
│  │  [R] button ──────┼──│  Target Selector                 │ │
│  │                   │  │  Experiment Timeline             │ │
│  │                   │  │  Live Metrics Chart              │ │
│  │                   │  │  Knowledge Graph (OV viz)        │ │
│  └──────────────────┘  └────────────┬─────────────────────┘ │
│                                     │ events                 │
│  ┌──────────────────────────────────┴─────────────────────┐ │
│  │  Terminal Pane (dedicated research session)             │ │
│  │  └─ Claude CLI with --dangerously-skip-permissions     │ │
│  │     └─ Reads program.md → modifies target → tests      │ │
│  └──────────────────────────────────┬─────────────────────┘ │
│                                     │ IPC                    │
│  ┌──────────────────────────────────┴─────────────────────┐ │
│  │  Main Process                                          │ │
│  │  ├─ research-engine.js   (orchestration + loop mgmt)   │ │
│  │  ├─ experiment-tracker.js (results.tsv + DB logging)   │ │
│  │  ├─ target-analyzer.js   (scan targets, build context) │ │
│  │  └─ ov-ingest.js         (auto-ingest findings to OV)  │ │
│  └────────────────────────────────────────────────────────┘ │
│                                     │                        │
│  ┌──────────────────────────────────┴─────────────────────┐ │
│  │  OpenViking (port 1933)                                │ │
│  │  ├─ Past experiment results searchable                  │ │
│  │  ├─ Cross-target learnings (what worked before)         │ │
│  │  └─ Knowledge graph of improvements over time           │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

---

## Phase 1: Core Research Engine (Main Process)

### 1A. New file: `src/main/autoresearch/research-engine.js`

Orchestrates the research loop. Responsibilities:
- Manage research session lifecycle (start/stop/pause)
- Build `program.md` dynamically per target type
- Spawn a dedicated Claude CLI session for the research agent
- Monitor PTY output for experiment results (grep for metric lines)
- Parse results and decide keep/discard
- Coordinate with experiment tracker and OpenViking

**Key functions:**
```
startResearch(targetConfig)    — Begin autonomous research on a target
stopResearch(sessionId)        — Gracefully stop a research loop
pauseResearch(sessionId)       — Pause without killing
getResearchStatus(sessionId)   — Current experiment #, metrics, etc.
```

**The Loop (mirrors Karpathy's program.md):**
1. Read target's current source code + tests
2. Query OpenViking for past experiments on this target
3. Generate experiment idea (informed by history)
4. Modify target file(s)
5. Run tests/benchmarks (fixed time budget per target type)
6. Parse metrics from output
7. If improved → git commit on research branch, log "keep"
8. If not → git reset, log "discard"
9. Ingest experiment transcript + results into OpenViking
10. Emit `research:experimentComplete` event → UI updates
11. Repeat

### 1B. New file: `src/main/autoresearch/target-analyzer.js`

Scans and profiles research targets. For each target type:

**Plugin targets** (`~/.claude/plugins/{name}/`):
- Read all source files (JS/MD)
- Detect entry points, hooks, skills, commands
- Find existing tests (if any)
- Measure: lines of code, complexity, error patterns in logs
- Build context document for the research agent

**MCP targets** (`~/.claude/.mcp.json` server entries):
- Read MCP server source code (follow `command` path)
- Catalog available tools via `tools/list` JSON-RPC
- Measure: response latency, error rate, tool coverage
- Build context document

**Skill targets** (`~/.claude/commands/*.md`):
- Read skill source
- Analyze trigger patterns, instruction quality
- Measure: invocation success rate (from session transcripts)
- Build context document

**Output:** A `TargetProfile` object containing:
```javascript
{
  id: 'plugin:hytale-modding',
  type: 'plugin',          // 'plugin' | 'mcp' | 'skill'
  name: 'Hytale Modding',
  sourcePaths: ['~/.claude/plugins/hytale-modding/skills/*.md'],
  editableFiles: ['skills/hytale-plugin-api/SKILL.md', ...],
  readOnlyFiles: [],       // like prepare.py — fixed context
  testCommand: null,       // or 'npm test', 'uv run pytest', etc.
  metrics: {               // baseline measurements
    fileCount: 45,
    totalLines: 59000,
    avgResponseLatency: null,
    errorRate: null,
  },
  programTemplate: 'plugin-improvement',  // which program.md template to use
}
```

### 1C. New file: `src/main/autoresearch/experiment-tracker.js`

Tracks experiments in both TSV (human-readable) and SQLite (queryable).

**TSV file** at `~/.claude-sessions/autoresearch/{targetId}/results.tsv`:
```
commit	metric_value	metric_name	status	description	timestamp
a1b2c3d	0.95	skill_clarity	keep	improved trigger pattern specificity	2026-03-15T10:00:00Z
b2c3d4e	0.92	skill_clarity	discard	over-complicated instruction set	2026-03-15T10:08:00Z
```

**SQLite tables** (added to existing schema):
```sql
CREATE TABLE IF NOT EXISTS research_targets (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,           -- 'plugin' | 'mcp' | 'skill'
  name TEXT NOT NULL,
  source_path TEXT,
  baseline_metrics TEXT,        -- JSON
  best_metrics TEXT,            -- JSON
  total_experiments INTEGER DEFAULT 0,
  total_improvements INTEGER DEFAULT 0,
  status TEXT DEFAULT 'idle',   -- 'idle' | 'active' | 'paused'
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS experiments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_id TEXT NOT NULL,
  session_id TEXT,              -- link to research Claude session
  commit_hash TEXT,
  metric_name TEXT,
  metric_value REAL,
  status TEXT,                  -- 'keep' | 'discard' | 'crash'
  description TEXT,
  diff_summary TEXT,
  duration_seconds REAL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (target_id) REFERENCES research_targets(id)
);
```

### 1D. New file: `src/main/autoresearch/program-templates.js`

Generates `program.md` files tailored to each target type. These are the agent instructions (equivalent to Karpathy's `program.md`).

**Template: `plugin-improvement`**
```markdown
# AutoResearch: Plugin Improvement

## Target: {pluginName}
## Editable files: {editableFiles}
## Read-only context: {readOnlyFiles}

## Goal
Improve this Claude plugin's quality. Metrics:
- Skill clarity: Are instructions unambiguous?
- Trigger accuracy: Does the skill fire for the right prompts?
- Coverage: Are edge cases handled?
- Code quality: Is the implementation clean and correct?

## Rules
- ONLY modify files listed under "Editable files"
- Each experiment: make ONE focused change
- After modifying, verify no syntax errors
- Run any available tests
- Log your changes clearly

## Past experiments (from OpenViking)
{pastExperimentSummary}

## Experiment Loop
1. Read the current state of editable files
2. Identify ONE specific improvement
3. Make the change
4. Test it (if tests exist)
5. Report results in this format:
   ---
   metric_name: {metricName}
   metric_value: {value}
   status: keep|discard
   description: {what you changed}
   ---
6. If improvement, git commit. If not, git reset.
7. NEVER STOP. Continue with next experiment.
```

**Template: `mcp-improvement`** — Similar but focused on:
- Tool response quality
- Error handling robustness
- Missing tool implementations
- Input validation

**Template: `skill-improvement`** — Focused on:
- Instruction clarity and conciseness
- Trigger pattern accuracy
- Example quality
- Edge case handling

---

## Phase 2: IPC Bridge & Preload

### 2A. New IPC handlers in `src/main/ipc-handlers.js`

Add `research:*` namespace:
```
research:listTargets       → targetAnalyzer.scanAll()
research:analyzeTarget     → targetAnalyzer.analyze(targetId)
research:start             → researchEngine.startResearch(config)
research:stop              → researchEngine.stopResearch(sessionId)
research:pause             → researchEngine.pauseResearch(sessionId)
research:status            → researchEngine.getResearchStatus(sessionId)
research:experiments       → experimentTracker.getExperiments(targetId)
research:timeline          → experimentTracker.getTimeline(targetId)
research:bestMetrics       → experimentTracker.getBestMetrics(targetId)
```

### 2B. Preload additions in `src/preload/preload.js`

Add `window.api.research` namespace:
```javascript
research: {
  listTargets:    ()          => ipcRenderer.invoke('research:listTargets'),
  analyzeTarget:  (id)        => ipcRenderer.invoke('research:analyzeTarget', id),
  start:          (config)    => ipcRenderer.invoke('research:start', config),
  stop:           (sessionId) => ipcRenderer.invoke('research:stop', sessionId),
  pause:          (sessionId) => ipcRenderer.invoke('research:pause', sessionId),
  status:         (sessionId) => ipcRenderer.invoke('research:status', sessionId),
  experiments:    (targetId)  => ipcRenderer.invoke('research:experiments', targetId),
  timeline:       (targetId)  => ipcRenderer.invoke('research:timeline', targetId),
  bestMetrics:    (targetId)  => ipcRenderer.invoke('research:bestMetrics', targetId),
  onExperimentComplete: (cb)  => ipcRenderer.on('research:experimentComplete', (_, d) => cb(d)),
  onStatusChanged:      (cb)  => ipcRenderer.on('research:statusChanged', (_, d) => cb(d)),
}
```

---

## Phase 3: Renderer UI — AutoResearch Panel

### 3A. New icon rail button in `index.html`

Add after the OpenViking button (line 35):
```html
<button class="rail-btn" id="autoresearch-rail-btn" data-panel="autoresearch" title="AutoResearch">
  <span class="rail-icon">&#9881;</span>  <!-- gear/research icon -->
</button>
```

Add panel container in left panel area:
```html
<div id="autoresearch-panel" class="panel-content hidden">
  <div class="panel-header">AUTORESEARCH <button class="panel-btn" id="ar-refresh-btn">&#8635;</button></div>
  <div id="ar-content"></div>
</div>
```

### 3B. New file: `src/renderer/js/autoresearch/autoresearch-panel.js`

Main panel with 4 tabs:

**Tab 1: Targets** — Select what to improve
- Lists all detected plugins, MCPs, skills
- Each shows: name, type badge, experiment count, best metric
- Toggle to mark as "research target"
- "Start Research" button per target (or batch)

**Tab 2: Live** — Real-time view during active research
- Current experiment description
- Streaming metrics (parsed from PTY output)
- Keep/discard decision as it happens
- Time elapsed, experiments completed count

**Tab 3: Timeline** — Experiment history
- Scrollable list of all experiments for selected target
- Each entry: commit hash, metric value, status badge (keep/discard/crash), description
- Color-coded: green=keep, red=discard, orange=crash
- Sparkline of metric progression over time

**Tab 4: OpenViking Insights** — Knowledge visualization
- Search OpenViking for past research on this target
- Show cross-target patterns ("changes that tend to work")
- Knowledge graph: target → experiments → findings → improvements
- Display agent memories extracted from research sessions

### 3C. New file: `src/renderer/js/autoresearch/metric-chart.js`

Lightweight inline chart (no dependencies, pure canvas/SVG):
- X-axis: experiment number
- Y-axis: metric value
- Green dots for "keep", red for "discard"
- Trend line showing improvement over time
- Renders in the panel's Live and Timeline tabs

### 3D. New file: `src/renderer/js/autoresearch/target-selector.js`

Target selection UI:
- Grouped sections: Plugins, MCPs, Skills
- Checkbox per target with "Analyze" button
- Shows analysis results: file count, complexity, suggested improvements
- Config per target: which metric to optimize, time budget, max experiments

---

## Phase 4: OpenViking Integration

### 4A. Auto-ingest experiment results

After each experiment completes, `research-engine.js` calls:
```javascript
// Ingest the experiment result as a resource
await ovClient.addResource(experimentLogPath, {
  scope: 'resources',
  reason: `AutoResearch experiment on ${targetName}: ${description}`,
  tags: ['autoresearch', targetId, status, metricName]
});

// Extract learnings as agent memories
await ovClient.extractMemory('autoresearch', experimentSummary, 'research-findings');
```

### 4B. Query past experiments before each new one

Before generating a new experiment idea, the research agent queries OV:
```javascript
const pastFindings = await ovClient.search(
  `improvements to ${targetName} that were kept`,
  { topK: 10, tier: 'L1', tags: ['autoresearch', targetId, 'keep'] }
);
const failures = await ovClient.search(
  `failed experiments on ${targetName}`,
  { topK: 5, tier: 'L0', tags: ['autoresearch', targetId, 'discard'] }
);
```

This context is injected into the `program.md` so the agent doesn't repeat failed approaches and builds on successful ones.

### 4C. Cross-target knowledge transfer

When starting research on a new target, query OV for patterns:
```javascript
const crossPatterns = await ovClient.searchMemories(
  `general improvement patterns for ${targetType}`,
  'autoresearch'
);
```

This enables the agent to apply learnings from improving one plugin to another.

### 4D. OpenViking visualization in the panel

The "OV Insights" tab shows:
- **Resource tree**: Browse `autoresearch/*` resources in OV
- **Memory feed**: Recent agent memories from research sessions
- **Search**: Query OV for any research-related knowledge
- **Stats**: Total resources indexed, memory count, search hit rate

---

## Phase 5: Research Session Spawning

### 5A. Dedicated research sessions

When user clicks "Start Research" on a target:
1. Create a git branch: `autoresearch/{targetId}/{date}`
2. Generate `program.md` from template + OV context
3. Write `program.md` to a temp workspace directory
4. Spawn a Claude CLI session with:
   - `--dangerously-skip-permissions` (autonomous operation)
   - Working directory set to the target's source directory
   - System prompt pointing to the generated `program.md`
5. Assign to a terminal pane so user can watch
6. Monitor PTY output for experiment result markers (`---\nmetric_name:...`)
7. Parse and log each experiment automatically

### 5B. PTY output parsing in `research-engine.js`

Listen for structured output markers:
```javascript
events.on('pty:outputParsed', ({ sessionId, data }) => {
  if (!isResearchSession(sessionId)) return;

  // Detect experiment result block
  const metricMatch = data.match(/^metric_value:\s*([\d.]+)/m);
  const statusMatch = data.match(/^status:\s*(keep|discard|crash)/m);
  const descMatch = data.match(/^description:\s*(.+)/m);

  if (metricMatch && statusMatch) {
    recordExperiment({
      targetId, sessionId,
      metricValue: parseFloat(metricMatch[1]),
      status: statusMatch[1],
      description: descMatch?.[1] || 'no description',
    });
    events.emit('research:experimentComplete', { targetId, ... });
  }
});
```

---

## Phase 6: System Status Integration

### 6A. Research status dot

Add an "R" dot to the system status strip (alongside M/V/O):
- Green: research running, recent improvements found
- Orange: research running, no recent improvements
- Grey: no research active
- Click shows popover with: active targets, experiment count, last improvement

### 6B. Notification integration

- Toast on each experiment completion: "Exp #12: skill_clarity 0.95 → 0.97 [keep]"
- Desktop notification on significant improvements (>5% metric gain)
- Sound notification option (using existing mute system)

---

## File Changes Summary

### New files (8):
```
src/main/autoresearch/research-engine.js     — Core loop orchestration
src/main/autoresearch/target-analyzer.js     — Target scanning & profiling
src/main/autoresearch/experiment-tracker.js  — Results logging (TSV + DB)
src/main/autoresearch/program-templates.js   — Dynamic program.md generation
src/renderer/js/autoresearch/autoresearch-panel.js  — Main panel UI
src/renderer/js/autoresearch/metric-chart.js        — Inline metric visualization
src/renderer/js/autoresearch/target-selector.js     — Target selection UI
src/renderer/styles/autoresearch.css                — Panel styles
```

### Modified files (6):
```
src/renderer/index.html          — Add rail button + panel container
src/renderer/js/app.js           — Import + init autoresearch panel
src/main/ipc-handlers.js         — Add research:* IPC handlers
src/preload/preload.js           — Add window.api.research namespace
src/main/db/schema.sql           — Add research_targets + experiments tables
src/main/db/database.js          — Add research CRUD operations
```

---

## Implementation Order

1. **Schema + Database** — Add tables, CRUD methods
2. **target-analyzer.js** — Scan & profile targets (can test independently)
3. **experiment-tracker.js** — Results logging (can test independently)
4. **program-templates.js** — Template generation (can test independently)
5. **IPC + Preload** — Wire up the bridge
6. **research-engine.js** — Core loop (depends on 1-5)
7. **autoresearch-panel.js** — Main UI (depends on 5)
8. **target-selector.js** — Target picker (depends on 7)
9. **metric-chart.js** — Visualization (depends on 7)
10. **OpenViking auto-ingest** — Wire into research-engine (depends on 6)
11. **Status dot + notifications** — Polish (depends on 6-7)
12. **Build + test** — Full integration test

Estimated: ~14 files touched, ~2000-2500 lines of new code.
