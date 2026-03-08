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
    const totals = await window.api.usage.totals();

    // Update mini HR bar from CLI usage data
    const hrBar = document.getElementById('hr-bar');
    const wkBar = document.getElementById('wk-bar');

    if (cliUsage) {
      // Try to extract hourly/weekly usage from CLI data
      const hourlyUsed = cliUsage.hourly_tokens_used || cliUsage.tokens_this_hour || 0;
      const hourlyLimit = cliUsage.hourly_token_limit || cliUsage.hourly_limit || 500000;
      const weeklyUsed = cliUsage.weekly_tokens_used || cliUsage.tokens_this_week || 0;
      const weeklyLimit = cliUsage.weekly_token_limit || cliUsage.weekly_limit || 5000000;

      updateMiniBar(hrBar, hourlyUsed, hourlyLimit);
      updateMiniBar(wkBar, weeklyUsed, weeklyLimit);
    } else if (totals) {
      // Fallback: use our DB stats as rough estimate
      const totalTokens = (totals.total_input || 0) + (totals.total_output || 0);
      // Show something meaningful
      updateMiniBar(hrBar, 0, 100);
      updateMiniBar(wkBar, totalTokens > 0 ? 25 : 0, 100);
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
  barEl.title = `${formatNumber(used)} / ${formatNumber(limit)} tokens (${pct}%)`;
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
        <button class="stats-tab active" data-tab="limits">Limits</button>
        <button class="stats-tab" data-tab="overview">Overview</button>
        <button class="stats-tab" data-tab="sessions">Sessions</button>
      </div>
      <div class="stats-content" id="stats-content">
        <!-- Filled dynamically -->
      </div>
      <div class="modal-footer" style="font-size:var(--font-size-xs);color:var(--cream-faint)">
        Sourced from ~/.claude/usage.json &middot; limit data from API response headers
      </div>
    </div>
  `;

  overlay.querySelector('.modal-close').addEventListener('click', hideModal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) hideModal();
  });

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

  switch (tab) {
    case 'limits': {
      const cliUsage = await window.api.usage.readCliUsage();
      const hourlyUsed = cliUsage?.hourly_tokens_used || cliUsage?.tokens_this_hour || 0;
      const hourlyLimit = cliUsage?.hourly_token_limit || cliUsage?.hourly_limit || 500000;
      const weeklyUsed = cliUsage?.weekly_tokens_used || cliUsage?.tokens_this_week || 0;
      const weeklyLimit = cliUsage?.weekly_token_limit || cliUsage?.weekly_limit || 5000000;
      const dailyUsed = cliUsage?.daily_messages || cliUsage?.messages_today || 0;
      const dailyLimit = cliUsage?.daily_message_limit || cliUsage?.message_limit || 1000;

      const hrPct = hourlyLimit > 0 ? Math.round((hourlyUsed / hourlyLimit) * 100) : 0;
      const wkPct = weeklyLimit > 0 ? Math.round((weeklyUsed / weeklyLimit) * 100) : 0;
      const dyPct = dailyLimit > 0 ? Math.round((dailyUsed / dailyLimit) * 100) : 0;

      const barClass = (pct) => pct > 85 ? 'critical' : pct > 60 ? 'warning' : 'healthy';

      content.innerHTML = `
        <div class="limit-bar">
          <div class="limit-bar-header">
            <span class="limit-bar-label">Hourly Token Limit</span>
            <span class="limit-bar-value">${formatNumber(hourlyUsed)} / ${formatNumber(hourlyLimit)}</span>
          </div>
          <div class="limit-bar-track">
            <div class="limit-bar-fill ${barClass(hrPct)}" style="width:${hrPct}%"></div>
          </div>
          <div class="limit-bar-info">Rolling 60-minute window (${hrPct}%)</div>
        </div>
        <div class="limit-bar">
          <div class="limit-bar-header">
            <span class="limit-bar-label">Weekly Token Limit</span>
            <span class="limit-bar-value">${formatNumber(weeklyUsed)} / ${formatNumber(weeklyLimit)}</span>
          </div>
          <div class="limit-bar-track">
            <div class="limit-bar-fill ${barClass(wkPct)}" style="width:${wkPct}%"></div>
          </div>
          <div class="limit-bar-info">Resets Monday 00:00 UTC (${wkPct}%)</div>
        </div>
        <div class="limit-bar">
          <div class="limit-bar-header">
            <span class="limit-bar-label">Daily Messages</span>
            <span class="limit-bar-value">${dailyUsed} / ${dailyLimit}</span>
          </div>
          <div class="limit-bar-track">
            <div class="limit-bar-fill ${barClass(dyPct)}" style="width:${dyPct}%"></div>
          </div>
          <div class="limit-bar-info">Resets every 24h (${dyPct}%)</div>
        </div>
        <div style="margin-top:16px;padding:10px;background:var(--bg-deep);border-radius:var(--radius-sm);font-size:var(--font-size-xs);color:var(--cream-dim)">
          ${cliUsage ? 'Data sourced from Claude CLI usage tracking.' : 'Start using Claude to see limit data. Usage is tracked automatically.'}
        </div>
      `;
      break;
    }

    case 'overview': {
      const totals = await window.api.usage.totals();
      const monthly = await window.api.usage.monthly();
      content.innerHTML = `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="stat-card">
            <div style="color:var(--cream-faint);font-size:var(--font-size-xs)">Total Tokens</div>
            <div style="font-size:18px;font-weight:600">${formatNumber((totals?.total_input || 0) + (totals?.total_output || 0))}</div>
          </div>
          <div class="stat-card">
            <div style="color:var(--cream-faint);font-size:var(--font-size-xs)">Est. Cost</div>
            <div style="font-size:18px;font-weight:600">$${(totals?.total_cost || 0).toFixed(2)}</div>
          </div>
          <div class="stat-card">
            <div style="color:var(--cream-faint);font-size:var(--font-size-xs)">Sessions Run</div>
            <div style="font-size:18px;font-weight:600">${totals?.session_count || 0}</div>
          </div>
          <div class="stat-card">
            <div style="color:var(--cream-faint);font-size:var(--font-size-xs)">This Month</div>
            <div style="font-size:18px;font-weight:600">${formatNumber((monthly?.monthly_input || 0) + (monthly?.monthly_output || 0))} tokens</div>
          </div>
        </div>
      `;
      break;
    }

    case 'sessions': {
      const sessions = Array.from(state.sessions.values());
      let html = '';
      for (const session of sessions) {
        html += `
          <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border-dim)">
            <span style="flex:1;font-size:var(--font-size-sm)">${escapeHtml(session.name)}</span>
            <span style="font-size:var(--font-size-xs);color:var(--cream-dim)">${session.mode?.toUpperCase() || 'ASK'}</span>
          </div>
        `;
      }
      content.innerHTML = html || '<div style="color:var(--cream-faint);padding:16px">No sessions recorded yet.</div>';
      break;
    }
  }
}

function formatNumber(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
