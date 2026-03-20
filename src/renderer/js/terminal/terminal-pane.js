// ── Terminal Pane — Single xterm instance wired to PTY ────

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { SearchAddon } from '@xterm/addon-search';
import { terminalTheme } from './terminal-theme.js';
import { state } from '../state.js';
import { events } from '../events.js';
import { getAttachments, formatAttachmentsForInput } from '../attachments/attachment-popover.js';

export class TerminalPane {
  constructor(paneIndex, containerEl) {
    this.paneIndex = paneIndex;
    this.containerEl = containerEl;
    this.terminalContainer = containerEl.querySelector('.terminal-container');
    this.inputEl = containerEl.querySelector('.pane-input');
    this.sessionId = null;
    this.terminal = null;
    this.fitAddon = null;
    this.searchAddon = null;
    this.searchBarEl = null;
    this.cleanupPtyData = null;
    this.cleanupPtyExit = null;
    this.resizeObserver = null;
    this.isCompact = false;

    this._setupInput();
    this._setupPaneControls();
    this._setupDragDrop();
    this._setupSearch();
  }

  init(compact = false) {
    console.log('[TerminalPane] init pane=' + this.paneIndex, 'compact=' + compact);
    this.isCompact = compact;

    try {
      this.terminal = new Terminal({
        theme: terminalTheme,
        fontFamily: "'Fira Code', 'Cascadia Code', 'Consolas', monospace",
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

      // Search addon (Ctrl+F to search terminal output)
      this.searchAddon = new SearchAddon();
      this.terminal.loadAddon(this.searchAddon);

      this.terminal.open(this.terminalContainer);
      console.log('[TerminalPane] terminal opened in container, container size:',
        this.terminalContainer.offsetWidth + 'x' + this.terminalContainer.offsetHeight);

      // Try WebGL renderer for up to 900% faster rendering (with canvas fallback)
      try {
        const webglAddon = new WebglAddon();
        webglAddon.onContextLoss(() => {
          console.warn('[TerminalPane] WebGL context lost, falling back to canvas');
          webglAddon.dispose();
        });
        this.terminal.loadAddon(webglAddon);
        console.log('[TerminalPane] WebGL renderer loaded');
      } catch (webglErr) {
        console.warn('[TerminalPane] WebGL not available, using default renderer:', webglErr.message);
      }

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

    // Store sessionId on DOM element for diff-viewer and other features
    this.containerEl.dataset.sessionId = sessionId;

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
    delete this.containerEl.dataset.sessionId;
  }

  sendInput(text) {
    console.log('[TerminalPane] sendInput pane=' + this.paneIndex, 'sessionId=' + this.sessionId, 'text=' + text.slice(0, 50));
    if (!this.sessionId) {
      console.warn('[TerminalPane] sendInput BLOCKED — no session attached to pane', this.paneIndex);
      return;
    }
    if (text.trim()) {
      // Collect any file attachments and prepend as @path references
      const attachments = getAttachments(this.containerEl);
      let fullMessage = text;
      if (attachments.length > 0) {
        const attachmentRefs = formatAttachmentsForInput(attachments);
        fullMessage = attachmentRefs + ' ' + text;
        // Clear attachment pills after sending
        const pillsContainer = this.containerEl.querySelector('.attachment-pills');
        if (pillsContainer) pillsContainer.innerHTML = '';
      }

      // For multiline messages, use bracketed paste so the PTY receives it correctly
      const isMultiline = fullMessage.includes('\n');
      if (isMultiline) {
        window.api.pty.write(this.sessionId, '\x1b[200~' + fullMessage + '\x1b[201~' + '\r');
      } else {
        window.api.pty.write(this.sessionId, fullMessage + '\r');
      }
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

    // Auto-resize textarea as content changes
    const autoResize = () => {
      this.inputEl.style.height = 'auto';
      const newHeight = Math.min(this.inputEl.scrollHeight, 120);
      this.inputEl.style.height = newHeight + 'px';
    };

    // Reset textarea to single line
    const resetInput = () => {
      this.inputEl.value = '';
      this.inputEl.style.height = '';
    };

    this.inputEl.addEventListener('input', autoResize);

    // Tab key prevention + Enter/Shift+Enter handling
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        return;
      }

      // Shift+Enter → insert newline (default textarea behavior, just allow it)
      if (e.key === 'Enter' && e.shiftKey) {
        // Let the default behavior add a newline
        // Auto-resize will fire on the 'input' event
        return;
      }

      // Enter or Ctrl+Enter → send message
      if (e.key === 'Enter') {
        e.preventDefault();
        const text = this.inputEl.value;
        if (text.trim()) {
          this.sendInput(text);
          resetInput();
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
          resetInput();
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

    // Journal button — show transcript viewer
    const journalBtn = this.containerEl.querySelector('.journal-btn');
    if (journalBtn) {
      journalBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!this.sessionId) return;

        // Toggle: if already open, close it
        const existing = this.containerEl.querySelector('.journal-overlay');
        if (existing) {
          existing.remove();
          return;
        }

        await this._showJournal();
      });
    }

    // Focus on click
    this.containerEl.addEventListener('mousedown', () => {
      events.emit('pane:requestFocus', this.paneIndex);
    });
  }

  /** Show journal/transcript overlay for the current session */
  async _showJournal() {
    const overlay = document.createElement('div');
    overlay.className = 'journal-overlay';
    overlay.innerHTML = `
      <div class="journal-header">
        <span>Session Journal</span>
        <div style="display:flex;gap:6px;align-items:center">
          <select class="journal-date-select"></select>
          <button class="btn btn-secondary journal-close-btn" style="padding:2px 8px;font-size:var(--font-size-xs)">Close</button>
        </div>
      </div>
      <div class="journal-content">
        <div class="journal-output">Loading transcripts...</div>
      </div>
    `;

    overlay.querySelector('.journal-close-btn').addEventListener('click', () => overlay.remove());

    const dateSelect = overlay.querySelector('.journal-date-select');
    const outputEl = overlay.querySelector('.journal-output');

    this.containerEl.appendChild(overlay);

    try {
      const transcripts = await window.api.transcript.list(this.sessionId);

      if (!transcripts || transcripts.length === 0) {
        outputEl.textContent = 'No transcripts found for this session.';
        return;
      }

      // Populate date selector
      for (const filename of transcripts) {
        const date = filename.replace('.md', '');
        const opt = document.createElement('option');
        opt.value = date;
        opt.textContent = date;
        dateSelect.appendChild(opt);
      }

      // Load first (most recent) transcript
      const loadTranscript = async (date) => {
        outputEl.textContent = 'Loading...';
        try {
          const result = await window.api.transcript.read(this.sessionId, date);
          if (result.error) {
            outputEl.textContent = 'Error: ' + result.error;
          } else {
            outputEl.textContent = result.content || 'Empty transcript.';
          }
        } catch (err) {
          outputEl.textContent = 'Error loading transcript: ' + err.message;
        }
      };

      dateSelect.addEventListener('change', () => loadTranscript(dateSelect.value));
      await loadTranscript(transcripts[0].replace('.md', ''));
    } catch (err) {
      outputEl.textContent = 'Error: ' + err.message;
    }
  }

  /** Set up Ctrl+F search bar for terminal output */
  _setupSearch() {
    // Listen for Ctrl+F globally (will be triggered when this pane has focus)
    this.containerEl.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        e.stopPropagation();
        this._showSearchBar();
      }
    });
  }

  _showSearchBar() {
    // If already open, focus it
    if (this.searchBarEl) {
      const input = this.searchBarEl.querySelector('.term-search-input');
      if (input) input.focus();
      return;
    }

    const bar = document.createElement('div');
    bar.className = 'term-search-bar';
    bar.innerHTML = `
      <input type="text" class="term-search-input" placeholder="Search terminal..." spellcheck="false">
      <span class="term-search-count"></span>
      <button class="term-search-btn term-search-prev" title="Previous (Shift+Enter)">&#9650;</button>
      <button class="term-search-btn term-search-next" title="Next (Enter)">&#9660;</button>
      <button class="term-search-btn term-search-close" title="Close (Escape)">&times;</button>
    `;

    // Insert at top of terminal container
    this.terminalContainer.parentElement.insertBefore(bar, this.terminalContainer);
    this.searchBarEl = bar;

    const input = bar.querySelector('.term-search-input');
    const countEl = bar.querySelector('.term-search-count');
    const closeSearch = () => {
      if (this.searchAddon) this.searchAddon.clearDecorations();
      bar.remove();
      this.searchBarEl = null;
      if (this.terminal) this.terminal.focus();
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeSearch();
      } else if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        if (this.searchAddon && input.value) this.searchAddon.findPrevious(input.value);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (this.searchAddon && input.value) this.searchAddon.findNext(input.value);
      }
    });

    input.addEventListener('input', () => {
      if (!this.searchAddon || !input.value) {
        this.searchAddon?.clearDecorations();
        countEl.textContent = '';
        return;
      }
      this.searchAddon.findNext(input.value);
    });

    bar.querySelector('.term-search-prev').addEventListener('click', () => {
      if (this.searchAddon && input.value) this.searchAddon.findPrevious(input.value);
    });
    bar.querySelector('.term-search-next').addEventListener('click', () => {
      if (this.searchAddon && input.value) this.searchAddon.findNext(input.value);
    });
    bar.querySelector('.term-search-close').addEventListener('click', closeSearch);

    input.focus();
  }

  /** Set up drag-and-drop file attachments on the terminal pane */
  _setupDragDrop() {
    const paneEl = this.containerEl;
    const termContainer = this.terminalContainer;

    // Prevent default browser drag behavior
    paneEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      paneEl.classList.add('drag-over');
      e.dataTransfer.dropEffect = 'copy';
    });

    paneEl.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Only remove if leaving the pane entirely
      if (!paneEl.contains(e.relatedTarget)) {
        paneEl.classList.remove('drag-over');
      }
    });

    paneEl.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      paneEl.classList.remove('drag-over');

      const files = e.dataTransfer.files;
      if (files.length === 0) return;

      const pillsContainer = paneEl.querySelector('.attachment-pills');
      if (!pillsContainer) return;

      for (const file of files) {
        const filePath = file.path; // Electron provides the full path
        if (!filePath) continue;

        const filename = filePath.split(/[\\/]/).pop();

        // Check if already attached
        const existing = pillsContainer.querySelectorAll('.attachment-pill');
        let duplicate = false;
        existing.forEach(p => { if (p.dataset.path === filePath) duplicate = true; });
        if (duplicate) continue;

        const pill = document.createElement('div');
        pill.className = 'attachment-pill';
        pill.dataset.path = filePath;
        pill.title = filePath;
        pill.innerHTML = `
          <span class="attachment-pill-icon">&#128206;</span>
          <span>${escapeHtml(filename)}</span>
          <button class="attachment-pill-remove">&times;</button>
        `;

        pill.querySelector('.attachment-pill-remove').addEventListener('click', () => {
          pill.remove();
        });

        pillsContainer.appendChild(pill);
      }

      // Focus the input so user can type their message
      if (this.inputEl) this.inputEl.focus();
    });
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
