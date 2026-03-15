// ── Context Bar — /compact detection, context usage ───────

import { state } from '../state.js';
import { events } from '../events.js';

const COMPACT_PATTERN = /context window is (\d+)% full|\/compact/i;
const CONTEXT_PATTERN = /(\d+(?:\.\d+)?)[kK]\s*tokens?\s*used/i;

// Track per-session context usage
const sessionContext = new Map();

export function initContextBar() {
  // Parse terminal output for context usage hints
  events.on('pty:outputParsed', ({ sessionId, data }) => {
    const compactMatch = data.match(COMPACT_PATTERN);
    if (compactMatch) {
      const percent = parseInt(compactMatch[1]) || 80;
      sessionContext.set(sessionId, { percent });
      events.emit('context:usage', { sessionId, percent });
    }

    const usageMatch = data.match(CONTEXT_PATTERN);
    if (usageMatch) {
      events.emit('context:tokens', { sessionId, tokensK: parseFloat(usageMatch[1]) });
    }
  });

  // When context:usage fires, find the pane displaying that session and update it
  events.on('context:usage', ({ sessionId, percent }) => {
    for (let i = 0; i < 4; i++) {
      if (state.paneAssignments[i] === sessionId) {
        const paneEl = document.getElementById(`pane-${i}`);
        if (paneEl) updateContextBar(paneEl, percent);
      }
    }
  });

  // When context:tokens fires, estimate context window percentage and update the bar
  // Claude's context window is ~200K tokens
  events.on('context:tokens', ({ sessionId, tokensK }) => {
    const estimatedPercent = Math.round((tokensK / 200) * 100);
    sessionContext.set(sessionId, { percent: estimatedPercent });
    events.emit('context:usage', { sessionId, percent: estimatedPercent });
  });

  // Also detect Claude's "auto-compact" and cost/token summaries
  events.on('pty:outputParsed', ({ sessionId, data }) => {
    // Detect "/compact ran" or "Conversation compacted"
    if (/compacted|auto-compact/i.test(data)) {
      // After compact, context usage resets to low
      sessionContext.set(sessionId, { percent: 15 });
      events.emit('context:usage', { sessionId, percent: 15 });
    }
  });
}

export function updateContextBar(paneEl, percent) {
  const bar = paneEl.querySelector('.pane-context-bar');
  const fill = paneEl.querySelector('.context-bar-fill');
  if (!bar || !fill) return;

  bar.classList.remove('hidden');
  fill.style.width = `${Math.min(100, percent)}%`;
  fill.className = 'context-bar-fill';

  if (percent > 85) fill.classList.add('critical');
  else if (percent > 60) fill.classList.add('warning');

  // Add tooltip showing percentage
  bar.title = `Context window: ${percent}% used`;
}
