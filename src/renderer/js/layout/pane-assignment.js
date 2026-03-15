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

  // Session removed -> remove from pane assignments
  events.on('session:removed', ({ id }) => {
    for (let i = 0; i < state.paneAssignments.length; i++) {
      if (state.paneAssignments[i] === id) {
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

