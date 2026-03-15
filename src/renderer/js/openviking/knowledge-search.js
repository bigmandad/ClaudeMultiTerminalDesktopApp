// ── Knowledge Search Overlay ─────────────────────────────
// Opens from terminal pane toolbar, searches OpenViking,
// and allows inserting results as context into the terminal input.

import { events } from '../events.js';
import { showToast } from '../notifications/toast.js';

export function initKnowledgeSearch() {
  // Delegate click from all pane knowledge buttons
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.knowledge-btn');
    if (!btn) return;
    e.stopPropagation();

    const pane = btn.closest('.terminal-pane');
    if (!pane) return;

    // Toggle: close if already open
    const existing = pane.querySelector('.knowledge-overlay');
    if (existing) {
      existing.remove();
      return;
    }

    openKnowledgeSearch(pane);
  });
}

function openKnowledgeSearch(pane) {
  const overlay = document.createElement('div');
  overlay.className = 'knowledge-overlay';
  overlay.innerHTML = `
    <div class="knowledge-header">
      <span class="knowledge-title">&#128270; Knowledge Search</span>
      <div class="knowledge-header-actions">
        <select class="knowledge-tier-select">
          <option value="L0">L0 Abstract</option>
          <option value="L1" selected>L1 Overview</option>
          <option value="L2">L2 Full</option>
        </select>
        <button class="btn btn-secondary knowledge-close-btn" style="padding:2px 8px;font-size:var(--font-size-xs)">Close</button>
      </div>
    </div>
    <div class="knowledge-search-row">
      <input type="text" class="knowledge-query" placeholder="Search codex, patterns, transcripts..." autofocus>
      <button class="btn btn-primary knowledge-go-btn" style="padding:3px 10px;font-size:var(--font-size-xs)">Go</button>
    </div>
    <div class="knowledge-results">
      <div class="knowledge-empty">Type a query to search across all ingested knowledge.</div>
    </div>
  `;

  // Close button
  overlay.querySelector('.knowledge-close-btn').addEventListener('click', () => overlay.remove());

  // Search on Enter or button click
  const queryInput = overlay.querySelector('.knowledge-query');
  const goBtn = overlay.querySelector('.knowledge-go-btn');
  const tierSelect = overlay.querySelector('.knowledge-tier-select');

  const doSearch = async () => {
    const query = queryInput.value.trim();
    if (!query) return;

    goBtn.disabled = true;
    goBtn.textContent = '...';

    try {
      const results = await window.api.openviking.search(query, {
        topK: 8,
        tier: tierSelect.value,
      });

      // Parse nested response structure
      let items = [];
      if (results && typeof results === 'object' && !Array.isArray(results)) {
        const resources = results.resources || [];
        const memories = results.memories || [];
        items = [...resources, ...memories].filter(r =>
          r.uri && !r.uri.endsWith('/.abstract.md') && !r.uri.endsWith('/.overview.md')
        );
      } else if (Array.isArray(results)) {
        items = results;
      }

      renderResults(overlay, items, pane, tierSelect.value);
    } catch (err) {
      const resultsDiv = overlay.querySelector('.knowledge-results');
      resultsDiv.innerHTML = `<div class="knowledge-empty">Search failed: ${escapeHtml(err.message)}</div>`;
    }

    goBtn.disabled = false;
    goBtn.textContent = 'Go';
  };

  queryInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSearch();
    if (e.key === 'Escape') overlay.remove();
  });
  goBtn.addEventListener('click', doSearch);

  // Insert before terminal container
  const termContainer = pane.querySelector('.terminal-container');
  if (termContainer) {
    termContainer.parentNode.insertBefore(overlay, termContainer);
  } else {
    pane.appendChild(overlay);
  }

  queryInput.focus();
}

async function renderResults(overlay, items, pane, tier) {
  const resultsDiv = overlay.querySelector('.knowledge-results');

  if (items.length === 0) {
    resultsDiv.innerHTML = '<div class="knowledge-empty">No results found. Try different keywords.</div>';
    return;
  }

  let html = '';
  for (const item of items.slice(0, 8)) {
    const score = item.score ? `${(item.score * 100).toFixed(0)}%` : '';
    const uri = item.uri || '';
    const uriShort = uri.replace('viking://resources/', '').replace('viking://agent/', 'agent/').split('/').slice(-2).join('/');
    let preview = item.overview || item.abstract || '';
    const isMemory = item.context_type === 'memory';

    // If no preview, try to fetch content
    if (!preview || preview.length < 30) {
      try {
        const content = await window.api.openviking.read(uri, tier);
        if (typeof content === 'string') preview = content;
        else if (content) preview = JSON.stringify(content);
      } catch { /* use what we have */ }
    }

    const previewText = escapeHtml((preview || '(processing...)').slice(0, 250));

    html += `
      <div class="knowledge-result-card" data-uri="${escapeHtml(uri)}" data-tier="${tier}">
        <div class="knowledge-result-top">
          <span class="knowledge-score">${score}</span>
          ${isMemory ? '<span class="knowledge-mem-tag">MEM</span>' : ''}
          <span class="knowledge-uri">${escapeHtml(uriShort)}</span>
          <button class="knowledge-insert-btn" title="Insert as context">&#8629; Insert</button>
        </div>
        <div class="knowledge-result-preview">${previewText}</div>
      </div>
    `;
  }
  resultsDiv.innerHTML = html;

  // Wire insert buttons
  resultsDiv.querySelectorAll('.knowledge-insert-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const card = btn.closest('.knowledge-result-card');
      const uri = card.dataset.uri;
      const insertTier = card.dataset.tier;

      btn.textContent = '...';
      btn.disabled = true;

      try {
        // Fetch full content for insertion
        let content = await window.api.openviking.read(uri, insertTier);
        if (typeof content !== 'string') content = JSON.stringify(content, null, 2);

        // Insert into pane input
        const inputEl = pane.querySelector('.pane-input');
        if (inputEl) {
          const uriShort = uri.split('/').slice(-2).join('/');
          const prefix = inputEl.value ? inputEl.value + '\n\n' : '';
          inputEl.value = prefix + `[Context from ${uriShort}]:\n${content.slice(0, 2000)}`;
          inputEl.focus();
          showToast({ title: 'Knowledge inserted', icon: '&#128218;' });
        }
      } catch (err) {
        showToast({ title: 'Insert failed', message: err.message, icon: '&#9888;' });
      }

      btn.textContent = '✓';
      setTimeout(() => { btn.textContent = '↵ Insert'; btn.disabled = false; }, 1500);
    });
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
