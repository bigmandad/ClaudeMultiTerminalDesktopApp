// ── Activity Panel — Research Log, Hooks, Blackboard, Stats ─────

import { events } from '../events.js';
import { showToast } from '../notifications/toast.js';

let activeTab = 'research';
let refreshInterval = null;

export function initActivityPanel() {
  console.log('[ActivityPanel] init');

  // Tab switching
  document.addEventListener('click', (e) => {
    const tab = e.target.closest('.act-tab');
    if (!tab) return;
    const tabName = tab.dataset.actTab;
    if (!tabName) return;
    activeTab = tabName;
    document.querySelectorAll('.act-tab').forEach(t => t.classList.toggle('active', t.dataset.actTab === tabName));
    renderActiveTab();
  });

  // Listen for panel becoming visible
  events.on('panel:shown', (panelName) => {
    if (panelName === 'activity') {
      renderActiveTab();
      startAutoRefresh();
    } else {
      stopAutoRefresh();
    }
  });

  // Listen for real-time experiment completions
  if (window.api?.research?.onExperimentComplete) {
    window.api.research.onExperimentComplete(() => {
      if (activeTab === 'research' && !document.getElementById('activity-panel')?.classList.contains('hidden')) {
        renderActiveTab();
      }
    });
  }

  // Listen for real-time hook events
  if (window.api?.hooks?.onEvent) {
    window.api.hooks.onEvent(() => {
      if (activeTab === 'hooks' && !document.getElementById('activity-panel')?.classList.contains('hidden')) {
        renderActiveTab();
      }
    });
  }

  // Listen for blackboard updates
  if (window.api?.blackboard?.onUpdated) {
    window.api.blackboard.onUpdated(() => {
      if (activeTab === 'blackboard' && !document.getElementById('activity-panel')?.classList.contains('hidden')) {
        renderActiveTab();
      }
    });
  }
}

function startAutoRefresh() {
  stopAutoRefresh();
  refreshInterval = setInterval(() => renderActiveTab(), 15000);
}

function stopAutoRefresh() {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}

async function renderActiveTab() {
  const content = document.getElementById('act-content');
  if (!content) return;

  if (activeTab === 'research') {
    await renderResearchTab(content);
  } else if (activeTab === 'hooks') {
    await renderHooksTab(content);
  } else if (activeTab === 'blackboard') {
    await renderBlackboardTab(content);
  } else if (activeTab === 'stats') {
    await renderStatsTab(content);
  }
}

// ── Research Tab — Recent experiments across all targets ──────

async function renderResearchTab(container) {
  let experiments = [];
  try {
    experiments = await window.api.research.recentExperiments(30);
  } catch (e) {
    // API might not exist yet
    container.innerHTML = `<div class="act-empty">Could not load experiments: ${e.message}</div>`;
    return;
  }

  if (!experiments || experiments.length === 0) {
    // Check if there's any active research
    let statusInfo = '';
    try {
      const allStatus = await window.api.research.allStatus();
      const activeEntries = Object.entries(allStatus).filter(([, s]) => s.status === 'running' || s.status === 'starting');
      if (activeEntries.length > 0) {
        statusInfo = `
          <div class="act-research-active">
            <div class="act-empty-icon">&#9654;</div>
            <div>${activeEntries.length} research session${activeEntries.length > 1 ? 's' : ''} running</div>
            <div class="act-empty-hint">Waiting for experiment results. Claude is reading files and planning its first change...</div>
          </div>`;
      }
    } catch { /* ignore */ }

    container.innerHTML = `
      <div class="act-empty">
        ${statusInfo || `
          <div class="act-empty-icon">&#128300;</div>
          <div>No experiments yet.</div>
          <div class="act-empty-hint">Start AutoResearch on a target to see experiment results here. Go to the AutoResearch panel (microscope icon) to begin.</div>
        `}
      </div>
    `;
    return;
  }

  // Group by target for a summary header
  const targetCounts = {};
  let totalKept = 0;
  let totalDiscarded = 0;
  for (const exp of experiments) {
    const tid = exp.target_id || 'unknown';
    targetCounts[tid] = (targetCounts[tid] || 0) + 1;
    if (exp.status === 'keep') totalKept++;
    else totalDiscarded++;
  }
  const targetSummary = Object.entries(targetCounts).map(([t, c]) => `${shortName(t)}: ${c}`).join(', ');

  let html = `
    <div class="act-research-summary">
      <span class="act-research-kept">${totalKept} kept</span>
      <span class="act-research-disc">${totalDiscarded} discarded</span>
      <span class="act-research-targets">${targetSummary}</span>
    </div>
    <div class="act-list">
  `;

  for (const exp of experiments) {
    const icon = exp.status === 'keep' ? '&#9989;' : exp.status === 'crash' ? '&#128165;' : '&#10060;';
    const statusClass = exp.status === 'keep' ? 'act-exp-keep' : exp.status === 'crash' ? 'act-exp-crash' : 'act-exp-discard';
    const metricVal = exp.metric_value != null ? parseFloat(exp.metric_value).toFixed(3) : '—';
    const time = exp.created_at ? formatTime(exp.created_at) : '';
    const desc = escapeHtml((exp.description || '').slice(0, 120));
    const target = shortName(exp.target_id || '');

    html += `
      <div class="act-event-card ${statusClass}">
        <div class="act-event-header">
          <span class="act-exp-icon">${icon}</span>
          <span class="act-exp-metric">${escapeHtml(exp.metric_name || '?')}: ${metricVal}</span>
          <span class="act-exp-target">${target}</span>
          <span class="act-time">${time}</span>
        </div>
        ${desc ? `<div class="act-exp-desc">${desc}</div>` : ''}
      </div>
    `;
  }
  html += '</div>';
  container.innerHTML = html;
}

// ── Hooks Tab ────────────────────────────────────────────────

async function renderHooksTab(container) {
  let hookEvents = [];
  try {
    hookEvents = await window.api.hooks.recent(30);
  } catch (e) {
    container.innerHTML = `<div class="act-empty">Could not load hook events: ${e.message}</div>`;
    return;
  }

  if (!hookEvents || hookEvents.length === 0) {
    container.innerHTML = `
      <div class="act-empty">
        <div class="act-empty-icon">&#128279;</div>
        <div>No hook events yet.</div>
        <div class="act-empty-hint">Claude Code hooks (PreToolUse, PostToolUse, etc.) will appear here when sessions use tools. Configure hooks in ~/.claude/settings.json.</div>
      </div>
    `;
    return;
  }

  let html = '<div class="act-list">';
  for (const evt of hookEvents) {
    const time = evt.created_at ? formatTime(evt.created_at) : '';
    const toolBadge = evt.tool_name ? `<span class="act-tool-badge">${escapeHtml(evt.tool_name)}</span>` : '';
    const resultClass = evt.result === 'error' || evt.result === 'rejected' ? 'act-result-error' :
                       evt.result === 'approved' || evt.result === 'success' ? 'act-result-ok' : '';
    const resultBadge = evt.result ? `<span class="act-result ${resultClass}">${escapeHtml(evt.result)}</span>` : '';
    const filePath = evt.file_path ? `<div class="act-file">${escapeHtml(evt.file_path)}</div>` : '';

    html += `
      <div class="act-event-card">
        <div class="act-event-header">
          <span class="act-event-type">${escapeHtml(evt.hook_type || '')}</span>
          <span class="act-event-name">${escapeHtml(evt.event_name || '')}</span>
          ${toolBadge}
          ${resultBadge}
          <span class="act-time">${time}</span>
        </div>
        ${filePath}
      </div>
    `;
  }
  html += '</div>';
  container.innerHTML = html;
}

// ── Blackboard Tab ───────────────────────────────────────────

async function renderBlackboardTab(container) {
  let entries = [];
  try {
    entries = await window.api.blackboard.list();
  } catch (e) {
    container.innerHTML = `<div class="act-empty">Could not load blackboard: ${e.message}</div>`;
    return;
  }

  if (!entries || entries.length === 0) {
    container.innerHTML = `
      <div class="act-empty">
        <div class="act-empty-icon">&#128221;</div>
        <div>Blackboard is empty.</div>
        <div class="act-empty-hint">Cross-session shared state entries will appear here. Sessions can post key-value data for other sessions to read.</div>
      </div>
    `;
    return;
  }

  let html = `
    <div class="act-bb-toolbar">
      <button class="act-btn act-bb-clear-btn" title="Clear all entries">Clear All</button>
    </div>
    <div class="act-list">
  `;

  for (const entry of entries) {
    const time = entry.updated_at ? formatTime(entry.updated_at) : '';
    const catBadge = entry.category ? `<span class="act-cat-badge">${escapeHtml(entry.category)}</span>` : '';
    const ttlInfo = entry.ttl_seconds ? `<span class="act-ttl">TTL: ${entry.ttl_seconds}s</span>` : '';
    const valueStr = typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value);

    html += `
      <div class="act-bb-card">
        <div class="act-bb-header">
          <span class="act-bb-key">${escapeHtml(entry.key)}</span>
          ${catBadge}
          ${ttlInfo}
          <span class="act-time">${time}</span>
        </div>
        <div class="act-bb-value">${escapeHtml(valueStr?.slice(0, 300) || '(empty)')}</div>
        ${entry.session_id ? `<div class="act-bb-session">Session: ${escapeHtml(entry.session_id)}</div>` : ''}
      </div>
    `;
  }
  html += '</div>';
  container.innerHTML = html;

  // Wire clear button
  const clearBtn = container.querySelector('.act-bb-clear-btn');
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      try {
        await window.api.blackboard.clear(null);
        showToast({ title: 'Blackboard cleared', icon: '&#128221;' });
        renderBlackboardTab(container);
      } catch (e) {
        showToast({ title: 'Clear failed', message: e.message, icon: '&#9888;' });
      }
    });
  }
}

// ── Stats Tab ─────────────────────────────────────────────────

async function renderStatsTab(container) {
  let stats = {};
  try {
    stats = await window.api.hooks.stats();
  } catch (e) {
    container.innerHTML = `<div class="act-empty">Could not load hook stats: ${e.message}</div>`;
    return;
  }

  if (!stats || (Array.isArray(stats) && stats.length === 0) || Object.keys(stats).length === 0) {
    container.innerHTML = `
      <div class="act-empty">
        <div class="act-empty-icon">&#128202;</div>
        <div>No tool usage stats yet.</div>
        <div class="act-empty-hint">Tool usage statistics from Claude Code hooks will appear here as sessions use various tools.</div>
      </div>
    `;
    return;
  }

  const items = Array.isArray(stats) ? stats : Object.entries(stats).map(([tool_name, count]) => ({ tool_name, count }));
  items.sort((a, b) => (b.count || 0) - (a.count || 0));
  const maxCount = items[0]?.count || 1;

  let html = '<div class="act-stats-header">Tool Usage</div><div class="act-stats-list">';
  for (const item of items) {
    const pct = Math.round((item.count / maxCount) * 100);
    html += `
      <div class="act-stat-row">
        <span class="act-stat-name">${escapeHtml(item.tool_name || 'unknown')}</span>
        <div class="act-stat-bar-track">
          <div class="act-stat-bar-fill" style="width:${pct}%"></div>
        </div>
        <span class="act-stat-count">${item.count}</span>
      </div>
    `;
  }
  html += '</div>';
  container.innerHTML = html;
}

// ── Helpers ──────────────────────────────────────────────────

function shortName(targetId) {
  return (targetId || '').replace(/^(plugin|mcp|skill)[_:]/, '');
}

function formatTime(isoStr) {
  try {
    const d = new Date(isoStr);
    const now = new Date();
    const diff = now - d;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return d.toLocaleDateString();
  } catch {
    return isoStr;
  }
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
