// ── AutoResearch Panel — UI for autonomous self-improvement ──

import { state } from '../state.js';
import { events } from '../events.js';
import { showToast } from '../notifications/toast.js';
import { renderTabs } from '../session/session-tab.js';
import { renderTargetSelector } from './target-selector.js';
import { renderMetricChart } from './metric-chart.js';

let currentTab = 'targets'; // 'targets' | 'live' | 'timeline' | 'insights'
let targets = [];
let activeResearch = {};
let selectedTargetId = null;
let refreshInterval = null;
// Cache for expanded insight cards (uri -> content)
let expandedInsights = new Set();
let insightContentCache = {};

export function initAutoResearchPanel() {
  // Refresh targets when panel becomes visible (icon-rail.js handles panel switching)
  const arPanel = document.getElementById('autoresearch-panel');
  if (arPanel) {
    const observer = new MutationObserver(() => {
      if (!arPanel.classList.contains('hidden')) refreshTargets();
    });
    observer.observe(arPanel, { attributes: true, attributeFilter: ['class'] });
  }

  // Tab switching + delegated click handling
  const panel = document.getElementById('autoresearch-panel');
  if (!panel) return;

  panel.addEventListener('click', (e) => {
    const tab = e.target.closest('.ar-tab');
    if (tab) {
      currentTab = tab.dataset.arTab;
      panel.querySelectorAll('.ar-tab').forEach(t => t.classList.toggle('active', t === tab));
      renderContent();
      manageRefreshInterval();
      return;
    }

    const btn = e.target.closest('button');
    if (!btn) {
      // Check for insight card expand toggle
      const card = e.target.closest('.ar-insight-card');
      if (card && card.dataset.uri) {
        toggleInsightCard(card.dataset.uri);
      }
      // Check for timeline row expand toggle
      const row = e.target.closest('.ar-timeline-row');
      if (row && row.dataset.expId) {
        row.classList.toggle('expanded');
      }
      return;
    }

    if (btn.classList.contains('ar-scan-btn')) {
      refreshTargets();
    }
    if (btn.classList.contains('ar-start-btn')) {
      const targetId = btn.dataset.targetId;
      const mode = btn.dataset.mode || 'pty'; // 'pty' (default) or 'headless'
      if (targetId) startResearch(targetId, mode);
    }
    if (btn.classList.contains('ar-stop-btn')) {
      const targetId = btn.dataset.targetId;
      if (targetId) stopResearch(targetId);
    }
    if (btn.classList.contains('ar-select-btn')) {
      selectedTargetId = btn.dataset.targetId;
      renderContent();
    }
  });

  // Target picker change handler (delegated)
  panel.addEventListener('change', (e) => {
    if (e.target.classList.contains('ar-target-picker')) {
      selectedTargetId = e.target.value;
      renderContent();
    }
  });

  // Listen for real-time updates from main process
  if (window.api?.research?.onStatusChanged) {
    window.api.research.onStatusChanged((status) => {
      activeResearch[status.targetId] = status;
      if (currentTab === 'live') renderContent();
    });
  }

  if (window.api?.research?.onExperimentComplete) {
    window.api.research.onExperimentComplete((result) => {
      // Update local state
      if (activeResearch[result.targetId]) {
        activeResearch[result.targetId].experimentCount = result.researchState?.experimentCount || 0;
        activeResearch[result.targetId].bestMetricValue = result.researchState?.bestMetricValue;
        activeResearch[result.targetId].lastMetricValue = result.researchState?.lastMetricValue;
      }

      // Handle auto-stop events (no experiment object)
      if (result.autoStopped) {
        showToast({
          title: 'Research auto-stopped',
          message: result.stopReason || 'Diminishing returns',
          icon: '&#9632;'
        });
        if (activeResearch[result.targetId]) {
          delete activeResearch[result.targetId];
        }
      } else if (result.experiment) {
        showToast({
          title: `Experiment: ${result.experiment.status}`,
          message: result.experiment.description?.slice(0, 60) || '',
          icon: result.experiment.status === 'keep' ? '&#9989;' : '&#10060;'
        });
      }
      if (currentTab === 'live' || currentTab === 'timeline') renderContent();
    });
  }
}

// Auto-refresh Timeline and Live tabs every 10s while research is active
function manageRefreshInterval() {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
  const hasActive = Object.values(activeResearch).some(r => r.status === 'running' || r.status === 'starting');
  if (hasActive && (currentTab === 'live' || currentTab === 'timeline')) {
    refreshInterval = setInterval(() => renderContent(), 10000);
  }
}

async function refreshTargets() {
  try {
    targets = await window.api.research.listTargets();
    activeResearch = await window.api.research.allStatus();

    // Auto-select the first active target if none selected
    if (!selectedTargetId) {
      const activeTarget = Object.keys(activeResearch)[0];
      if (activeTarget) {
        selectedTargetId = activeTarget;
      } else if (targets.length > 0) {
        selectedTargetId = targets[0].id;
      }
    }

    renderContent();
    manageRefreshInterval();
  } catch (err) {
    showToast({ title: 'Scan failed', message: err.message, icon: '&#9888;' });
  }
}

async function startResearch(targetId, mode = 'pty') {
  const modeLabel = mode === 'headless' ? 'headless' : 'interactive';
  showToast({ title: `Starting ${modeLabel} research...`, message: targetId, icon: '&#128300;' });
  try {
    const result = await window.api.research.start({ targetId, mode });
    if (result.success) {
      showToast({ title: 'Research started', message: `${result.sessionId || targetId} (${modeLabel})`, icon: '&#9989;' });
      activeResearch[targetId] = {
        status: 'starting', targetId,
        sessionId: result.sessionId,
        experimentCount: 0,
        mode: mode,
      };

      // Auto-select this target for timeline viewing
      selectedTargetId = targetId;

      // Register as a visible session in the tab bar (PTY mode only — headless has no terminal)
      if (mode !== 'headless' && result.sessionId) {
        state.addSession({
          id: result.sessionId,
          name: `Research: ${targetId}`,
          workspacePath: result.workspacePath || '',
          mode: 'research',
          skipPerms: true,
          status: 'active',
          lastMessage: 'AutoResearch active'
        });
        renderTabs();
      }

      // Switch to Live tab so user can see research is happening
      currentTab = 'live';
      const panel = document.getElementById('autoresearch-panel');
      if (panel) {
        panel.querySelectorAll('.ar-tab').forEach(t =>
          t.classList.toggle('active', t.dataset.arTab === 'live')
        );
      }

      renderContent();
      manageRefreshInterval();
    } else {
      showToast({ title: 'Start failed', message: result.error, icon: '&#9888;' });
    }
  } catch (err) {
    showToast({ title: 'Start failed', message: err.message, icon: '&#9888;' });
  }
}

async function stopResearch(targetId) {
  try {
    const research = activeResearch[targetId];
    await window.api.research.stop(targetId);

    // Remove the session from the tab bar
    if (research?.sessionId) {
      state.removeSession(research.sessionId);
      renderTabs();
    }

    delete activeResearch[targetId];
    renderContent();
    manageRefreshInterval();
    showToast({ title: 'Research stopped', icon: '&#9632;' });
  } catch (err) {
    showToast({ title: 'Stop failed', message: err.message, icon: '&#9888;' });
  }
}

function renderContent() {
  const container = document.getElementById('ar-content');
  if (!container) return;

  switch (currentTab) {
    case 'targets':
      container.innerHTML = renderTargetsTab();
      break;
    case 'live':
      container.innerHTML = renderLiveTab();
      break;
    case 'timeline':
      renderTimelineTab(container);
      break;
    case 'insights':
      renderInsightsTab(container);
      break;
  }
}

// ── Shared: target picker dropdown for Timeline/Insights ──

function renderTargetPicker() {
  const allTargetIds = new Set([
    ...targets.map(t => t.id),
    ...Object.keys(activeResearch)
  ]);
  if (allTargetIds.size === 0) return '';

  const options = [...allTargetIds].map(id => {
    const isActive = activeResearch[id]?.status === 'running' || activeResearch[id]?.status === 'starting';
    const label = isActive ? `${id} (active)` : id;
    const selected = id === selectedTargetId ? 'selected' : '';
    return `<option value="${id}" ${selected}>${label}</option>`;
  }).join('');

  return `<select class="ar-target-picker">${options}</select>`;
}

// ── Targets Tab ──

function renderTargetsTab() {
  if (targets.length === 0) {
    return `
      <div class="ar-empty">
        <p>No targets found.</p>
        <button class="btn btn-primary ar-scan-btn" style="margin-top:6px;padding:3px 10px;font-size:11px">Scan Targets</button>
        <p class="ar-hint">Scans ~/.claude/ for plugins, MCPs, and skills</p>
      </div>`;
  }

  return `
    <button class="btn ar-scan-btn" style="margin-bottom:6px;padding:2px 8px;font-size:10px;width:100%">Re-scan Targets</button>
    ${renderTargetSelector(targets, activeResearch, selectedTargetId)}
  `;
}

// ── Live Tab ──

function renderLiveTab() {
  const entries = Object.entries(activeResearch);
  if (entries.length === 0) {
    return '<div class="ar-empty"><p>No active research sessions.</p><p class="ar-hint">Select a target and click Start to begin.</p></div>';
  }

  return entries.map(([targetId, research]) => {
    const statusIcon = research.status === 'running' ? '&#9654;' :
      research.status === 'paused' ? '&#9646;&#9646;' :
        research.status === 'starting' ? '&#9203;' : '&#9632;';
    const statusColor = research.status === 'running' ? '#6ec76e' :
      research.status === 'paused' ? '#d4845a' : '#888';

    const elapsed = research.startedAt
      ? formatElapsed(new Date(research.startedAt))
      : '';

    return `
      <div class="ar-live-card">
        <div class="ar-live-header">
          <span style="color:${statusColor}">${statusIcon}</span>
          <span class="ar-live-name">${targetId}</span>
          <button class="btn ar-stop-btn" data-target-id="${targetId}" style="padding:1px 6px;font-size:9px">Stop</button>
        </div>
        <div class="ar-live-stats">
          <span>Experiments: ${research.experimentCount || 0}</span>
          <span>Best: ${research.bestMetricValue != null ? research.bestMetricValue.toFixed(3) : '—'}</span>
          <span>Last: ${research.lastMetricValue != null ? research.lastMetricValue.toFixed(3) : '—'}</span>
          ${elapsed ? `<span>${elapsed}</span>` : ''}
        </div>
        <div class="ar-live-hint">
          ${research.status === 'starting' ? 'Waiting for Claude CLI to initialize...' :
            research.experimentCount === 0 ? 'Running — waiting for first experiment result...' :
            'Active — experiments updating in real-time'}
        </div>
      </div>`;
  }).join('');
}

// ── Timeline Tab ──

async function renderTimelineTab(container) {
  // Auto-select first active target if none selected
  if (!selectedTargetId) {
    const activeId = Object.keys(activeResearch)[0];
    if (activeId) {
      selectedTargetId = activeId;
    } else if (targets.length > 0) {
      selectedTargetId = targets[0].id;
    } else {
      container.innerHTML = '<div class="ar-empty"><p>No targets available. Scan for targets first.</p></div>';
      return;
    }
  }

  const isActive = activeResearch[selectedTargetId]?.status === 'running' || activeResearch[selectedTargetId]?.status === 'starting';
  const statusLabel = isActive ? ' <span class="ar-status-active">ACTIVE</span>' : '';

  container.innerHTML = `${renderTargetPicker()}<div class="ar-loading">Loading timeline...</div>`;

  try {
    // Try DB first (structured experiment records)
    let timeline = [];
    try {
      timeline = await window.api.research.timeline(selectedTargetId) || [];
    } catch { /* DB might not have data */ }

    // If DB empty, try TSV fallback for full row data
    if (timeline.length === 0 && window.api.research.tsvTimeline) {
      try {
        timeline = await window.api.research.tsvTimeline(selectedTargetId) || [];
      } catch { /* ignore */ }
    }

    if (timeline.length === 0) {
      let html = renderTargetPicker();
      if (isActive) {
        html += `
          <div class="ar-timeline-header">${shortName(selectedTargetId)}${statusLabel}</div>
          <div class="ar-empty">
            <p>Waiting for experiment results...</p>
            <p class="ar-hint">Claude is analyzing the target. Results appear here as each experiment cycle completes.</p>
            <p class="ar-hint">Switch to the session tab to watch Claude work in real-time.</p>
          </div>`;
      } else {
        html += `
          <div class="ar-timeline-header">${shortName(selectedTargetId)}</div>
          <div class="ar-empty">
            <p>No experiments recorded yet.</p>
            <p class="ar-hint">Start research on this target from the Targets tab to begin.</p>
          </div>`;
      }
      container.innerHTML = html;
      return;
    }

    // Got timeline data — render chart + list
    let html = renderTargetPicker();
    html += `<div class="ar-timeline-header">${shortName(selectedTargetId)}${statusLabel} — ${timeline.length} experiments</div>`;
    html += renderMetricChart(timeline);

    // Summary stats
    const keepCount = timeline.filter(e => e.status === 'keep').length;
    const discardCount = timeline.filter(e => e.status === 'discard').length;
    const crashCount = timeline.filter(e => e.status === 'crash').length;
    html += `
      <div class="ar-stats-row">
        <span class="ar-stat-inline ar-stat-keep">${keepCount} kept</span>
        <span class="ar-stat-inline ar-stat-discard">${discardCount} discarded</span>
        ${crashCount > 0 ? `<span class="ar-stat-inline ar-stat-crash">${crashCount} crashed</span>` : ''}
      </div>`;

    html += '<div class="ar-timeline-list">';
    // Show most recent first
    for (const exp of [...timeline].reverse().slice(0, 50)) {
      const icon = exp.status === 'keep' ? '&#9989;' : exp.status === 'crash' ? '&#128165;' : '&#10060;';
      const valueStr = exp.metric_value != null ? exp.metric_value.toFixed(3) : '—';
      const timeStr = exp.created_at ? formatTimeAgo(new Date(exp.created_at)) : '';
      const desc = (exp.description || '').replace(/</g, '&lt;');
      html += `
        <div class="ar-timeline-row ${exp.status}" data-exp-id="${exp.id || ''}" title="Click to expand">
          <span class="ar-tl-icon">${icon}</span>
          <span class="ar-tl-metric">${exp.metric_name || '?'}: ${valueStr}</span>
          <span class="ar-tl-desc">${desc}</span>
          ${timeStr ? `<span class="ar-tl-time">${timeStr}</span>` : ''}
          <div class="ar-tl-expanded-desc">${desc}</div>
        </div>`;
    }
    html += '</div>';
    container.innerHTML = html;
  } catch (err) {
    container.innerHTML = `${renderTargetPicker()}<div class="ar-empty"><p>Error: ${err.message}</p></div>`;
  }
}

// ── Insights Tab ──

async function renderInsightsTab(container) {
  // Auto-select target if needed
  if (!selectedTargetId) {
    const activeId = Object.keys(activeResearch)[0];
    if (activeId) selectedTargetId = activeId;
    else if (targets.length > 0) selectedTargetId = targets[0].id;
  }

  container.innerHTML = `${renderTargetPicker()}<div class="ar-loading">Querying OpenViking...</div>`;

  try {
    // Use a more targeted search query
    const targetName = selectedTargetId ? selectedTargetId.replace(/[_:-]/g, ' ') : '';
    const query = targetName
      ? `${targetName} plugin improvement patterns experiments`
      : 'plugin improvement patterns experiments best practices';
    const results = await window.api.openviking.search(query, { topK: 15, tier: 'L1' });

    if (results?.error) {
      container.innerHTML = `${renderTargetPicker()}<div class="ar-empty"><p>OpenViking not available.</p><p class="ar-hint">${results.error}</p></div>`;
      return;
    }

    // Collect all result types
    const resources = results?.resources || results?.result?.resources || [];
    const memories = results?.memories || results?.result?.memories || [];
    const skills = results?.skills || results?.result?.skills || [];

    const totalResults = resources.length + memories.length + skills.length;

    if (totalResults === 0) {
      container.innerHTML = `
        ${renderTargetPicker()}
        <div class="ar-empty">
          <p>No insights found yet.</p>
          <p class="ar-hint">Experiment results are auto-ingested into OpenViking as they complete. Run experiments to build the knowledge base.</p>
          ${selectedTargetId ? `<p class="ar-hint">Searching for: ${targetName}</p>` : ''}
        </div>`;
      return;
    }

    let html = renderTargetPicker();
    html += `<div class="ar-insights-header">Knowledge Base${selectedTargetId ? ` — ${shortName(selectedTargetId)}` : ''} <span class="ar-results-count">${totalResults} results</span></div>`;

    // Render resources (filter out generic "Directory overview" entries)
    const meaningfulResources = resources.filter(r => {
      const abs = (r.abstract || '').toLowerCase();
      return abs && abs !== 'directory overview' && abs.length > 5;
    });

    if (meaningfulResources.length > 0) {
      html += '<div class="ar-section-label">Resources</div>';
      for (const r of meaningfulResources) {
        html += renderInsightCard(r, 'resource');
      }
    }

    // Resources that were directory overviews (show collapsed at bottom)
    const directoryEntries = resources.filter(r => {
      const abs = (r.abstract || '').toLowerCase();
      return !abs || abs === 'directory overview' || abs.length <= 5;
    });

    // Render memories
    if (memories.length > 0) {
      html += '<div class="ar-section-label">Memories</div>';
      for (const m of memories) {
        html += renderInsightCard(m, 'memory');
      }
    }

    // Render skills
    if (skills.length > 0) {
      html += '<div class="ar-section-label">Skills</div>';
      for (const s of skills) {
        html += renderInsightCard(s, 'skill');
      }
    }

    // Show directory entries at the bottom if there are any
    if (directoryEntries.length > 0 && meaningfulResources.length === 0) {
      html += '<div class="ar-section-label">Indexed Directories</div>';
      for (const r of directoryEntries.slice(0, 5)) {
        html += renderInsightCard(r, 'directory');
      }
    }

    container.innerHTML = html;
  } catch (err) {
    container.innerHTML = `${renderTargetPicker()}<div class="ar-empty"><p>Error querying insights: ${err.message}</p></div>`;
  }
}

function renderInsightCard(item, type) {
  const uri = item.uri || '';
  const displayName = formatUri(uri);
  const snippet = (item.abstract || item.content || item.overview || '').replace(/</g, '&lt;');
  const score = item.score || 0;
  const isExpanded = expandedInsights.has(uri);
  const cachedContent = insightContentCache[uri];

  const typeIcon = type === 'memory' ? '&#128161;' :
    type === 'skill' ? '&#9889;' :
    type === 'directory' ? '&#128193;' : '&#128196;';

  const expandClass = isExpanded ? 'expanded' : '';
  const expandedHtml = isExpanded && cachedContent
    ? `<div class="ar-insight-expanded">${cachedContent.replace(/</g, '&lt;').replace(/\n/g, '<br>')}</div>`
    : isExpanded
    ? '<div class="ar-insight-expanded ar-loading">Loading content...</div>'
    : '';

  return `
    <div class="ar-insight-card ${expandClass}" data-uri="${uri}">
      <div class="ar-insight-header">
        <span class="ar-insight-type">${typeIcon}</span>
        <span class="ar-insight-title" title="${uri}">${displayName}</span>
        <span class="ar-insight-score">${score.toFixed(2)}</span>
      </div>
      ${snippet ? `<div class="ar-insight-snippet">${snippet}</div>` : ''}
      ${expandedHtml}
      <div class="ar-insight-expand-hint">${isExpanded ? 'Click to collapse' : 'Click to expand'}</div>
    </div>`;
}

async function toggleInsightCard(uri) {
  if (expandedInsights.has(uri)) {
    expandedInsights.delete(uri);
  } else {
    expandedInsights.add(uri);
    // Fetch content if not cached
    if (!insightContentCache[uri] && window.api?.openviking?.read) {
      try {
        // Strip .overview.md/.abstract.md suffix to get the directory/resource URI
        const cleanUri = uri.replace(/\/\.(overview|abstract)\.md$/, '');

        // Try L1 overview first, fall back to L2 full content
        let text = '';
        try {
          const l1 = await window.api.openviking.read(cleanUri, 'L1');
          if (l1 && typeof l1 === 'object') {
            text = l1.content || l1.overview || l1.abstract || '';
          } else {
            text = String(l1 || '');
          }
        } catch { /* L1 failed */ }

        // If L1 was empty/generic, try L2
        if (!text || text.includes('Directory overview') || text.length < 20) {
          try {
            const l2 = await window.api.openviking.read(cleanUri, 'L2');
            if (l2 && typeof l2 === 'object') {
              text = l2.content || l2.overview || JSON.stringify(l2).slice(0, 500);
            } else {
              text = String(l2 || '');
            }
          } catch { /* L2 failed too */ }
        }

        // If still empty, try listing children and reading first child
        if (!text || text.length < 20) {
          try {
            const children = await window.api.openviking.ls(cleanUri + '/');
            if (Array.isArray(children) && children.length > 0) {
              const childNames = children.filter(c => !c.startsWith('.')).slice(0, 5);
              text = `Contains ${children.length} items:\n${childNames.map(c => `  - ${c}`).join('\n')}`;
              // Try reading first real child for a preview
              const firstChild = childNames.find(c => c.endsWith('.md') && !c.startsWith('.'));
              if (firstChild) {
                try {
                  const childContent = await window.api.openviking.read(cleanUri + '/' + firstChild, 'L2');
                  const preview = String(typeof childContent === 'object' ? childContent.content || childContent : childContent || '');
                  if (preview.length > 20) {
                    text += '\n\n--- Preview of ' + firstChild + ' ---\n' + preview.slice(0, 400);
                  }
                } catch { /* ignore */ }
              }
            }
          } catch { /* ignore */ }
        }

        insightContentCache[uri] = text || 'No detailed content available for this resource.';
      } catch (err) {
        insightContentCache[uri] = `Error loading: ${err.message}`;
      }
    }
  }
  // Re-render just the insights tab
  const container = document.getElementById('ar-content');
  if (container && currentTab === 'insights') {
    renderInsightsTab(container);
  }
}

// ── Helpers ──

function shortName(targetId) {
  // "plugin_hytale-modding" → "hytale-modding"
  // "mcp_hytale-dev" → "hytale-dev"
  return (targetId || '').replace(/^(plugin|mcp|skill)[_:]/, '');
}

function formatUri(uri) {
  if (!uri) return 'Unknown';
  // "viking://resources/HYTALE_CODEX/Hytale_Server_Modding_API_Codex/.overview.md"
  // → "HYTALE_CODEX / Hytale_Server_Modding_API_Codex"
  let clean = uri
    .replace(/^viking:\/\//, '')
    .replace(/\/(\.overview|\.abstract)\.md$/, '')
    .replace(/^resources\//, '');

  // Convert path separators to readable format
  const parts = clean.split('/').filter(Boolean);
  if (parts.length > 2) {
    return parts.slice(0, 2).join(' / ');
  }
  return parts.join(' / ') || clean;
}

function formatElapsed(start) {
  const ms = Date.now() - start.getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatTimeAgo(date) {
  const ms = Date.now() - date.getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
