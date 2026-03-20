// ── Unified System Status — Monitors MCP, OpenViking, Ollama ──
// Shows live status dots in the icon rail and provides a tooltip popover

const STATUS_POLL_MS = 15000;

const systems = {
  mcp: { el: null, status: 'unknown', label: 'MCP', tools: 0 },
  ov: { el: null, status: 'unknown', label: 'OpenViking', resources: 0, memories: 0 },
  ollama: { el: null, status: 'unknown', label: 'Ollama', model: '' },
  research: { el: null, status: 'off', label: 'AutoResearch', activeCount: 0, experimentCount: 0 },
  discord: { el: null, status: 'off', label: 'Discord', tag: '', guilds: 0, bindings: 0 },
  db: { el: null, status: 'unknown', label: 'Database', sessions: 0, targets: 0 },
};

export function initSystemStatus() {
  systems.mcp.el = document.getElementById('mcp-global-dot');
  systems.ov.el = document.getElementById('openviking-status-dot');
  systems.ollama.el = document.getElementById('ollama-status-dot');
  systems.research.el = document.getElementById('research-status-dot');
  systems.discord.el = document.getElementById('discord-status-dot');
  systems.db.el = document.getElementById('db-status-dot');

  // Listen for OpenViking server ready from main process
  if (window.api?.openviking?.onServerReady) {
    window.api.openviking.onServerReady((payload) => {
      if (payload?.running && payload?.healthy) {
        systems.ov.status = 'ok';
        updateDot('ov');
        pollOV(); // Refresh full stats
      }
    });
  }

  // Listen for MCP status broadcasts
  if (window.api?.mcp?.onServerStatus) {
    window.api.mcp.onServerStatus((payload) => {
      if (payload?.status === 'connected') {
        systems.mcp.status = 'ok';
        systems.mcp.tools = payload.tools?.length || 0;
      } else if (payload?.status === 'error' || payload?.status === 'stopped') {
        systems.mcp.status = 'error';
      } else if (payload?.status === 'starting') {
        systems.mcp.status = 'starting';
      }
      updateDot('mcp');
    });
  }

  // Listen for research status changes
  if (window.api?.research?.onStatusChanged) {
    window.api.research.onStatusChanged((status) => {
      if (status.status === 'running' || status.status === 'starting') {
        systems.research.status = 'ok';
        systems.research.activeCount++;
        systems.research.experimentCount = status.experimentCount || 0;
      } else if (status.status === 'stopped' || status.status === 'idle' ||
                 status.status === 'auto-stopped' || status.status === 'completed' ||
                 status.status === 'error') {
        systems.research.activeCount = Math.max(0, systems.research.activeCount - 1);
        systems.research.status = systems.research.activeCount > 0 ? 'ok' : 'off';
      }
      updateDot('research');
    });
  }

  if (window.api?.research?.onExperimentComplete) {
    window.api.research.onExperimentComplete((result) => {
      systems.research.experimentCount = result.researchState?.experimentCount || systems.research.experimentCount + 1;
      updateDot('research');
    });
  }

  // Listen for Discord bot status changes
  if (window.api?.discord?.onStatusChanged) {
    window.api.discord.onStatusChanged((payload) => {
      systems.discord.status = payload.connected ? 'ok' : 'off';
      if (payload.connected) {
        systems.discord.tag = payload.tag || '';
        systems.discord.guilds = payload.guilds || 0;
        systems.discord.bindings = payload.bindings || 0;
      }
      updateDot('discord');
    });
  }

  // Click handlers for system dots — show tooltip
  const strip = document.getElementById('system-status-strip');
  if (strip) {
    strip.addEventListener('click', (e) => {
      const dot = e.target.closest('.sys-dot');
      if (!dot) return;
      showSystemPopover(dot);
    });
  }

  // Initial poll + periodic
  pollAll();
  setInterval(pollAll, STATUS_POLL_MS);
}

async function pollAll() {
  await Promise.allSettled([pollOV(), pollOllama(), pollMcp(), pollDiscord(), pollDb()]);
}

async function pollOV() {
  try {
    const status = await window.api.openviking.status();
    if (status.running && status.healthy) {
      systems.ov.status = 'ok';
      systems.ov.resources = status.resources || 0;
      systems.ov.memories = status.memories || 0;
    } else if (status.running) {
      systems.ov.status = 'starting';
    } else {
      systems.ov.status = 'off';
    }
  } catch {
    systems.ov.status = 'off';
  }
  updateDot('ov');
}

async function pollOllama() {
  try {
    // Use a fetch to localhost:11434 (Ollama API)
    const resp = await fetch('http://localhost:11434/api/version', { signal: AbortSignal.timeout(3000) });
    if (resp.ok) {
      const data = await resp.json();
      systems.ollama.status = 'ok';
      systems.ollama.model = data.version || '';
    } else {
      systems.ollama.status = 'error';
    }
  } catch {
    systems.ollama.status = 'off';
  }
  updateDot('ollama');
}

async function pollMcp() {
  // Poll MCP status on every interval (event listener also updates, but polling catches missed events)
  try {
    const status = await window.api.mcp.status();
    if (status && typeof status === 'object') {
      const serverNames = Object.keys(status);
      const anyConnected = serverNames.some(n => status[n]?.status === 'connected');
      if (anyConnected) {
        systems.mcp.status = 'ok';
        // Count tools across all connected servers
        try {
          const allTools = await window.api.mcp.allTools();
          systems.mcp.tools = Array.isArray(allTools) ? allTools.length : 0;
        } catch {
          // allTools may fail, keep previous count
        }
      } else if (serverNames.length > 0) {
        systems.mcp.status = 'starting';
      } else {
        systems.mcp.status = 'off';
      }
    } else {
      systems.mcp.status = 'off';
    }
  } catch {
    systems.mcp.status = 'off';
  }
  updateDot('mcp');
}

async function pollDiscord() {
  try {
    const status = await window.api.discord.status();
    if (status.connected) {
      systems.discord.status = 'ok';
      systems.discord.tag = status.tag || '';
      systems.discord.guilds = status.guilds || 0;
      systems.discord.bindings = status.bindings || 0;
    } else {
      systems.discord.status = 'off';
    }
  } catch {
    systems.discord.status = 'off';
  }
  updateDot('discord');
}

async function pollDb() {
  try {
    const health = await window.api.app.dbHealth();
    if (health.ok) {
      systems.db.status = 'ok';
      systems.db.sessions = health.sessions || 0;
      systems.db.targets = health.targets || 0;
    } else {
      systems.db.status = 'error';
    }
  } catch {
    systems.db.status = 'error';
  }
  updateDot('db');
}

function updateDot(key) {
  const sys = systems[key];
  if (!sys.el) return;

  const colors = { ok: '#6ec76e', starting: '#d4845a', error: '#cc4444', off: '#555', unknown: '#444' };
  sys.el.style.background = colors[sys.status] || colors.unknown;

  let title = `${sys.label}: `;
  switch (sys.status) {
    case 'ok':
      title += 'Running';
      if (key === 'mcp') title += ` (${sys.tools} tools)`;
      if (key === 'ov') title += ` (${sys.resources} resources)`;
      if (key === 'ollama') title += ` v${sys.model}`;
      if (key === 'research') title += ` (${sys.activeCount} active, ${sys.experimentCount} exp)`;
      if (key === 'discord') title += ` as ${sys.tag} (${sys.guilds} guilds, ${sys.bindings} bindings)`;
      if (key === 'db') title += ` (${sys.sessions} sessions, ${sys.targets} targets)`;
      break;
    case 'starting': title += 'Starting...'; break;
    case 'error': title += 'Error'; break;
    case 'off': title += 'Stopped'; break;
    default: title += 'Unknown';
  }
  sys.el.title = title;

  // Also update the CSS tooltip element if present
  const tooltipEl = sys.el.querySelector('.sys-dot-tooltip');
  if (tooltipEl) {
    tooltipEl.textContent = title;
  }
}

function showSystemPopover(dotEl) {
  // Remove existing popover
  document.querySelectorAll('.sys-popover').forEach(p => p.remove());

  const key = dotEl.dataset.system;
  const sys = systems[key];
  if (!sys) return;

  const popover = document.createElement('div');
  popover.className = 'sys-popover';

  let content = `<div class="sys-popover-title">${sys.label}</div>`;
  content += `<div class="sys-popover-status ${sys.status}">${sys.status === 'ok' ? '● Running' : sys.status === 'starting' ? '◐ Starting' : sys.status === 'error' ? '✖ Error' : '○ Stopped'}</div>`;

  if (key === 'mcp' && sys.status === 'ok') {
    content += `<div class="sys-popover-detail">${sys.tools} tools available</div>`;
  }
  if (key === 'ov' && sys.status === 'ok') {
    content += `<div class="sys-popover-detail">${sys.resources} resources indexed</div>`;
    content += `<div class="sys-popover-detail">${sys.memories} agent memories</div>`;
  }
  if (key === 'ollama' && sys.status === 'ok') {
    content += `<div class="sys-popover-detail">Version ${sys.model}</div>`;
  }
  if (key === 'research') {
    if (sys.status === 'ok') {
      content += `<div class="sys-popover-detail">${sys.activeCount} active sessions</div>`;
      content += `<div class="sys-popover-detail">${sys.experimentCount} experiments completed</div>`;
    } else {
      content += `<div class="sys-popover-detail">No active research</div>`;
    }
  }
  if (key === 'discord') {
    if (sys.status === 'ok') {
      content += `<div class="sys-popover-detail">Bot: ${sys.tag}</div>`;
      content += `<div class="sys-popover-detail">${sys.guilds} guild${sys.guilds !== 1 ? 's' : ''}</div>`;
      content += `<div class="sys-popover-detail">${sys.bindings} channel binding${sys.bindings !== 1 ? 's' : ''}</div>`;
    } else {
      content += `<div class="sys-popover-detail">Not connected</div>`;
    }
  }
  if (key === 'db') {
    if (sys.status === 'ok') {
      content += `<div class="sys-popover-detail">${sys.sessions} sessions stored</div>`;
      content += `<div class="sys-popover-detail">${sys.targets} research targets</div>`;
      content += `<div class="sys-popover-detail">SQLite WAL mode</div>`;
    } else {
      content += `<div class="sys-popover-detail">Database error — check logs</div>`;
    }
  }
  if (sys.status === 'off' && key === 'ov') {
    content += `<button class="btn btn-primary sys-start-btn" data-action="start-ov" style="margin-top:4px;padding:2px 8px;font-size:10px">Start</button>`;
  }

  popover.innerHTML = content;

  // Position relative to dot
  const rect = dotEl.getBoundingClientRect();
  popover.style.left = (rect.right + 8) + 'px';
  popover.style.top = (rect.top - 10) + 'px';

  document.body.appendChild(popover);

  // Start button handler
  const startBtn = popover.querySelector('.sys-start-btn');
  if (startBtn) {
    startBtn.addEventListener('click', async () => {
      startBtn.textContent = 'Starting...';
      startBtn.disabled = true;
      try {
        await window.api.openviking.start();
        await pollOV();
      } catch { /* ignore */ }
      popover.remove();
    });
  }

  // Close on outside click
  setTimeout(() => {
    const closeHandler = (e) => {
      if (!popover.contains(e.target) && !dotEl.contains(e.target)) {
        popover.remove();
        document.removeEventListener('click', closeHandler);
      }
    };
    document.addEventListener('click', closeHandler);
  }, 100);
}

export function getSystemStatus() {
  return { ...systems };
}
