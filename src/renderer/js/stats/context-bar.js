// ── Context Bar — /compact detection, context usage ───────

import { events } from '../events.js';

const COMPACT_PATTERN = /context window is (\d+)% full|\/compact/i;
const CONTEXT_PATTERN = /(\d+(?:\.\d+)?)[kK]\s*tokens?\s*used/i;

export function initContextBar() {
  // Parse terminal output for context usage hints
  events.on('pty:outputParsed', ({ sessionId, data }) => {
    const compactMatch = data.match(COMPACT_PATTERN);
    if (compactMatch) {
      const percent = parseInt(compactMatch[1]) || 80;
      events.emit('context:usage', { sessionId, percent });
    }

    const usageMatch = data.match(CONTEXT_PATTERN);
    if (usageMatch) {
      events.emit('context:tokens', { sessionId, tokensK: parseFloat(usageMatch[1]) });
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
}
