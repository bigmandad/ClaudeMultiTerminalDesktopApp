// ── Terminal Pane — Single xterm instance wired to PTY ────

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { terminalTheme } from './terminal-theme.js';
import { state } from '../state.js';
import { events } from '../events.js';

export class TerminalPane {
  constructor(paneIndex, containerEl) {
    this.paneIndex = paneIndex;
    this.containerEl = containerEl;
    this.terminalContainer = containerEl.querySelector('.terminal-container');
    this.inputEl = containerEl.querySelector('.pane-input');
    this.sessionId = null;
    this.terminal = null;
    this.fitAddon = null;
    this.cleanupPtyData = null;
    this.cleanupPtyExit = null;
    this.resizeObserver = null;
    this.isCompact = false;

    this._setupInput();
    this._setupPaneControls();
  }

  init(compact = false) {
    console.log('[TerminalPane] init pane=' + this.paneIndex, 'compact=' + compact);
    this.isCompact = compact;

    try {
      this.terminal = new Terminal({
        theme: terminalTheme,
        fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Consolas', monospace",
        fontSize: compact ? 11 : 13,
        lineHeight: 1.2,
        cursorStyle: 'bar',
        cursorBlink: true,
        scrollback: 10000,
        allowProposedApi: true,
        convertEol: true
      });
      console.log('[TerminalPane] xterm Terminal created for pane ' + this.paneIndex);

      this.fitAddon = new FitAddon();
      this.terminal.loadAddon(this.fitAddon);
      this.terminal.loadAddon(new WebLinksAddon((e, uri) => {
        window.api.shell.openExternal(uri);
      }));

      this.terminal.open(this.terminalContainer);
      console.log('[TerminalPane] terminal opened in container, container size:',
        this.terminalContainer.offsetWidth + 'x' + this.terminalContainer.offsetHeight);
      this.fitAddon.fit();
      console.log('[TerminalPane] terminal fit: cols=' + this.terminal.cols + ' rows=' + this.terminal.rows);
    } catch (err) {
      console.error('[TerminalPane] INIT ERROR for pane ' + this.paneIndex + ':', err);
    }

    // Resize observer
    this.resizeObserver = new ResizeObserver(() => {
      if (this.fitAddon && this.terminal) {
        try {
          this.fitAddon.fit();
          if (this.sessionId) {
            window.api.pty.resize(this.sessionId, this.terminal.cols, this.terminal.rows);
          }
        } catch (e) { /* ignore */ }
      }
    });
    this.resizeObserver.observe(this.terminalContainer);

    // Terminal data -> PTY stdin (for direct typing in terminal)
    this.terminal.onData((data) => {
      if (this.sessionId) {
        window.api.pty.write(this.sessionId, data);
      }
    });

    return this;
  }

  attachSession(sessionId) {
    console.log('[TerminalPane] attachSession pane=' + this.paneIndex, 'session=' + sessionId);
    // Detach previous
    this.detachSession();

    this.sessionId = sessionId;

    // Listen for PTY data for this session
    let dataCount = 0;
    this.cleanupPtyData = window.api.pty.onData((id, data) => {
      if (id === this.sessionId && this.terminal) {
        dataCount++;
        if (dataCount <= 5) {
          console.log('[TerminalPane] pty:data #' + dataCount, 'session=' + id, 'bytes=' + data.length);
        }
        this.terminal.write(data);
      }
    });

    this.cleanupPtyExit = window.api.pty.onExit((id, exitCode) => {
      if (id === this.sessionId && this.terminal) {
        console.log('[TerminalPane] pty:exit session=' + id, 'code=' + exitCode);
        this.terminal.write(`\r\n\x1b[33m[Process exited with code ${exitCode}]\x1b[0m\r\n`);
        events.emit('session:exited', { id, exitCode });
      }
    });

    // Resize PTY to match terminal
    if (this.terminal) {
      console.log('[TerminalPane] resizing PTY to', this.terminal.cols, 'x', this.terminal.rows);
      window.api.pty.resize(sessionId, this.terminal.cols, this.terminal.rows);
    } else {
      console.error('[TerminalPane] NO TERMINAL INSTANCE — xterm not initialized!');
    }
  }

  detachSession() {
    if (this.cleanupPtyData) {
      this.cleanupPtyData();
      this.cleanupPtyData = null;
    }
    if (this.cleanupPtyExit) {
      this.cleanupPtyExit();
      this.cleanupPtyExit = null;
    }
    this.sessionId = null;
  }

  sendInput(text) {
    console.log('[TerminalPane] sendInput pane=' + this.paneIndex, 'sessionId=' + this.sessionId, 'text=' + text.slice(0, 50));
    if (!this.sessionId) {
      console.warn('[TerminalPane] sendInput BLOCKED — no session attached to pane', this.paneIndex);
      return;
    }
    if (text.trim()) {
      window.api.pty.write(this.sessionId, text + '\r');
      // Also focus the terminal so user can see the response
      if (this.terminal) this.terminal.focus();
    }
  }

  focus() {
    if (this.terminal) {
      this.terminal.focus();
    }
    this.containerEl.classList.add('focused');
  }

  blur() {
    this.containerEl.classList.remove('focused');
  }

  clear() {
    if (this.terminal) {
      this.terminal.clear();
    }
  }

  dispose() {
    this.detachSession();
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
    if (this.terminal) {
      this.terminal.dispose();
    }
  }

  updateHeader(session) {
    if (!session) return;

    const dotEl = this.containerEl.querySelector('.pane-status-dot');
    const badgeEl = this.containerEl.querySelector('.pane-mode-badge');
    const modeSelect = this.containerEl.querySelector('.pane-mode-select');
    const skipCheck = this.containerEl.querySelector('.skip-perms-check');
    const warningEl = this.containerEl.querySelector('.pane-warning');
    const sessionSelect = this.containerEl.querySelector('.pane-session-select');

    // Update session selector to reflect the current session
    if (sessionSelect) {
      this.refreshSessionSelect();
      sessionSelect.value = session.id;
    }

    if (dotEl) {
      dotEl.className = 'pane-status-dot';
      if (session.status === 'active') dotEl.classList.add('active');
      else if (session.status === 'waiting') dotEl.classList.add('waiting');
    }
    if (badgeEl) {
      badgeEl.textContent = (session.mode || 'ask').toUpperCase();
      badgeEl.className = `pane-mode-badge mode-badge ${session.mode || 'ask'}`;
    }
    if (modeSelect) modeSelect.value = session.mode || 'ask';
    if (skipCheck) skipCheck.checked = session.skipPerms || false;
    if (warningEl) {
      warningEl.classList.toggle('hidden', !session.skipPerms);
    }
  }

  /** Populate the session selector dropdown with all available sessions */
  refreshSessionSelect() {
    const selectEl = this.containerEl.querySelector('.pane-session-select');
    if (!selectEl) return;

    const currentValue = selectEl.value;

    // Clear and rebuild options
    selectEl.innerHTML = '<option value="">No Session</option>';

    for (const [id, session] of state.sessions) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = session.name || id;
      // Add status indicator
      if (session.status === 'active') {
        opt.textContent = '● ' + opt.textContent;
      } else if (session.status === 'stopped') {
        opt.textContent = '○ ' + opt.textContent;
      }
      selectEl.appendChild(opt);
    }

    // Restore current selection (either sessionId or previous value)
    if (this.sessionId) {
      selectEl.value = this.sessionId;
    } else if (currentValue) {
      selectEl.value = currentValue;
    }
  }

  _setupInput() {
    if (!this.inputEl) return;

    // Tab key prevention
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        return;
      }

      // Ctrl+Enter or Enter to send
      if (e.key === 'Enter' && (e.ctrlKey || !e.shiftKey)) {
        e.preventDefault();
        const text = this.inputEl.value;
        if (text.trim()) {
          this.sendInput(text);
          this.inputEl.value = '';
        }
      }
    });

    // Send button
    const sendBtn = this.containerEl.querySelector('.send-btn');
    if (sendBtn) {
      sendBtn.addEventListener('click', () => {
        const text = this.inputEl.value;
        if (text.trim()) {
          this.sendInput(text);
          this.inputEl.value = '';
        }
      });
    }
  }

  _setupPaneControls() {
    // Session selector — choose which session this pane shows
    const sessionSelect = this.containerEl.querySelector('.pane-session-select');
    if (sessionSelect) {
      sessionSelect.addEventListener('change', () => {
        const newSessionId = sessionSelect.value;
        console.log('[TerminalPane] session selector changed pane=' + this.paneIndex, 'newSession=' + newSessionId);

        if (newSessionId) {
          // Attach the selected session to this pane
          events.emit('session:assignToPane', { sessionId: newSessionId, paneIndex: this.paneIndex });
        } else {
          // "No Session" selected — detach
          this.detachSession();
          // Clear the terminal display
          if (this.terminal) this.terminal.clear();
          // Clear the header
          const dotEl = this.containerEl.querySelector('.pane-status-dot');
          const badgeEl = this.containerEl.querySelector('.pane-mode-badge');
          if (dotEl) dotEl.className = 'pane-status-dot';
          if (badgeEl) { badgeEl.textContent = ''; badgeEl.className = 'pane-mode-badge'; }
          state.assignPane(this.paneIndex, null);
        }
      });
    }

    // Mode selector
    const modeSelect = this.containerEl.querySelector('.pane-mode-select');
    if (modeSelect) {
      modeSelect.addEventListener('change', () => {
        events.emit('pane:modeChanged', {
          paneIndex: this.paneIndex,
          sessionId: this.sessionId,
          mode: modeSelect.value
        });
      });
    }

    // Skip perms toggle
    const skipCheck = this.containerEl.querySelector('.skip-perms-check');
    if (skipCheck) {
      skipCheck.addEventListener('change', () => {
        const warningEl = this.containerEl.querySelector('.pane-warning');
        if (warningEl) warningEl.classList.toggle('hidden', !skipCheck.checked);
        events.emit('pane:skipPermsChanged', {
          paneIndex: this.paneIndex,
          sessionId: this.sessionId,
          skipPerms: skipCheck.checked
        });
      });
    }

    // Focus on click
    this.containerEl.addEventListener('mousedown', () => {
      events.emit('pane:requestFocus', this.paneIndex);
    });
  }
}
