// ── OpenViking Context Panel ──────────────────────────────
// UI for browsing, searching, and managing OpenViking knowledge

import { events } from '../events.js';
import { showToast } from '../notifications/toast.js';

let ovStatus = { running: false, healthy: false, resources: 0, memories: 0 };
let searchResults = [];
let memoryResults = [];
let treeData = null;
let currentView = 'search'; // 'search' | 'memories' | 'browse' | 'status'

export function initOpenVikingPanel() {
  // Wire icon rail button
  const ovBtn = document.getElementById('openviking-rail-btn');
  if (ovBtn) {
    ovBtn.addEventListener('click', () => {
      events.emit('panel:show', 'openviking');
    });
  }

  // Panel show handler
  events.on('panel:show', (panel) => {
    const ovPanel = document.getElementById('openviking-panel');
    if (!ovPanel) return;
    if (panel === 'openviking') {
      ovPanel.classList.remove('hidden');
      refreshStatus();
    } else {
      ovPanel.classList.add('hidden');
    }
  });

  // Server control buttons
  const panel = document.getElementById('openviking-panel');
  if (!panel) return;

  panel.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;

    if (btn.classList.contains('ov-start-btn')) {
      btn.disabled = true;
      btn.textContent = 'Starting...';
      showToast({ title: 'Starting OpenViking...', icon: '&#9881;' });
      try {
        const result = await window.api.openviking.start();
        if (result.success) {
          showToast({ title: 'OpenViking started', icon: '&#9989;' });
        } else {
          showToast({ title: 'Start failed', message: result.error || 'Unknown error', icon: '&#9888;' });
        }
      } catch (err) {
        showToast({ title: 'Start failed', message: err.message, icon: '&#9888;' });
      }
      btn.disabled = false;
      await refreshStatus();
    }

    if (btn.classList.contains('ov-stop-btn')) {
      await window.api.openviking.stop();
      showToast({ title: 'OpenViking stopped', icon: '&#9632;' });
      await refreshStatus();
    }

    if (btn.classList.contains('ov-ingest-btn')) {
      btn.disabled = true;
      btn.textContent = 'Ingesting...';
      showToast({ title: 'Ingesting knowledge...', icon: '&#128218;' });
      try {
        const result = await window.api.openviking.ingestAll();
        if (result.error) {
          showToast({ title: 'Ingest error', message: result.error, icon: '&#9888;' });
        } else {
          const total = Object.values(result).reduce((sum, r) => sum + (r.success || 0), 0);
          showToast({ title: `Ingested ${total} resources`, icon: '&#9989;' });
        }
      } catch (err) {
        showToast({ title: 'Ingest failed', message: err.message, icon: '&#9888;' });
      }
      btn.disabled = false;
      btn.textContent = 'Ingest All';
      await refreshStatus();
    }

    // Tab switching
    if (btn.dataset.ovTab) {
      currentView = btn.dataset.ovTab;
      renderPanel();
    }

    // Search
    if (btn.classList.contains('ov-search-btn')) {
      await performSearch();
    }

    // Memory search
    if (btn.classList.contains('ov-memory-search-btn')) {
      await performMemorySearch();
    }

    // Refresh tree
    if (btn.classList.contains('ov-refresh-tree-btn')) {
      await refreshTree();
    }
  });

  // Enter key on search
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      if (e.target.classList.contains('ov-search-input')) {
        performSearch();
      } else if (e.target.classList.contains('ov-memory-input')) {
        performMemorySearch();
      }
    }
  });

  // Initial render
  renderPanel();

  // Periodic status check
  setInterval(refreshStatus, 30000);
}

async function refreshStatus() {
  try {
    const status = await window.api.openviking.status();
    ovStatus = {
      running: status.running || false,
      healthy: status.healthy || false,
      resources: status.resources || 0,
      memories: status.memories || 0,
      port: status.port || 1933,
      pid: status.pid || null,
    };
  } catch {
    ovStatus = { running: false, healthy: false, resources: 0, memories: 0 };
  }
  // system-status.js manages the system status dots (M/V/O) — we only update the panel-internal status here
  updateStatusSection();
}

function updateStatusSection() {
  const el = document.getElementById('ov-status-info');
  if (!el) return;
  if (ovStatus.running && ovStatus.healthy) {
    el.innerHTML = `
      <div class="ov-stat"><span class="ov-stat-val">${ovStatus.resources}</span> resources</div>
      <div class="ov-stat"><span class="ov-stat-val">${ovStatus.memories}</span> memories</div>
      <div class="ov-stat-sub">Port ${ovStatus.port}${ovStatus.pid ? ' | PID ' + ovStatus.pid : ''}</div>
    `;
  } else if (ovStatus.running) {
    el.innerHTML = '<div class="ov-stat-sub">Starting up...</div>';
  } else {
    el.innerHTML = '<div class="ov-stat-sub">Server stopped</div>';
  }
}

function renderPanel() {
  const content = document.getElementById('ov-content');
  if (!content) return;

  // Update tab highlights
  const panel = document.getElementById('openviking-panel');
  if (panel) {
    panel.querySelectorAll('.ov-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.ovTab === currentView);
    });
  }

  switch (currentView) {
    case 'search':
      content.innerHTML = renderSearchView();
      break;
    case 'memories':
      content.innerHTML = renderMemoryView();
      break;
    case 'browse':
      content.innerHTML = renderBrowseView();
      break;
    case 'status':
      content.innerHTML = renderStatusView();
      break;
  }
}

function renderSearchView() {
  let html = `
    <div class="ov-search-box">
      <input type="text" class="ov-search-input" placeholder="Search knowledge base..." value="">
      <select class="ov-tier-select">
        <option value="L0">L0 Abstract</option>
        <option value="L1" selected>L1 Overview</option>
        <option value="L2">L2 Full</option>
      </select>
      <button class="btn btn-primary ov-search-btn" style="padding:4px 10px;font-size:var(--font-size-xs)">Search</button>
    </div>
  `;

  if (searchResults.length > 0) {
    html += '<div class="ov-results">';
    for (const r of searchResults) {
      const score = r.score ? `<span class="ov-score">${(r.score * 100).toFixed(0)}%</span>` : '';
      const uri = r.uri || '';
      const uriShort = uri.replace('viking://resources/', '').split('/').slice(-2).join('/');
      const content = escapeHtml(r.overview || r.abstract || '(content still processing...)').slice(0, 400);
      const type = r.context_type === 'memory' ? '<span class="ov-memory-tag">MEM</span>' : '';
      html += `
        <div class="ov-result-card">
          <div class="ov-result-header">${score}${type}<span class="ov-result-uri">${escapeHtml(uriShort)}</span></div>
          <div class="ov-result-body">${content}</div>
        </div>
      `;
    }
    html += '</div>';
  } else {
    html += '<div class="ov-empty">Search across Hytale references, codex, transcripts, and patterns.</div>';
  }
  return html;
}

function renderMemoryView() {
  let html = `
    <div class="ov-search-box">
      <input type="text" class="ov-memory-input" placeholder="Search memories & patterns...">
      <select class="ov-memory-category">
        <option value="">All</option>
        <option value="CASES">Cases</option>
        <option value="PATTERNS">Patterns</option>
        <option value="TOOLS">Tools</option>
        <option value="SKILLS">Skills</option>
        <option value="PROFILE">Profile</option>
        <option value="PREFERENCES">Preferences</option>
        <option value="ENTITIES">Entities</option>
        <option value="EVENTS">Events</option>
      </select>
      <button class="btn btn-primary ov-memory-search-btn" style="padding:4px 10px;font-size:var(--font-size-xs)">Recall</button>
    </div>
  `;

  if (memoryResults.length > 0) {
    html += '<div class="ov-results">';
    for (const r of memoryResults) {
      const score = r.score ? `<span class="ov-score">${(r.score * 100).toFixed(0)}%</span>` : '';
      const uri = r.uri || '';
      const uriShort = uri.replace('viking://agent/', '').split('/').slice(-2).join('/');
      const content = escapeHtml(r.overview || r.abstract || '(memory content)').slice(0, 300);
      html += `
        <div class="ov-result-card ov-memory-card">
          <div class="ov-result-header">${score}<span class="ov-memory-tag">MEMORY</span><span class="ov-result-uri">${escapeHtml(uriShort)}</span></div>
          <div class="ov-result-body">${content}</div>
        </div>
      `;
    }
    html += '</div>';
  } else {
    html += '<div class="ov-empty">Agent memories extracted from sessions. Search for patterns, gotchas, and solutions.</div>';
  }
  return html;
}

function renderBrowseView() {
  let html = `
    <div class="ov-toolbar">
      <button class="btn btn-secondary ov-refresh-tree-btn" style="padding:2px 8px;font-size:var(--font-size-xs)">Refresh</button>
    </div>
  `;

  if (treeData && Array.isArray(treeData) && treeData.length > 0) {
    html += '<div class="ov-tree">';
    html += renderFlatTree(treeData);
    html += '</div>';
  } else if (treeData) {
    html += '<div class="ov-empty">Knowledge base is empty. Ingest some content first.</div>';
  } else {
    html += '<div class="ov-empty">Browse the viking:// filesystem. Click Refresh to load.</div>';
  }
  return html;
}

function renderFlatTree(entries) {
  let html = '';
  for (const entry of entries) {
    const depth = (entry.rel_path || entry.uri || '').split('/').filter(Boolean).length;
    const indent = Math.max(0, depth - 1) * 16;
    const name = (entry.rel_path || entry.uri || '').split('/').filter(Boolean).pop() || entry.uri;
    const sizeStr = entry.size > 0 ? ` (${formatSize(entry.size)})` : '';
    const abstract = entry.abstract && entry.abstract !== 'Directory overview' ? ` — ${entry.abstract}` : '';

    if (entry.isDir) {
      html += `<div class="ov-tree-folder" style="padding-left:${indent}px" title="${escapeHtml(entry.uri)}">&#128193; ${escapeHtml(name)}/${escapeHtml(abstract)}</div>`;
    } else {
      html += `<div class="ov-tree-item" style="padding-left:${indent}px" title="${escapeHtml(entry.uri)}">&#128196; ${escapeHtml(name)}${sizeStr}</div>`;
    }
  }
  return html;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function renderStatusView() {
  const running = ovStatus.running && ovStatus.healthy;
  return `
    <div class="ov-status-panel">
      <div class="ov-status-row">
        <span class="ov-status-indicator ${running ? 'active' : ''}">${running ? 'RUNNING' : 'STOPPED'}</span>
        ${running
          ? `<button class="btn btn-danger ov-stop-btn" style="padding:3px 10px;font-size:var(--font-size-xs)">Stop</button>`
          : `<button class="btn btn-primary ov-start-btn" style="padding:3px 10px;font-size:var(--font-size-xs)">Start Server</button>`
        }
      </div>
      <div id="ov-status-info" class="ov-status-info"></div>
      <div class="ov-divider"></div>
      <div class="ov-actions">
        <button class="btn btn-secondary ov-ingest-btn" style="padding:4px 12px;font-size:var(--font-size-xs)">Ingest All</button>
        <div class="ov-actions-hint">Ingest Hytale refs, codex, transcripts & project memories into the knowledge base.</div>
      </div>
      <div class="ov-divider"></div>
      <div class="ov-about">
        <div class="ov-about-title">OpenViking Context Database</div>
        <div class="ov-about-desc">Semantic search + tiered content loading for AI agent context management. L0/L1/L2 tiers reduce token usage by ~83%.</div>
      </div>
    </div>
  `;
}

async function performSearch() {
  const panel = document.getElementById('openviking-panel');
  if (!panel) return;
  const input = panel.querySelector('.ov-search-input');
  const tierSelect = panel.querySelector('.ov-tier-select');
  const query = input?.value?.trim();
  if (!query) return;

  const btn = panel.querySelector('.ov-search-btn');
  if (btn) { btn.disabled = true; btn.textContent = '...'; }

  try {
    const results = await window.api.openviking.search(query, {
      topK: 8,
      tier: tierSelect?.value || 'L1',
    });
    // Response is {memories: [], resources: [], skills: [], total: N}
    if (results && typeof results === 'object' && !Array.isArray(results)) {
      const resources = results.resources || [];
      const memories = results.memories || [];
      searchResults = [...resources, ...memories].filter(r =>
        r.uri && !r.uri.endsWith('/.abstract.md') && !r.uri.endsWith('/.overview.md')
      );
    } else if (Array.isArray(results)) {
      searchResults = results;
    } else {
      searchResults = [];
    }
    if (results?.error) {
      showToast({ title: 'Search error', message: results.error, icon: '&#9888;' });
    }
  } catch (err) {
    searchResults = [];
    showToast({ title: 'Search failed', message: err.message, icon: '&#9888;' });
  }

  if (btn) { btn.disabled = false; btn.textContent = 'Search'; }
  renderPanel();

  // Re-focus input and restore query
  const newInput = panel.querySelector('.ov-search-input');
  if (newInput) { newInput.value = query; newInput.focus(); }
}

async function performMemorySearch() {
  const panel = document.getElementById('openviking-panel');
  if (!panel) return;
  const input = panel.querySelector('.ov-memory-input');
  const catSelect = panel.querySelector('.ov-memory-category');
  const query = input?.value?.trim();
  if (!query) return;

  const btn = panel.querySelector('.ov-memory-search-btn');
  if (btn) { btn.disabled = true; btn.textContent = '...'; }

  try {
    const category = catSelect?.value || null;
    const results = await window.api.openviking.searchMemories(query, 'claude-sessions');
    // Response is {memories: [], resources: [], skills: [], total: N}
    if (results && typeof results === 'object' && !Array.isArray(results)) {
      const memories = results.memories || [];
      const resources = results.resources || [];
      memoryResults = [...memories, ...resources].filter(r =>
        r.uri && !r.uri.endsWith('/.abstract.md') && !r.uri.endsWith('/.overview.md')
      );
    } else if (Array.isArray(results)) {
      memoryResults = results;
    } else {
      memoryResults = [];
    }
  } catch (err) {
    memoryResults = [];
  }

  if (btn) { btn.disabled = false; btn.textContent = 'Recall'; }
  renderPanel();

  const newInput = panel.querySelector('.ov-memory-input');
  if (newInput) { newInput.value = query; newInput.focus(); }
}

async function refreshTree() {
  try {
    treeData = await window.api.openviking.tree('viking://', 3);
  } catch {
    treeData = null;
  }
  renderPanel();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
