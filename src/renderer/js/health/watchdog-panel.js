// ── Watchdog Panel ─────────────────────────────────────────
// Shows per-probe health, last-check time, fix-attempt history.
// Lets the user grant git-push consent and trigger a manual probe run.

import { events } from '../events.js';
import { showToast } from '../notifications/toast.js';

let currentStatus = null;
let unsubscribers = [];

const STATUS_LABEL = {
  healthy: 'OK',
  degraded: 'DEGRADED',
  down: 'DOWN',
  unknown: 'UNKNOWN',
};

export function initWatchdogPanel() {
  const railBtn = document.getElementById('watchdog-rail-btn');
  if (railBtn) {
    railBtn.addEventListener('click', () => events.emit('panel:show', 'watchdog'));
  }

  events.on('panel:show', (panel) => {
    const el = document.getElementById('watchdog-panel');
    if (!el) return;
    if (panel === 'watchdog') {
      el.classList.remove('hidden');
      refresh();
    } else {
      el.classList.add('hidden');
    }
  });

  const runBtn = document.getElementById('watchdog-runnow-btn');
  if (runBtn) {
    runBtn.addEventListener('click', async () => {
      runBtn.disabled = true;
      runBtn.style.opacity = '0.5';
      try {
        await window.api.watchdog.runNow();
        showToast({ title: 'Watchdog: probes re-run', icon: '&#9881;' });
        await refresh();
      } catch (err) {
        showToast({ title: 'Watchdog failed', message: err.message, icon: '&#9888;' });
      } finally {
        runBtn.disabled = false;
        runBtn.style.opacity = '';
      }
    });
  }

  // Live status pushes from main
  if (window.api?.watchdog?.onStatus) {
    const unsub = window.api.watchdog.onStatus((status) => {
      currentStatus = status;
      // Only re-render when the panel is visible to avoid wasted DOM work
      const el = document.getElementById('watchdog-panel');
      if (el && !el.classList.contains('hidden')) {
        render();
      }
    });
    if (typeof unsub === 'function') unsubscribers.push(unsub);
  }
}

async function refresh() {
  try {
    currentStatus = await window.api.watchdog.status();
    render();
  } catch (err) {
    console.error('[Watchdog] status fetch failed:', err);
    const content = document.getElementById('watchdog-content');
    if (content) {
      content.innerHTML = `<div class="wd-empty">Watchdog unavailable: ${escapeHtml(err.message)}</div>`;
    }
  }
}

function render() {
  const content = document.getElementById('watchdog-content');
  if (!content) return;

  if (!currentStatus) {
    content.innerHTML = `<div class="wd-empty">Waiting for watchdog status&hellip;</div>`;
    return;
  }

  const { running, results = {}, lastCheck, gitPushConsented, probeCount } = currentStatus;
  const probeNames = Object.keys(results);

  const summary = `
    <div class="wd-summary">
      <div class="wd-summary-state ${running ? 'running' : 'stopped'}">
        <span class="wd-state-dot"></span>
        <span>${running ? 'Running' : 'Stopped'}</span>
        <span style="opacity:0.6">&middot; ${probeCount || probeNames.length} probes</span>
      </div>
      <div>${lastCheck ? `last check ${formatRelative(lastCheck)}` : 'no check yet'}</div>
    </div>
  `;

  const consent = `
    <div class="wd-consent">
      <div class="wd-consent-label">
        Git-push auto-fix
        <span class="wd-consent-hint">When granted, watchdog may push dirty repo fixes to origin.</span>
      </div>
      <button class="wd-consent-btn ${gitPushConsented ? 'granted' : ''}"
              data-action="${gitPushConsented ? 'revoke' : 'consent'}">
        ${gitPushConsented ? 'Revoke' : 'Grant'}
      </button>
    </div>
  `;

  const probesHtml = probeNames.length === 0
    ? `<div class="wd-empty">No probe data yet. Click the refresh button to run probes.</div>`
    : `<div class="wd-probes">${probeNames.map(n => renderProbe(n, results[n])).join('')}</div>`;

  content.innerHTML = summary + consent + probesHtml;

  // Wire consent button
  const btn = content.querySelector('.wd-consent-btn');
  if (btn) {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.action;
      btn.disabled = true;
      try {
        if (action === 'consent') {
          await window.api.watchdog.consentGitPush();
          showToast({ title: 'Git-push consent granted', icon: '&#9989;' });
        } else {
          await window.api.watchdog.revokeGitPush();
          showToast({ title: 'Git-push consent revoked', icon: '&#9632;' });
        }
        await refresh();
      } catch (err) {
        showToast({ title: 'Failed', message: err.message, icon: '&#9888;' });
      } finally {
        btn.disabled = false;
      }
    });
  }
}

function renderProbe(name, result) {
  const status = result?.status || 'unknown';
  const label = result?.label || name;
  const message = result?.message || '';
  const checkedAt = result?.checkedAt;
  const cssStatus = ['healthy', 'degraded', 'down'].includes(status) ? status : 'unknown';

  return `
    <div class="wd-probe ${cssStatus}" data-probe="${escapeHtml(name)}">
      <div class="wd-probe-head">
        <span class="wd-probe-label">${escapeHtml(label)}</span>
        <span class="wd-probe-status">${STATUS_LABEL[status] || status}</span>
      </div>
      ${message ? `<div class="wd-probe-message">${escapeHtml(message)}</div>` : ''}
      <div class="wd-probe-meta">
        <span>${name}</span>
        ${checkedAt ? `<span>${formatRelative(checkedAt)}</span>` : ''}
      </div>
    </div>
  `;
}

function formatRelative(ts) {
  if (!ts) return '';
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 0) return 'now';
  if (diff < 5000) return 'just now';
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  return `${Math.floor(diff / 3600000)}h ago`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
