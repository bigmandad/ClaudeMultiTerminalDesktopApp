// ── Usage Statistics Modal ────────────────────────────────

import { events } from '../events.js';
import { state } from '../state.js';

let modalEl = null;

export function initUsageModal() {
  events.on('stats:open', () => showModal());

  // Periodically refresh mini limit bars (every 30s)
  refreshLimitBars();
  setInterval(refreshLimitBars, 30000);
}

async function refreshLimitBars() {
  try {
    const cliUsage = await window.api.usage.readCliUsage();
    const hrBar = document.getElementById('hr-bar');
    const wkBar = document.getElementById('wk-bar');

    if (cliUsage && cliUsage.modelUsage) {
      // stats-cache.json format
      const today = new Date().toISOString().slice(0, 10);
      const todayActivity = (cliUsage.dailyActivity || []).find(d => d.date === today);
      const todayMessages = todayActivity?.messageCount || 0;

      // Today's tokens
      const todayTokenEntry = (cliUsage.dailyModelTokens || []).find(d => d.date === today);
      let todayTokens = 0;
      if (todayTokenEntry?.tokensByModel) {
        for (const v of Object.values(todayTokenEntry.tokensByModel)) todayTokens += v;
      }

      // HR bar: today's tokens as rough hourly estimate
      const hoursElapsed = Math.max(1, new Date().getHours() + 1);
      const avgPerHour = todayTokens > 0 ? Math.round(todayTokens / hoursElapsed) : 0;
      updateMiniBar(hrBar, avgPerHour, 500000);
      hrBar.title = `Today: ${formatNumber(todayTokens)} tokens (~${formatNumber(avgPerHour)}/hr)`;

      // WK bar: today's messages
      updateMiniBar(wkBar, todayMessages, Math.max(1000, todayMessages * 1.5));
      wkBar.title = `Today: ${formatNumber(todayMessages)} messages`;
    } else if (cliUsage) {
      const hourlyUsed = cliUsage.hourly_tokens_used || cliUsage.tokens_this_hour || 0;
      const hourlyLimit = cliUsage.hourly_token_limit || cliUsage.hourly_limit || 500000;
      const weeklyUsed = cliUsage.weekly_tokens_used || cliUsage.tokens_this_week || 0;
      const weeklyLimit = cliUsage.weekly_token_limit || cliUsage.weekly_limit || 5000000;
      updateMiniBar(hrBar, hourlyUsed, hourlyLimit);
      updateMiniBar(wkBar, weeklyUsed, weeklyLimit);
    }
  } catch (e) {
    console.log('[UsageModal] refreshLimitBars error:', e.message);
  }
}

function updateMiniBar(barEl, used, limit) {
  if (!barEl) return;
  const fill = barEl.querySelector('.mini-fill');
  if (!fill) return;
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  fill.style.width = pct + '%';
  fill.className = 'mini-fill';
  if (pct > 85) fill.classList.add('critical');
  else if (pct > 60) fill.classList.add('warning');
}

function createModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay stats-modal';
  overlay.id = 'stats-modal';
  overlay.innerHTML = `
    <div class="modal" style="width:560px">
      <div class="modal-header">
        <span>Usage Statistics</span>
        <button class="modal-close">&times;</button>
      </div>
      <div class="stats-tabs">
        <button class="stats-tab active" data-tab="limits">Today</button>
        <button class="stats-tab" data-tab="overview">All Time</button>
        <button class="stats-tab" data-tab="models">Models</button>
        <button class="stats-tab" data-tab="sessions">Sessions</button>
      </div>
      <div class="stats-content" id="stats-content"></div>
      <div class="modal-footer" style="font-size:var(--font-size-xs);color:var(--cream-faint)">
        Sourced from ~/.claude/stats-cache.json
      </div>
    </div>
  `;

  overlay.querySelector('.modal-close').addEventListener('click', hideModal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) hideModal(); });

  overlay.querySelectorAll('.stats-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      overlay.querySelectorAll('.stats-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      renderTab(tab.dataset.tab);
    });
  });

  document.body.appendChild(overlay);
  modalEl = overlay;
  return overlay;
}

function showModal() {
  if (!modalEl) createModal();
  modalEl.classList.remove('hidden');
  renderTab('limits');
}

function hideModal() {
  if (modalEl) modalEl.classList.add('hidden');
}

async function renderTab(tab) {
  const content = document.getElementById('stats-content');
  if (!content) return;

  const cliUsage = await window.api.usage.readCliUsage();

  switch (tab) {
    case 'limits': {
      const today = new Date().toISOString().slice(0, 10);
      const todayActivity = (cliUsage?.dailyActivity || []).find(d => d.date === today);
      const todayMessages = todayActivity?.messageCount || 0;
      const todaySessions = todayActivity?.sessionCount || 0;
      const todayToolCalls = todayActivity?.toolCallCount || 0;

      const todayTokenEntry = (cliUsage?.dailyModelTokens || []).find(d => d.date === today);
      let todayTokens = 0;
      let todayModels = {};
      if (todayTokenEntry?.tokensByModel) {
        todayModels = todayTokenEntry.tokensByModel;
        for (const v of Object.values(todayModels)) todayTokens += v;
      }

      // Sparkline from last 7 days
      const recentDays = (cliUsage?.dailyActivity || []).slice(-7);
      const maxMsg = Math.max(1, ...recentDays.map(d => d.messageCount));
      let sparkHtml = recentDays.map(d => {
        const pct = Math.round((d.messageCount / maxMsg) * 100);
        return `<div class="spark-bar" style="height:${Math.max(4, pct)}%" title="${d.date.slice(5)}: ${formatNumber(d.messageCount)} msgs"></div>`;
      }).join('');

      content.innerHTML = `
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:16px">
          <div class="stat-card"><div style="color:var(--cream-faint);font-size:var(--font-size-xs)">Messages Today</div><div style="font-size:22px;font-weight:600;color:var(--orange)">${formatNumber(todayMessages)}</div></div>
          <div class="stat-card"><div style="color:var(--cream-faint);font-size:var(--font-size-xs)">Tokens Today</div><div style="font-size:22px;font-weight:600;color:var(--blue)">${formatNumber(todayTokens)}</div></div>
          <div class="stat-card"><div style="color:var(--cream-faint);font-size:var(--font-size-xs)">Tool Calls</div><div style="font-size:22px;font-weight:600">${formatNumber(todayToolCalls)}</div></div>
        </div>
        <div style="margin-bottom:16px">
          <div style="font-size:var(--font-size-xs);color:var(--cream-dim);margin-bottom:6px">Last 7 Days Activity</div>
          <div style="display:flex;align-items:flex-end;gap:4px;height:60px;padding:4px 0;border-bottom:1px solid var(--border-dim)">
            ${sparkHtml || '<div style="color:var(--cream-faint);font-size:var(--font-size-xs)">No data yet</div>'}
          </div>
        </div>
        ${todayTokens > 0 ? `
        <div style="font-size:var(--font-size-xs);color:var(--cream-dim);margin-bottom:6px">Today's Models</div>
        ${Object.entries(todayModels).map(([model, tokens]) => `
          <div style="display:flex;justify-content:space-between;padding:4px 0;font-size:var(--font-size-sm)">
            <span style="color:var(--cream)">${model}</span>
            <span style="color:var(--cream-dim)">${formatNumber(tokens)} tokens</span>
          </div>
        `).join('')}` : '<div style="color:var(--cream-faint);font-size:var(--font-size-xs);padding:8px 0">Start a Claude session to see today\'s usage.</div>'}
      `;
      break;
    }
    case 'overview': {
      const totalMessages = cliUsage?.totalMessages || 0;
      const totalSessions = cliUsage?.totalSessions || 0;
      const firstDate = cliUsage?.firstSessionDate ? new Date(cliUsage.firstSessionDate).toLocaleDateString() : 'N/A';
      const longestSession = cliUsage?.longestSession;
      let totalInput = 0, totalOutput = 0, totalCacheRead = 0;
      if (cliUsage?.modelUsage) {
        for (const m of Object.values(cliUsage.modelUsage)) {
          totalInput += m.inputTokens || 0;
          totalOutput += m.outputTokens || 0;
          totalCacheRead += m.cacheReadInputTokens || 0;
        }
      }
      content.innerHTML = `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
          <div class="stat-card"><div style="color:var(--cream-faint);font-size:var(--font-size-xs)">Total Messages</div><div style="font-size:22px;font-weight:600;color:var(--orange)">${formatNumber(totalMessages)}</div></div>
          <div class="stat-card"><div style="color:var(--cream-faint);font-size:var(--font-size-xs)">Total Sessions</div><div style="font-size:22px;font-weight:600">${totalSessions}</div></div>
          <div class="stat-card"><div style="color:var(--cream-faint);font-size:var(--font-size-xs)">Input Tokens</div><div style="font-size:18px;font-weight:600">${formatNumber(totalInput)}</div></div>
          <div class="stat-card"><div style="color:var(--cream-faint);font-size:var(--font-size-xs)">Output Tokens</div><div style="font-size:18px;font-weight:600">${formatNumber(totalOutput)}</div></div>
          <div class="stat-card"><div style="color:var(--cream-faint);font-size:var(--font-size-xs)">Cache Read</div><div style="font-size:18px;font-weight:600">${formatNumber(totalCacheRead)}</div></div>
          <div class="stat-card"><div style="color:var(--cream-faint);font-size:var(--font-size-xs)">Member Since</div><div style="font-size:14px;font-weight:600">${firstDate}</div></div>
        </div>
        ${longestSession ? `<div style="padding:10px;background:var(--bg-deep);border-radius:var(--radius-sm);font-size:var(--font-size-xs);color:var(--cream-dim)">Longest session: ${formatNumber(longestSession.messageCount)} messages over ${formatDuration(longestSession.duration)}</div>` : ''}
      `;
      break;
    }
    case 'models': {
      let html = '';
      if (cliUsage?.modelUsage) {
        for (const [model, data] of Object.entries(cliUsage.modelUsage)) {
          html += `
            <div style="padding:10px;margin-bottom:8px;background:var(--bg-deep);border-radius:var(--radius-sm)">
              <div style="font-weight:600;color:var(--orange);margin-bottom:6px">${model}</div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:var(--font-size-xs)">
                <div><span style="color:var(--cream-faint)">Input:</span> ${formatNumber(data.inputTokens || 0)}</div>
                <div><span style="color:var(--cream-faint)">Output:</span> ${formatNumber(data.outputTokens || 0)}</div>
                <div><span style="color:var(--cream-faint)">Cache Read:</span> ${formatNumber(data.cacheReadInputTokens || 0)}</div>
                <div><span style="color:var(--cream-faint)">Cache Write:</span> ${formatNumber(data.cacheCreationInputTokens || 0)}</div>
              </div>
            </div>`;
        }
      }
      content.innerHTML = html || '<div style="color:var(--cream-faint);padding:16px">No model usage data available.</div>';
      break;
    }
    case 'sessions': {
      const sessions = Array.from(state.sessions.values());
      let html = '';
      for (const s of sessions) {
        html += `
          <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border-dim)">
            <span style="width:6px;height:6px;border-radius:50%;flex-shrink:0;background:${s.status === 'active' ? 'var(--green)' : 'var(--cream-faint)'}"></span>
            <span style="flex:1;font-size:var(--font-size-sm)">${escapeHtml(s.name)}</span>
            <span style="font-size:var(--font-size-xs);color:var(--cream-dim)">${s.mode?.toUpperCase() || 'ASK'}</span>
            ${s.groupId ? '<span style="font-size:var(--font-size-xs);color:var(--orange)">GROUP</span>' : ''}
          </div>`;
      }
      content.innerHTML = html || '<div style="color:var(--cream-faint);padding:16px">No active sessions.</div>';
      break;
    }
  }
}

function formatNumber(n) {
  if (n >= 1000000000) return (n / 1000000000).toFixed(1) + 'B';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

function formatDuration(ms) {
  if (!ms) return 'N/A';
  const hours = Math.floor(ms / 3600000);
  const mins = Math.floor((ms % 3600000) / 60000);
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
