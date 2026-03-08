// ── Pane Assignment — map sessions to panes ─────────────

import { state } from '../state.js';
import { events } from '../events.js';

export function initPaneAssignment() {
  // When layout changes, re-validate pane assignments
  events.on('layout:changed', (layout) => {
    const maxPanes = layoutPaneCount(layout);
    // Clear assignments for panes that no longer exist
    for (let i = maxPanes; i < 4; i++) {
      if (state.paneAssignments[i]) {
        state.paneAssignments[i] = null;
      }
    }
  });

  // Session deleted -> remove from pane assignments
  events.on('session:deleted', (sessionId) => {
    for (let i = 0; i < state.paneAssignments.length; i++) {
      if (state.paneAssignments[i] === sessionId) {
        state.paneAssignments[i] = null;
      }
    }
  });
}

function layoutPaneCount(layout) {
  switch (layout) {
    case 'single': return 1;
    case 'split': return 2;
    case 'triple': return 3;
    case 'quad': return 4;
    default: return 1;
  }
}

export function assignSessionToFirstEmptyPane(sessionId) {
  const maxPanes = layoutPaneCount(state.layout);
  for (let i = 0; i < maxPanes; i++) {
    if (!state.paneAssignments[i]) {
      state.paneAssignments[i] = sessionId;
      events.emit('session:assignToPane', { sessionId, paneIndex: i });
      return i;
    }
  }
  // All panes full, assign to focused pane
  const idx = state.focusedPaneIndex;
  state.paneAssignments[idx] = sessionId;
  events.emit('session:assignToPane', { sessionId, paneIndex: idx });
  return idx;
}
