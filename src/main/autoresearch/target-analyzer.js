// ── Target Analyzer — scan plugins, MCPs, skills into profiles ──

const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PLUGINS_DIR = path.join(CLAUDE_DIR, 'plugins');
const COMMANDS_DIR = path.join(CLAUDE_DIR, 'commands');
const MCP_CONFIGS = [
  path.join(CLAUDE_DIR, '.mcp.json'),
  path.join(os.homedir(), '.claude.json'),
];

/**
 * Scan all available research targets across plugins, MCPs, and skills.
 * Returns TargetProfile[] — one per discoverable target.
 */
function scanAll() {
  const targets = [];
  targets.push(...scanPlugins());
  targets.push(...scanMcpServers());
  targets.push(...scanSkills());
  return targets;
}

/**
 * Deep-analyze a single target by ID. Returns full TargetProfile with metrics.
 */
function analyze(targetId) {
  const [type, ...rest] = targetId.split(':');
  const name = rest.join(':');

  switch (type) {
    case 'plugin': return analyzePlugin(name);
    case 'mcp': return analyzeMcp(name);
    case 'skill': return analyzeSkill(name);
    default: return null;
  }
}

// ── Plugin scanning ──────────────────────────────────────

function scanPlugins() {
  const targets = [];
  if (!fs.existsSync(PLUGINS_DIR)) return targets;

  const dirs = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory());

  for (const dir of dirs) {
    const pluginDir = path.join(PLUGINS_DIR, dir.name);
    const skillsDir = path.join(pluginDir, 'skills');
    const hasSkills = fs.existsSync(skillsDir);

    // Count files
    const allFiles = walkFiles(pluginDir, 4);
    const editableFiles = allFiles.filter(f => f.endsWith('.md') || f.endsWith('.js'));

    if (editableFiles.length === 0) continue;

    targets.push({
      id: `plugin:${dir.name}`,
      type: 'plugin',
      name: dir.name,
      sourcePath: pluginDir,
      editableFiles,
      fileCount: allFiles.length,
      editableCount: editableFiles.length,
      hasSkills,
      totalLines: countLines(editableFiles),
    });
  }

  return targets;
}

function analyzePlugin(name) {
  const pluginDir = path.join(PLUGINS_DIR, name);
  if (!fs.existsSync(pluginDir)) return null;

  const allFiles = walkFiles(pluginDir, 4);
  const editableFiles = allFiles.filter(f => f.endsWith('.md') || f.endsWith('.js'));
  const readOnlyFiles = allFiles.filter(f => !editableFiles.includes(f));

  // Look for manifest
  let manifest = null;
  for (const mf of ['.claude-plugin/plugin.json', 'plugin.json', 'package.json']) {
    const p = path.join(pluginDir, mf);
    if (fs.existsSync(p)) {
      try { manifest = JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { /* ignore */ }
      break;
    }
  }

  // Categorize files by type
  const skillFiles = editableFiles.filter(f => f.includes('/skills/') || f.includes('\\skills\\'));
  const hookFiles = editableFiles.filter(f => f.includes('/hooks/') || f.includes('\\hooks\\'));
  const commandFiles = editableFiles.filter(f => f.includes('/commands/') || f.includes('\\commands\\'));

  return {
    id: `plugin:${name}`,
    type: 'plugin',
    name: manifest?.name || name,
    description: manifest?.description || '',
    version: manifest?.version || null,
    sourcePath: pluginDir,
    editableFiles,
    readOnlyFiles,
    skillFiles,
    hookFiles,
    commandFiles,
    fileCount: allFiles.length,
    editableCount: editableFiles.length,
    totalLines: countLines(editableFiles),
    metrics: {
      skillCount: skillFiles.length,
      hookCount: hookFiles.length,
      commandCount: commandFiles.length,
      avgFileSize: editableFiles.length > 0
        ? Math.round(editableFiles.reduce((s, f) => s + fileSize(f), 0) / editableFiles.length)
        : 0,
    },
    programTemplate: 'plugin-improvement',
  };
}

// ── MCP server scanning ──────────────────────────────────

function scanMcpServers() {
  const targets = [];
  const config = readMcpConfig();
  if (!config) return targets;

  for (const [name, serverConf] of Object.entries(config)) {
    if (!serverConf || typeof serverConf !== 'object') continue;
    const command = serverConf.command || '';
    const args = serverConf.args || [];

    // Try to find source files if the server is a local script
    let sourcePath = null;
    let editableFiles = [];
    const lastArg = args[args.length - 1];
    if (lastArg && fs.existsSync(lastArg)) {
      const stat = fs.statSync(lastArg);
      if (stat.isFile()) {
        sourcePath = path.dirname(lastArg);
        editableFiles = [lastArg];
      } else if (stat.isDirectory()) {
        sourcePath = lastArg;
        editableFiles = walkFiles(lastArg, 3).filter(f =>
          f.endsWith('.js') || f.endsWith('.ts') || f.endsWith('.py')
        );
      }
    }

    targets.push({
      id: `mcp:${name}`,
      type: 'mcp',
      name,
      sourcePath,
      editableFiles,
      command,
      args,
      fileCount: editableFiles.length,
      editableCount: editableFiles.length,
      totalLines: countLines(editableFiles),
    });
  }

  return targets;
}

function analyzeMcp(name) {
  const config = readMcpConfig();
  if (!config || !config[name]) return null;

  const serverConf = config[name];
  const command = serverConf.command || '';
  const args = serverConf.args || [];

  let sourcePath = null;
  let editableFiles = [];
  let readOnlyFiles = [];
  const lastArg = args[args.length - 1];
  if (lastArg && fs.existsSync(lastArg)) {
    const stat = fs.statSync(lastArg);
    if (stat.isFile()) {
      sourcePath = path.dirname(lastArg);
      editableFiles = [lastArg];
    } else if (stat.isDirectory()) {
      sourcePath = lastArg;
      const all = walkFiles(lastArg, 3);
      editableFiles = all.filter(f =>
        f.endsWith('.js') || f.endsWith('.ts') || f.endsWith('.py')
      );
      readOnlyFiles = all.filter(f =>
        f.endsWith('.json') || f.endsWith('.toml')
      );
    }
  }

  return {
    id: `mcp:${name}`,
    type: 'mcp',
    name,
    sourcePath,
    editableFiles,
    readOnlyFiles,
    command,
    args,
    fileCount: editableFiles.length + readOnlyFiles.length,
    editableCount: editableFiles.length,
    totalLines: countLines(editableFiles),
    metrics: {
      avgFileSize: editableFiles.length > 0
        ? Math.round(editableFiles.reduce((s, f) => s + fileSize(f), 0) / editableFiles.length)
        : 0,
    },
    programTemplate: 'mcp-improvement',
  };
}

// ── Skill scanning ───────────────────────────────────────

function scanSkills() {
  const targets = [];
  if (!fs.existsSync(COMMANDS_DIR)) return targets;

  const files = fs.readdirSync(COMMANDS_DIR)
    .filter(f => f.endsWith('.md') || f.endsWith('.js'));

  for (const file of files) {
    const filePath = path.join(COMMANDS_DIR, file);
    const name = path.basename(file, path.extname(file));

    targets.push({
      id: `skill:${name}`,
      type: 'skill',
      name,
      sourcePath: COMMANDS_DIR,
      editableFiles: [filePath],
      fileCount: 1,
      editableCount: 1,
      totalLines: countLines([filePath]),
    });
  }

  return targets;
}

function analyzeSkill(name) {
  const candidates = [
    path.join(COMMANDS_DIR, `${name}.md`),
    path.join(COMMANDS_DIR, `${name}.js`),
  ];
  const filePath = candidates.find(f => fs.existsSync(f));
  if (!filePath) return null;

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  // Parse skill metadata from frontmatter
  let hasFrontmatter = false;
  let description = '';
  if (lines[0]?.startsWith('---')) {
    hasFrontmatter = true;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].startsWith('---')) break;
      const m = lines[i].match(/^description:\s*(.+)/);
      if (m) description = m[1].trim();
    }
  }

  return {
    id: `skill:${name}`,
    type: 'skill',
    name,
    description,
    sourcePath: COMMANDS_DIR,
    editableFiles: [filePath],
    readOnlyFiles: [],
    fileCount: 1,
    editableCount: 1,
    totalLines: lines.length,
    hasFrontmatter,
    metrics: {
      lineCount: lines.length,
      charCount: content.length,
      wordCount: content.split(/\s+/).length,
    },
    programTemplate: 'skill-improvement',
  };
}

// ── Helpers ──────────────────────────────────────────────

function readMcpConfig() {
  for (const configPath of MCP_CONFIGS) {
    if (!fs.existsSync(configPath)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      return data.mcpServers || data;
    } catch { /* ignore */ }
  }
  return null;
}

function walkFiles(dir, maxDepth = 3, depth = 0) {
  const results = [];
  if (depth > maxDepth || !fs.existsSync(dir)) return results;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...walkFiles(fullPath, maxDepth, depth + 1));
      } else if (entry.isFile()) {
        results.push(fullPath);
      }
    }
  } catch { /* permission errors */ }
  return results;
}

function countLines(files) {
  let total = 0;
  for (const f of files) {
    try {
      total += fs.readFileSync(f, 'utf-8').split('\n').length;
    } catch { /* ignore */ }
  }
  return total;
}

function fileSize(f) {
  try { return fs.statSync(f).size; } catch { return 0; }
}

module.exports = { scanAll, analyze };
