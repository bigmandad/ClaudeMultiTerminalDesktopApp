// ── OmniMode — Parallel multi-LLM execution with peer review ──

import { state } from '../state.js';
import { events } from '../events.js';
import { showToast } from '../notifications/toast.js';

let _enabled = false;
let _selectedProviders = new Set();
let _activeSession = null;
let _overlayEl = null;

export function initOmniMode() {
  // Create the OmniMode toggle bar (below the tab bar, above terminals)
  _createToggleBar();

  // Listen for provider status changes
  events.on('provider:statusChanged', refreshProviderChecks);

  // Load initial provider status
  refreshProviderChecks();

  // Expose fanOutPrompt globally so terminal pane can call it
  window.__omniMode = {
    isEnabled: isOmniModeEnabled,
    fanOut: fanOutPrompt,
    getSelectedProviders,
  };
}

export function isOmniModeEnabled() {
  return _enabled;
}

export function getSelectedProviders() {
  return [..._selectedProviders];
}

/**
 * Called when user sends a prompt in the active terminal.
 * If OmniMode is on, fans out to selected API providers in parallel.
 */
export async function fanOutPrompt(prompt, sessionId) {
  if (!_enabled || _selectedProviders.size === 0) return false;

  // Build provider configs — Ollama entries use "ollama:modelname" format
  const providers = [..._selectedProviders].map(pid => {
    if (pid.startsWith('ollama:')) {
      return { providerId: 'ollama', model: pid.slice(7) };
    }
    const defaultModels = { openai: 'gpt-4o', gemini: 'gemini-2.5-pro', ollama: 'llama3.2' };
    return { providerId: pid, model: defaultModels[pid] || 'default' };
  });

  showToast(`⚡ OmniMode: Sending to ${providers.length} providers...`, 'info');

  try {
    // Create multi-LLM session
    const createResult = await window.api.multiLlm.create(sessionId, providers);
    if (!createResult.success) {
      showToast(`OmniMode failed: ${createResult.error}`, 'error');
      return false;
    }

    _activeSession = sessionId;

    // Show the results overlay
    _showResultsOverlay(createResult.subSessions, prompt);

    // Fan out the prompt
    const result = await window.api.multiLlm.sendToAll(sessionId, prompt);

    if (result.success) {
      // Update overlay with results
      _updateResults(result.results);

      // Auto-synthesize (peer review)
      showToast('⚡ Synthesizing peer review...', 'info');
      const synthesis = await window.api.multiLlm.synthesize(
        sessionId, prompt, 'openai', 'gpt-4o'
      );

      if (synthesis.success) {
        _showSynthesis(synthesis.synthesis);
      }
    }

    return true;
  } catch (e) {
    showToast(`OmniMode error: ${e.message}`, 'error');
    return false;
  }
}

// ── UI Creation ──

function _createToggleBar() {
  const mainArea = document.getElementById('main-area');
  if (!mainArea) return;

  const bar = document.createElement('div');
  bar.id = 'omni-mode-bar';
  bar.className = 'omni-mode-bar hidden';
  bar.innerHTML = `
    <div class="omni-toggle-row">
      <label class="omni-toggle-label">
        <input type="checkbox" id="omni-mode-toggle" class="omni-toggle-checkbox">
        <span class="omni-toggle-switch"></span>
        <span class="omni-toggle-text">⚡ OmniMode</span>
      </label>
      <div class="omni-provider-checks" id="omni-provider-checks"></div>
      <span class="omni-status" id="omni-status"></span>
    </div>
  `;

  // Insert at top of main area
  mainArea.insertBefore(bar, mainArea.firstChild);

  // Wire toggle
  const toggle = document.getElementById('omni-mode-toggle');
  toggle.addEventListener('change', () => {
    _enabled = toggle.checked;
    bar.classList.toggle('omni-active', _enabled);
    document.getElementById('omni-status').textContent =
      _enabled ? `${_selectedProviders.size} providers selected` : '';
    events.emit('omniMode:toggled', _enabled);
  });

  // Show the bar (remove hidden after a tick so CSS transition works)
  requestAnimationFrame(() => bar.classList.remove('hidden'));
}

async function refreshProviderChecks() {
  const container = document.getElementById('omni-provider-checks');
  if (!container) return;

  let providers = [];
  try {
    providers = await window.api.providers.list();
  } catch (e) {
    return;
  }

  // Build checkbox items — expand Ollama into individual models
  const items = [];
  for (const p of providers) {
    if (p.id === 'claude') continue; // Claude always runs via PTY
    if (p.id === 'ollama' && p.configured) {
      // Fetch individual Ollama models and show each as a checkbox
      try {
        const models = await window.api.providers.models('ollama');
        for (const m of models) {
          items.push({
            checkId: `ollama:${m.id}`,
            name: `🦙 ${m.name}`,
            color: p.color,
            configured: true,
            title: m.description || m.name,
          });
        }
      } catch (e) {
        // Fallback: show generic Ollama checkbox
        items.push({ checkId: 'ollama', name: p.displayName, color: p.color, configured: true, title: 'Ollama (Local)' });
      }
    } else {
      items.push({ checkId: p.id, name: p.displayName, color: p.color, configured: p.configured, title: p.displayName });
    }
  }

  container.innerHTML = items.map(item => {
    const checked = _selectedProviders.has(item.checkId) ? 'checked' : '';
    const disabled = !item.configured ? 'disabled' : '';
    const statusColor = item.configured ? item.color : '#555';

    return `
      <label class="omni-provider-check" style="border-color: ${statusColor}" title="${item.title}${!item.configured ? ' (not configured)' : ''}">
        <input type="checkbox" data-provider="${item.checkId}" ${checked} ${disabled}>
        <span class="omni-provider-dot" style="background: ${statusColor}"></span>
        <span class="omni-provider-name">${item.name}</span>
      </label>
    `;
  }).join('');

  // Wire checkboxes
  container.querySelectorAll('input[data-provider]').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) {
        _selectedProviders.add(cb.dataset.provider);
      } else {
        _selectedProviders.delete(cb.dataset.provider);
      }
      document.getElementById('omni-status').textContent =
        _enabled ? `${_selectedProviders.size} providers selected` : '';
    });
  });
}

// ── Results Overlay ──

function _showResultsOverlay(subSessions, prompt) {
  // Remove existing overlay
  if (_overlayEl) _overlayEl.remove();

  _overlayEl = document.createElement('div');
  _overlayEl.id = 'omni-results-overlay';
  _overlayEl.className = 'omni-results-overlay';

  const truncPrompt = prompt.length > 100 ? prompt.slice(0, 100) + '...' : prompt;

  _overlayEl.innerHTML = `
    <div class="omni-results-header">
      <span class="omni-results-title">⚡ OmniMode Results</span>
      <span class="omni-results-prompt">${truncPrompt}</span>
      <button class="omni-results-close" id="omni-close-btn">✕</button>
    </div>
    <div class="omni-results-grid" id="omni-results-grid">
      ${subSessions.map(s => `
        <div class="omni-result-card" data-provider="${s.providerId}" style="border-color: ${s.color}">
          <div class="omni-result-header" style="background: ${s.color}22">
            <span class="omni-result-provider">${s.providerId.toUpperCase()}</span>
            <span class="omni-result-model">${s.model}</span>
            <span class="omni-result-status">⏳ Running...</span>
          </div>
          <div class="omni-result-body" id="omni-body-${s.providerId}">
            <div class="omni-spinner"></div>
          </div>
        </div>
      `).join('')}
    </div>
    <div class="omni-synthesis" id="omni-synthesis">
      <div class="omni-synthesis-header">🔍 Peer Review Synthesis</div>
      <div class="omni-synthesis-body" id="omni-synthesis-body">Waiting for all providers to complete...</div>
    </div>
  `;

  document.body.appendChild(_overlayEl);

  // Close button
  document.getElementById('omni-close-btn').addEventListener('click', () => {
    _overlayEl.remove();
    _overlayEl = null;
    if (_activeSession) {
      window.api.multiLlm.destroy(_activeSession);
      _activeSession = null;
    }
  });
}

function _updateResults(results) {
  if (!_overlayEl) return;

  for (const r of results) {
    const body = document.getElementById(`omni-body-${r.providerId}`);
    const card = _overlayEl.querySelector(`[data-provider="${r.providerId}"]`);
    if (!body || !card) continue;

    const statusEl = card.querySelector('.omni-result-status');
    const duration = r.duration ? `(${(r.duration / 1000).toFixed(1)}s)` : '';

    if (r.status === 'complete') {
      statusEl.textContent = `✓ Complete ${duration}`;
      statusEl.style.color = '#7ab87a';
      // Render response (simplified markdown)
      body.innerHTML = `<pre class="omni-result-text">${escapeHtml(r.response || 'No response')}</pre>`;
    } else {
      statusEl.textContent = `✗ ${r.status} ${duration}`;
      statusEl.style.color = '#b87a7a';
      body.innerHTML = `<pre class="omni-result-text omni-error">${escapeHtml(r.response || 'Error')}</pre>`;
    }
  }
}

function _showSynthesis(text) {
  const body = document.getElementById('omni-synthesis-body');
  if (body) {
    body.innerHTML = `<pre class="omni-synthesis-text">${escapeHtml(text)}</pre>`;
  }
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
