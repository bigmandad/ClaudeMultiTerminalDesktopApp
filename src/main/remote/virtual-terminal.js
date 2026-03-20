// ── Virtual Terminal Buffer ─────────────────────────────────
// Lightweight terminal emulator that maintains a 2D screen buffer.
// Processes raw PTY data (with ANSI escape sequences) and updates
// cursor position, screen content, erase operations, and scrolling.
//
// This is the correct way to extract text from a full-screen TUI
// like the Claude CLI (ink-based). Instead of trying to strip ANSI
// codes from a stream (which loses word boundaries when cursor
// positioning is removed), we interpret the codes and maintain
// the actual screen state.
//
// Usage:
//   const vt = new VirtualTerminal(120, 30);
//   vt.write(rawPtyData);  // feed raw PTY output
//   const lines = vt.getLines();  // read screen content
//   const text = vt.getContent(); // screen as single string

class VirtualTerminal {
  constructor(cols = 120, rows = 30) {
    this.cols = cols;
    this.rows = rows;
    this.cursorRow = 0;
    this.cursorCol = 0;
    this.savedCursorRow = 0;
    this.savedCursorCol = 0;
    this.buffer = [];
    this._initBuffer();
  }

  _initBuffer() {
    this.buffer = Array.from({ length: this.rows }, () =>
      new Array(this.cols).fill(' ')
    );
  }

  /**
   * Feed raw PTY data into the terminal. Processes escape sequences
   * and updates the screen buffer accordingly.
   */
  write(data) {
    // Spread to handle surrogate pairs (emoji, etc.) correctly
    const chars = [...data];
    let i = 0;

    while (i < chars.length) {
      const ch = chars[i];
      const code = ch.codePointAt(0);

      // ── Escape sequence ──
      if (code === 0x1b) {
        i = this._parseEscape(chars, i);
        continue;
      }

      // ── Carriage return ──
      if (code === 0x0d) {
        this.cursorCol = 0;
        i++;
        continue;
      }

      // ── Line feed ──
      if (code === 0x0a) {
        this._lineFeed();
        i++;
        continue;
      }

      // ── Tab ──
      if (code === 0x09) {
        const nextTab = this.cursorCol + (8 - (this.cursorCol % 8));
        this.cursorCol = Math.min(nextTab, this.cols - 1);
        i++;
        continue;
      }

      // ── Backspace ──
      if (code === 0x08) {
        this.cursorCol = Math.max(this.cursorCol - 1, 0);
        i++;
        continue;
      }

      // ── Bell and other control chars — skip ──
      if (code < 0x20) {
        i++;
        continue;
      }

      // ── Regular printable character ──
      if (this.cursorRow >= 0 && this.cursorRow < this.rows &&
          this.cursorCol >= 0 && this.cursorCol < this.cols) {
        this.buffer[this.cursorRow][this.cursorCol] = ch;
      }
      this.cursorCol++;
      if (this.cursorCol >= this.cols) {
        this.cursorCol = 0;
        this._lineFeed();
      }
      i++;
    }
  }

  _lineFeed() {
    if (this.cursorRow < this.rows - 1) {
      this.cursorRow++;
    } else {
      // Scroll: shift all rows up, add blank row at bottom
      this.buffer.shift();
      this.buffer.push(new Array(this.cols).fill(' '));
    }
  }

  /**
   * Parse an escape sequence starting at position i.
   * Returns the new position after the sequence.
   */
  _parseEscape(chars, i) {
    i++; // skip ESC
    if (i >= chars.length) return i;

    const next = chars[i];

    // ── CSI sequence: ESC [ ... ──
    if (next === '[') {
      i++;
      let params = '';
      while (i < chars.length && /[0-9;?>=!]/.test(chars[i])) {
        params += chars[i];
        i++;
      }
      if (i >= chars.length) return i;

      const cmd = chars[i];
      i++;

      // Strip leading ? for private mode sequences
      const rawParams = params.replace(/^[?>=!]/, '');
      const parts = rawParams ? rawParams.split(';').map(p => parseInt(p, 10)) : [];

      switch (cmd) {
        case 'H': case 'f': // CUP — Cursor Position (row;col)
          this.cursorRow = Math.max(0, Math.min(((parts[0] || 1) - 1), this.rows - 1));
          this.cursorCol = Math.max(0, Math.min(((parts[1] || 1) - 1), this.cols - 1));
          break;

        case 'A': // CUU — Cursor Up
          this.cursorRow = Math.max(0, this.cursorRow - (parts[0] || 1));
          break;

        case 'B': // CUD — Cursor Down
          this.cursorRow = Math.min(this.rows - 1, this.cursorRow + (parts[0] || 1));
          break;

        case 'C': // CUF — Cursor Forward
          this.cursorCol = Math.min(this.cols - 1, this.cursorCol + (parts[0] || 1));
          break;

        case 'D': // CUB — Cursor Back
          this.cursorCol = Math.max(0, this.cursorCol - (parts[0] || 1));
          break;

        case 'E': // CNL — Cursor Next Line
          this.cursorCol = 0;
          this.cursorRow = Math.min(this.rows - 1, this.cursorRow + (parts[0] || 1));
          break;

        case 'F': // CPL — Cursor Previous Line
          this.cursorCol = 0;
          this.cursorRow = Math.max(0, this.cursorRow - (parts[0] || 1));
          break;

        case 'G': // CHA — Cursor Horizontal Absolute
          this.cursorCol = Math.max(0, Math.min(((parts[0] || 1) - 1), this.cols - 1));
          break;

        case 'd': // VPA — Vertical Position Absolute
          this.cursorRow = Math.max(0, Math.min(((parts[0] || 1) - 1), this.rows - 1));
          break;

        case 'J': // ED — Erase in Display
          this._eraseDisplay(parts[0] || 0);
          break;

        case 'K': // EL — Erase in Line
          this._eraseLine(parts[0] || 0);
          break;

        case 'S': // SU — Scroll Up
          this._scrollUp(parts[0] || 1);
          break;

        case 'T': // SD — Scroll Down
          this._scrollDown(parts[0] || 1);
          break;

        case 's': // SCP — Save Cursor Position
          this.savedCursorRow = this.cursorRow;
          this.savedCursorCol = this.cursorCol;
          break;

        case 'u': // RCP — Restore Cursor Position
          this.cursorRow = this.savedCursorRow;
          this.cursorCol = this.savedCursorCol;
          break;

        case 'h': // SM — Set Mode
          if (params === '?1049' || params === '?47' || params === '?1047') {
            // Switch to alternate screen buffer — save + clear
            this.savedCursorRow = this.cursorRow;
            this.savedCursorCol = this.cursorCol;
            this._initBuffer();
            this.cursorRow = 0;
            this.cursorCol = 0;
          }
          break;

        case 'l': // RM — Reset Mode
          if (params === '?1049' || params === '?47' || params === '?1047') {
            // Switch back from alternate screen buffer — restore
            this._initBuffer();
            this.cursorRow = this.savedCursorRow;
            this.cursorCol = this.savedCursorCol;
          }
          break;

        // m (SGR — colors/styling), r (DECSTBM — scroll region),
        // and other sequences are ignored — we only care about text content
      }
      return i;
    }

    // ── OSC sequence: ESC ] ... BEL or ESC ] ... ESC \ ──
    if (next === ']') {
      i++;
      while (i < chars.length) {
        if (chars[i] === '\x07') { i++; break; }
        if (chars[i] === '\x1b' && i + 1 < chars.length && chars[i + 1] === '\\') {
          i += 2;
          break;
        }
        i++;
      }
      return i;
    }

    // ── DCS, PM, APC: ESC P, ESC ^, ESC _ ──
    if ('P^_'.includes(next)) {
      i++;
      while (i < chars.length) {
        if (chars[i] === '\x1b' && i + 1 < chars.length && chars[i + 1] === '\\') {
          i += 2;
          break;
        }
        i++;
      }
      return i;
    }

    // ── Character set designation: ESC (, ESC ), ESC # ──
    if ('()#*+'.includes(next)) {
      return i + 2; // skip designator char
    }

    // ── ESC 7 / ESC 8 — Save/Restore cursor ──
    if (next === '7') {
      this.savedCursorRow = this.cursorRow;
      this.savedCursorCol = this.cursorCol;
      return i + 1;
    }
    if (next === '8') {
      this.cursorRow = this.savedCursorRow;
      this.cursorCol = this.savedCursorCol;
      return i + 1;
    }

    // ── ESC M — Reverse Index (cursor up, scroll if at top) ──
    if (next === 'M') {
      if (this.cursorRow > 0) {
        this.cursorRow--;
      } else {
        this._scrollDown(1);
      }
      return i + 1;
    }

    // ── ESC D — Index (cursor down, scroll if at bottom) ──
    if (next === 'D') {
      this._lineFeed();
      return i + 1;
    }

    // ── ESC E — Next Line ──
    if (next === 'E') {
      this.cursorCol = 0;
      this._lineFeed();
      return i + 1;
    }

    // ── Other single-char ESC sequences — skip ──
    return i + 1;
  }

  _eraseDisplay(mode) {
    if (mode === 0) {
      // Erase from cursor to end of screen
      for (let c = this.cursorCol; c < this.cols; c++) {
        this.buffer[this.cursorRow][c] = ' ';
      }
      for (let r = this.cursorRow + 1; r < this.rows; r++) {
        for (let c = 0; c < this.cols; c++) this.buffer[r][c] = ' ';
      }
    } else if (mode === 1) {
      // Erase from start to cursor
      for (let r = 0; r < this.cursorRow; r++) {
        for (let c = 0; c < this.cols; c++) this.buffer[r][c] = ' ';
      }
      for (let c = 0; c <= this.cursorCol; c++) {
        this.buffer[this.cursorRow][c] = ' ';
      }
    } else if (mode === 2 || mode === 3) {
      // Erase entire screen
      this._initBuffer();
    }
  }

  _eraseLine(mode) {
    const row = this.cursorRow;
    if (row < 0 || row >= this.rows) return;

    if (mode === 0) {
      // Erase from cursor to end of line
      for (let c = this.cursorCol; c < this.cols; c++) this.buffer[row][c] = ' ';
    } else if (mode === 1) {
      // Erase from start to cursor
      for (let c = 0; c <= this.cursorCol; c++) this.buffer[row][c] = ' ';
    } else if (mode === 2) {
      // Erase entire line
      for (let c = 0; c < this.cols; c++) this.buffer[row][c] = ' ';
    }
  }

  _scrollUp(n) {
    for (let i = 0; i < n && i < this.rows; i++) {
      this.buffer.shift();
      this.buffer.push(new Array(this.cols).fill(' '));
    }
  }

  _scrollDown(n) {
    for (let i = 0; i < n && i < this.rows; i++) {
      this.buffer.pop();
      this.buffer.unshift(new Array(this.cols).fill(' '));
    }
  }

  /** Read all screen lines, trimming trailing spaces from each line. */
  getLines() {
    return this.buffer.map(row => row.join('').trimEnd());
  }

  /** Read non-empty screen lines as a single string. */
  getContent() {
    return this.getLines()
      .filter(line => line.length > 0)
      .join('\n');
  }

  /** Check if the screen contains a prompt character (❯) indicating CLI is ready. */
  hasPrompt() {
    for (let r = this.rows - 1; r >= 0; r--) {
      const line = this.buffer[r].join('').trimEnd();
      if (/^\s*❯/.test(line) || /❯\s*$/.test(line)) return true;
    }
    return false;
  }

  /** Reset the terminal to initial state. */
  reset() {
    this._initBuffer();
    this.cursorRow = 0;
    this.cursorCol = 0;
  }
}

module.exports = { VirtualTerminal };
