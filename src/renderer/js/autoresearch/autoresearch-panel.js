// ── AutoResearch Panel — UI for autonomous self-improvement ──

import { events } from '../events.js';
import { showToast } from '../notifications/toast.js';
import { renderTargetSelector } from './target-selector.js';
import { renderMetricChart } from './metric-chart.js';

let currentTab = 'targets'; // 'targets' | 'live' | 'timeline' | 'insights'
let targets = [];
let activeResearch = {};
let selectedTargetId = null;

export function initAutoResearchPanel() {
  // Wire icon rail button
  const railBtn = document.getElementById('autoresearch-rail-btn');
  if (railBtn) {
    railBtn.addEventListener('click', () => {
      events.emit('panel:show', 'autoresearch');
    });
  }

  // Panel show/hide
  events.on('panel:show', (panel) => {
    const arPanel = document.getElementById('autoresearch-panel');
    if (!arPanel) return;
    if (panel === 'autoresearch') {
      arPanel.classList.remove('hidden');
      refreshTargets();
    } else {
      arPanel.classList.add('hidden');
    }
  });

  // Tab switching
  const panel = document.getElementById('autoresearch-panel');
  if (!panel) return;

  panel.addEventListener('click', (e) => {
    const tab = e.target.closest('.ar-tab');
    if (tab) {
      currentTab = tab.dataset.arTab;
      panel.querySelectorAll('.ar-tab').forEach(t => t.classList.toggle('active', t === tab));
      renderContent();
      return;
    }

    const btn = e.target.closest('button');
    if (!btn) return;

    if (btn.classList.contains('ar-scan-btn')) {
      refreshTargets();
    }
    if (btn.classList.contains('ar-start-btn')) {
      const targetId = btn.dataset.targetId;
      if (targetId) startResearch(targetId);
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

  // Listen for real-time updates from main process
  if (window.api?.research?.onStatusChanged) {
    window.api.research.onStatusChanged((status) => {
      activeResearch[status.targetId] = status;
      updateResearchDot();
      if (currentTab === 'live') renderContent();
    });
  }

  if (window.api?.research?.onExperimentComplete) {
    window.api.research.onExperimentComplete((result) => {
      showToast({
        title: `Experiment: ${result.experiment.status}`,
        message: result.experiment.description?.slice(0, 60) || '',
        icon: result.experiment.status === 'keep' ? '&#9989;' : '&#10060;'
      });
      if (currentTab === 'live' || currentTab === 'timeline') renderContent();
    });
  }
}

async function refreshTargets() {
  try {
    targets = await window.api.research.listTargets();
    activeResearch = await window.api.research.allStatus();
    updateResearchDot();
    renderContent();
  } catch (err) {
    showToast({ title: 'Scan failed', message: err.message, icon: '&#9888;' });
  }
}

async function startResearch(targetId) {
  showToast({ title: 'Starting research...', message: targetId, icon: '&#128300;' });
  try {
    const result = await window.api.research.start({ targetId });
    if (result.success) {
      showToast({ title: 'Research started', message: result.sessionId, icon: '&#9989;' });
      activeResearch[targetId] = { status: 'starting', targetId };
      updateResearchDot();
      renderContent();
    } else {
      showToast({ title: 'Start failed', message: result.error, icon: '&#9888;' });
    }
  } catch (err) {
    showToast({ title: 'Start failed', message: err.message, icon: '&#9888;' });
  }
}

async function stopResearch(targetId) {
  try {
    await window.api.research.stop(targetId);
    delete activeResearch[targetId];
    updateResearchDot();
    renderContent();
    showToast({ title: 'Research stopped', icon: '&#9632;' });
  } catch (err) {
    showToast({ title: 'Stop failed', message: err.message, icon: '&#9888;' });
  }
}

function updateResearchDot() {
  const dot = document.getElementById('research-status-dot');
  if (!dot) return;
  const anyActive = Object.values(activeResearch).some(r => r.status === 'running' || r.status === 'starting');
  dot.style.background = anyActive ? '#6ec76e' : '#555';
  const count = Object.keys(activeResearch).length;
  dot.title = anyActive ? `Research: ${count} active` : 'Research: Idle';
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
        </div>
      </div>`;
  }).join('');
}

async function renderTimelineTab(container) {
  if (!selectedTargetId) {
    container.innerHTML = '<div class="ar-empty"><p>Select a target from the Targets tab first.</p></div>';
    return;
  }

  container.innerHTML = '<div class="ar-loading">Loading timeline...</div>';

  try {
    const timeline = await window.api.research.timeline(selectedTargetId);
    if (!timeline || timeline.length === 0) {
      container.innerHTML = '<div class="ar-empty"><p>No experiments recorded yet for this target.</p></div>';
      return;
    }

    let html = `<div class="ar-timeline-header">${selectedTargetId} — ${timeline.length} experiments</div>`;
    html += renderMetricChart(timeline);
    html += '<div class="ar-timeline-list">';
    // Show most recent first
    for (const exp of [...timeline].reverse().slice(0, 30)) {
      const icon = exp.status === 'keep' ? '&#9989;' : exp.status === 'crash' ? '&#128165;' : '&#10060;';
      const valueStr = exp.metric_value != null ? exp.metric_value.toFixed(3) : '—';
      html += `
        <div class="ar-timeline-row ${exp.status}">
          <span class="ar-tl-icon">${icon}</span>
          <span class="ar-tl-metric">${exp.metric_name || '?'}: ${valueStr}</span>
          <span class="ar-tl-desc">${exp.description || ''}</span>
        </div>`;
    }
    html += '</div>';
    container.innerHTML = html;
  } catch (err) {
    container.innerHTML = `<div class="ar-empty"><p>Error: ${err.message}</p></div>`;
  }
}

async function renderInsightsTab(container) {
  container.innerHTML = '<div class="ar-loading">Querying OpenViking...</div>';

  try {
    const query = selectedTargetId
      ? `autoresearch experiments improvements on ${selectedTargetId}`
      : 'autoresearch experiments improvements best practices';
    const results = await window.api.openviking.search(query, { topK: 10, tier: 'L1' });

    if (results?.error) {
      container.innerHTML = `<div class="ar-empty"><p>OpenViking not available.</p><p class="ar-hint">${results.error}</p></div>`;
      return;
    }

    const resources = results?.result?.resources || [];
    if (resources.length === 0) {
      container.innerHTML = '<div class="ar-empty"><p>No insights found. Run some experiments first, then ingest results into OpenViking.</p></div>';
      return;
    }

    let html = '<div class="ar-insights-header">OpenViking Insights</div>';
    for (const r of resources) {
      const snippet = (r.content || '').slice(0, 150).replace(/</g, '&lt;');
      html += `
        <div class="ar-insight-card">
          <div class="ar-insight-title">${r.uri || r.name || 'Resource'}</div>
          <div class="ar-insight-snippet">${snippet}...</div>
          <div class="ar-insight-score">Score: ${(r.score || 0).toFixed(3)}</div>
        </div>`;
    }
    container.innerHTML = html;
  } catch (err) {
    container.innerHTML = `<div class="ar-empty"><p>Error querying insights: ${err.message}</p></div>`;
  }
}
