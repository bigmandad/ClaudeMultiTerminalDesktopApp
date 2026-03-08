// ── Terminal Manager — Manages all terminal panes ─────────

import { TerminalPane } from './terminal-pane.js';
import { state } from '../state.js';
import { events } from '../events.js';

class TerminalManagerClass {
  constructor() {
    this.panes = [];    // TerminalPane instances
    this.gridEl = null;
  }

  init() {
    this.gridEl = document.getElementById('terminal-grid');

    // Create initial pane
    this._createPane(0);

    // Listen for layout changes
    events.on('layout:changed', (layout) => this._applyLayout(layout));
    events.on('pane:requestFocus', (index) => this._focusPane(index));

    // Refresh all session selector dropdowns when sessions change
    events.on('session:added', () => this._refreshAllSessionSelects());
    events.on('session:removed', () => this._refreshAllSessionSelects());
    events.on('session:updated', () => this._refreshAllSessionSelects());

    return this;
  }

  _createPane(index) {
    // Check if pane element already exists
    let paneEl = document.getElementById(`pane-${index}`);

    if (!paneEl) {
      paneEl = this._buildPaneElement(index);
      this.gridEl.appendChild(paneEl);
    }

    const isCompact = state.getPaneCount() >= 3;
    const pane = new TerminalPane(index, paneEl);
    pane.init(isCompact);

    if (index < this.panes.length) {
      if (this.panes[index]) this.panes[index].dispose();
      this.panes[index] = pane;
    } else {
      this.panes.push(pane);
    }

    return pane;
  }

  _buildPaneElement(index) {
    const paneEl = document.createElement('div');
    paneEl.className = 'terminal-pane';
    paneEl.id = `pane-${index}`;
    paneEl.innerHTML = `
      <div class="pane-header">
        <div class="pane-info">
          <span class="pane-status-dot"></span>
          <select class="pane-session-select" title="Choose session for this pane">
            <option value="">No Session</option>
          </select>
          <span class="pane-mode-badge"></span>
        </div>
        <div class="pane-controls">
          <select class="pane-mode-select">
            <option value="ask">ASK</option>
            <option value="auto">AUTO</option>
            <option value="plan">PLAN</option>
            <option value="bypass">BYPASS</option>
          </select>
          <label class="skip-perms-toggle" title="Skip Permissions">
            <input type="checkbox" class="skip-perms-check">
            <span class="skip-perms-label">SKIP PERMS</span>
          </label>
          <button class="pane-btn relay-btn" title="Relay to group">&#8594;</button>
          <button class="pane-btn journal-btn" title="Journal">&#128203;</button>
          <button class="pane-btn diff-btn" title="Diff stats"></button>
        </div>
      </div>
      <div class="pane-warning hidden">&#9888; Dangerously skip permissions is ON</div>
      <div class="pane-group-banner hidden"></div>
      <div class="pane-context-bar hidden">
        <div class="context-bar-fill"></div>
      </div>
      <div class="terminal-container"></div>
      <div class="pane-input-bar">
        <button class="input-btn attach-btn" title="Add Reference">+</button>
        <div class="attachment-pills"></div>
        <input type="text" class="pane-input" placeholder="Type a message...">
        <button class="input-btn plugin-btn" title="Plugins">&#10033;</button>
        <button class="input-btn mic-btn" title="Speech to Text">&#127908;</button>
        <button class="input-btn send-btn" title="Send (Ctrl+Enter)">&#10148;</button>
      </div>
    `;
    return paneEl;
  }

  _applyLayout(layout) {
    // Update grid class
    this.gridEl.className = `layout-${layout}`;
    this.gridEl.id = 'terminal-grid';

    const neededPanes = state.getPaneCount();

    // Create additional panes if needed
    while (this.panes.length < neededPanes) {
      this._createPane(this.panes.length);
    }

    // Show/hide panes based on layout
    for (let i = 0; i < this.panes.length; i++) {
      const paneEl = document.getElementById(`pane-${i}`);
      if (paneEl) {
        paneEl.style.display = i < neededPanes ? '' : 'none';
      }
    }

    // Add placeholder for triple layout
    this._removeAddPanePlaceholder();
    if (layout === 'triple') {
      this._addAddPanePlaceholder();
    }

    // Refit all visible terminals
    setTimeout(() => {
      for (let i = 0; i < neededPanes; i++) {
        if (this.panes[i] && this.panes[i].fitAddon) {
          this.panes[i].fitAddon.fit();
        }
      }
    }, 50);
  }

  _addAddPanePlaceholder() {
    const placeholder = document.createElement('div');
    placeholder.className = 'add-pane-placeholder';
    placeholder.id = 'add-pane-placeholder';
    placeholder.innerHTML = `
      <div class="add-pane-content">
        <span class="add-pane-icon">+</span>
        <span class="add-pane-text">Add pane</span>
      </div>
    `;
    placeholder.addEventListener('click', () => {
      state.setLayout('quad');
    });
    this.gridEl.appendChild(placeholder);
  }

  _removeAddPanePlaceholder() {
    const placeholder = document.getElementById('add-pane-placeholder');
    if (placeholder) placeholder.remove();
  }

  _focusPane(index) {
    for (let i = 0; i < this.panes.length; i++) {
      if (i === index) {
        this.panes[i].focus();
      } else {
        this.panes[i].blur();
      }
    }
    state.setFocusedPane(index);
  }

  getPane(index) {
    return this.panes[index];
  }

  getActivePane() {
    return this.panes[state.focusedPaneIndex];
  }

  _refreshAllSessionSelects() {
    for (const pane of this.panes) {
      if (pane) {
        pane.refreshSessionSelect();
      }
    }
  }

  attachSessionToPane(paneIndex, sessionId) {
    console.log('[TerminalManager] attachSessionToPane pane=' + paneIndex, 'session=' + sessionId);
    console.log('[TerminalManager] total panes:', this.panes.length);
    const pane = this.panes[paneIndex];
    if (pane) {
      console.log('[TerminalManager] pane found, has terminal:', !!pane.terminal);
      pane.attachSession(sessionId);
      state.assignPane(paneIndex, sessionId);

      const session = state.getSession(sessionId);
      if (session) {
        pane.updateHeader(session);
        console.log('[TerminalManager] header updated for:', session.name);
      } else {
        console.warn('[TerminalManager] session not found in state:', sessionId);
      }
    } else {
      console.error('[TerminalManager] NO PANE at index', paneIndex, '— panes array:', this.panes.map((p,i) => i));
    }
  }
}

export const terminalManager = new TerminalManagerClass();
