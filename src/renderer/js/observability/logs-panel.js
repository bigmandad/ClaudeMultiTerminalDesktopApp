// ── Logs Panel ─────────────────────────────────────────────
// Tail of the structured event log with live updates and source/level filters.
// Reads from window.api.log.tail() on open, then subscribes via log.onEvent.

import { events } from '../events.js';

const MAX_RENDERED = 500;

let buffer = [];
let levelFilter = '';
let sourceFilter = '';
let unsubscribe = null;

export function initLogsPanel() {
  const railBtn = document.getElementById('logs-rail-btn');
  if (railBtn) {
    railBtn.addEventListener('click', () => events.emit('panel:show', 'logs'));
  }

  events.on('panel:show', async (panel) => {
    const el = document.getElementById('logs-panel');
    if (!el) return;
    if (panel === 'logs') {
      el.classList.remove('hidden');
      await loadTail();
      attachLiveStream();
    } else {
      el.classList.add('hidden');
      detachLiveStream();
    }
  });

  const refreshBtn = document.getElementById('logs-refresh-btn');
  if (refreshBtn) refreshBtn.addEventListener('click', loadTail);

  const lvl = document.getElementById('logs-level-filter');
  if (lvl) lvl.addEventListener('change', () => { levelFilter = lvl.value || ''; render(); });

  const src = document.getElementById('logs-source-filter');
  if (src) src.addEventListener('input', () => { sourceFilter = src.value.trim().toLowerCase(); render(); });
}

async function loadTail() {
  if (!window.api?.log?.tail) return;
  try {
    buffer = await window.api.log.tail({ limit: MAX_RENDERED });
    render();
  } catch (err) {
    console.error('[Logs] tail failed:', err);
  }
}

function attachLiveStream() {
  if (unsubscribe || !window.api?.log?.onEvent) return;
  unsubscribe = window.api.log.onEvent((rec) => {
    buffer.push(rec);
    if (buffer.length > MAX_RENDERED) buffer = buffer.slice(-MAX_RENDERED);
    appendRow(rec);
  });
}

function detachLiveStream() {
  if (typeof unsubscribe === 'function') unsubscribe();
  unsubscribe = null;
}

function passesFilter(rec) {
  if (levelFilter && rec.level !== levelFilter) return false;
  if (sourceFilter) {
    const s = String(rec.source || '').toLowerCase();
    if (!s.includes(sourceFilter)) return false;
  }
  return true;
}

function render() {
  const content = document.getElementById('logs-content');
  if (!content) return;
  const html = buffer.filter(passesFilter).map(renderRow).join('');
  content.innerHTML = html || '<div class="wd-empty">No log entries match the current filter.</div>';
  content.scrollTop = content.scrollHeight;
}

function appendRow(rec) {
  if (!passesFilter(rec)) return;
  const content = document.getElementById('logs-content');
  if (!content) return;
  // If we're showing the empty-state, refresh fully
  if (content.querySelector('.wd-empty')) {
    render();
    return;
  }
  content.insertAdjacentHTML('beforeend', renderRow(rec));
  // Auto-scroll only if user is near bottom
  const nearBottom = (content.scrollTop + content.clientHeight) > (content.scrollHeight - 50);
  if (nearBottom) content.scrollTop = content.scrollHeight;
  // Trim DOM
  const rows = content.querySelectorAll('.log-row');
  if (rows.length > MAX_RENDERED) {
    for (let i = 0; i < rows.length - MAX_RENDERED; i++) rows[i].remove();
  }
}

function renderRow(rec) {
  const ts = new Date(rec.ts);
  const tsStr = `${pad(ts.getHours())}:${pad(ts.getMinutes())}:${pad(ts.getSeconds())}`;
  const ctxStr = rec.ctx ? esc(safeStringify(rec.ctx)) : '';
  return `
    <div class="log-row level-${esc(rec.level || 'info')}">
      <span class="log-ts">${tsStr}</span>
      <span class="log-source" title="${esc(rec.source)}">${esc(rec.source)}</span>
      <span class="log-msg" title="${esc(rec.message)}">${esc(rec.message)}</span>
      ${ctxStr ? `<span class="log-ctx">${ctxStr}</span>` : ''}
    </div>
  `;
}

function pad(n) { return String(n).padStart(2, '0'); }
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
function safeStringify(v) { try { return JSON.stringify(v); } catch { return String(v); } }
