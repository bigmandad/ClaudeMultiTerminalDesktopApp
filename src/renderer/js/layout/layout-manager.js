// ── Layout Manager — Grid layout switching ────────────────

import { state } from '../state.js';
import { events } from '../events.js';

export function initLayoutManager() {
  // Layout buttons in icon rail
  const layoutBtns = document.querySelectorAll('.layout-btn');
  layoutBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const layout = btn.dataset.layout;
      state.setLayout(layout);
      updateLayoutButtons(layout);
    });
  });

  // Keyboard shortcuts: Ctrl+L to cycle layouts
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'l') {
      e.preventDefault();
      const layouts = ['single', 'split', 'triple', 'quad'];
      const currentIndex = layouts.indexOf(state.layout);
      const nextLayout = layouts[(currentIndex + 1) % layouts.length];
      state.setLayout(nextLayout);
      updateLayoutButtons(nextLayout);
    }
  });
}

function updateLayoutButtons(activeLayout) {
  document.querySelectorAll('.layout-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.layout === activeLayout);
  });
}
