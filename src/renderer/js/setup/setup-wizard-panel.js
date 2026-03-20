// ── Setup Wizard Panel — First-Run UI ─────────────────────

const STEPS = ['welcome', 'dependencies', 'install', 'configure', 'models', 'complete'];

let currentStep = 0;
let depResults = [];
let installLog = {};

function createWizardOverlay() {
  const overlay = document.createElement('div');
  overlay.id = 'setup-wizard-overlay';
  overlay.innerHTML = `
    <div class="setup-wizard">
      <div class="setup-header">
        <div class="setup-logo">Claude Sessions</div>
        <div class="setup-subtitle">First-Run Setup Wizard</div>
      </div>
      <div class="setup-progress">
        ${STEPS.map((s, i) => `<div class="setup-step-dot${i === 0 ? ' active' : ''}" data-step="${i}"></div>`).join('')}
      </div>
      <div class="setup-body" id="setup-body"></div>
      <div class="setup-footer" id="setup-footer"></div>
    </div>
  `;
  document.body.appendChild(overlay);
  injectStyles();
  renderStep();
}

function renderStep() {
  const body = document.getElementById('setup-body');
  const footer = document.getElementById('setup-footer');
  if (!body || !footer) return;

  // Update progress dots
  document.querySelectorAll('.setup-step-dot').forEach((dot, i) => {
    dot.classList.toggle('active', i === currentStep);
    dot.classList.toggle('done', i < currentStep);
  });

  switch (STEPS[currentStep]) {
    case 'welcome': renderWelcome(body, footer); break;
    case 'dependencies': renderDependencies(body, footer); break;
    case 'install': renderInstall(body, footer); break;
    case 'configure': renderConfigure(body, footer); break;
    case 'models': renderModels(body, footer); break;
    case 'complete': renderComplete(body, footer); break;
  }
}

// ── Step: Welcome ─────────────────────────────────────────

function renderWelcome(body, footer) {
  body.innerHTML = `
    <div class="setup-section">
      <h2 class="setup-title">Welcome to Claude Sessions</h2>
      <p class="setup-text">
        This wizard will check your system for required dependencies,
        install any that are missing, and configure your development environment.
      </p>
      <div class="setup-info-box">
        <div class="setup-info-row"><span class="setup-info-label">Platform</span><span class="setup-info-value">${navigator.platform}</span></div>
        <div class="setup-info-row"><span class="setup-info-label">Architecture</span><span class="setup-info-value">${navigator.userAgent.includes('x64') ? 'x64' : navigator.userAgent.includes('arm') ? 'arm64' : 'unknown'}</span></div>
      </div>
      <p class="setup-text setup-text-dim">
        The setup process will detect Git, Node.js, Python, Java 25, Ollama,
        Claude CLI, and OpenViking. Missing components can be installed automatically.
      </p>
    </div>
  `;
  footer.innerHTML = `
    <button class="btn btn-primary setup-btn" id="setup-next-btn">Begin System Check</button>
  `;
  document.getElementById('setup-next-btn').addEventListener('click', () => {
    currentStep = 1;
    renderStep();
  });
}

// ── Step: Dependencies ────────────────────────────────────

async function renderDependencies(body, footer) {
  body.innerHTML = `
    <div class="setup-section">
      <h2 class="setup-title">System Check</h2>
      <p class="setup-text">Scanning for required dependencies...</p>
      <div class="setup-dep-list" id="setup-dep-list">
        <div class="setup-spinner-row"><div class="setup-spinner"></div> Checking...</div>
      </div>
    </div>
  `;
  footer.innerHTML = '';

  try {
    depResults = await window.api.setup.checkDeps();
  } catch (err) {
    depResults = [];
    body.querySelector('#setup-dep-list').innerHTML = `
      <div class="setup-error">Failed to check dependencies: ${escHtml(err.message)}</div>
    `;
    footer.innerHTML = `
      <button class="btn btn-secondary setup-btn" id="setup-retry-btn">Retry</button>
    `;
    document.getElementById('setup-retry-btn').addEventListener('click', () => renderDependencies(body, footer));
    return;
  }

  const listEl = body.querySelector('#setup-dep-list');
  listEl.innerHTML = depResults.map(dep => `
    <div class="setup-dep-row">
      <span class="setup-dep-icon ${dep.found ? 'found' : 'missing'}">${dep.found ? '\u2713' : '\u2717'}</span>
      <span class="setup-dep-name">${escHtml(dep.name)}</span>
      <span class="setup-dep-version">${dep.found ? escHtml(dep.version || 'found').split('\n')[0].slice(0, 50) : 'Not found'}</span>
    </div>
  `).join('');

  const allFound = depResults.every(d => d.found);
  const missing = depResults.filter(d => !d.found);

  if (allFound) {
    body.querySelector('.setup-text').textContent = 'All dependencies found!';
    footer.innerHTML = `
      <button class="btn btn-secondary setup-btn" id="setup-back-btn">Back</button>
      <button class="btn btn-primary setup-btn" id="setup-next-btn">Continue to Configuration</button>
    `;
    document.getElementById('setup-back-btn').addEventListener('click', () => { currentStep = 0; renderStep(); });
    document.getElementById('setup-next-btn').addEventListener('click', () => { currentStep = 3; renderStep(); });
  } else {
    body.querySelector('.setup-text').textContent = `${missing.length} missing dependenc${missing.length === 1 ? 'y' : 'ies'} detected.`;
    footer.innerHTML = `
      <button class="btn btn-secondary setup-btn" id="setup-back-btn">Back</button>
      <button class="btn btn-primary setup-btn" id="setup-install-btn">Install Missing (${missing.length})</button>
      <button class="btn btn-secondary setup-btn" id="setup-skip-btn">Skip</button>
    `;
    document.getElementById('setup-back-btn').addEventListener('click', () => { currentStep = 0; renderStep(); });
    document.getElementById('setup-install-btn').addEventListener('click', () => { currentStep = 2; renderStep(); });
    document.getElementById('setup-skip-btn').addEventListener('click', () => { currentStep = 3; renderStep(); });
  }
}

// ── Step: Install ─────────────────────────────────────────

async function renderInstall(body, footer) {
  const missing = depResults.filter(d => !d.found && d.installCommand);
  installLog = {};

  body.innerHTML = `
    <div class="setup-section">
      <h2 class="setup-title">Installing Dependencies</h2>
      <p class="setup-text">Installing ${missing.length} component${missing.length === 1 ? '' : 's'}...</p>
      <div class="setup-install-list" id="setup-install-list">
        ${missing.map(dep => `
          <div class="setup-install-row" id="install-row-${slugify(dep.name)}">
            <div class="setup-install-header">
              <span class="setup-install-status pending">\u25CB</span>
              <span class="setup-install-name">${escHtml(dep.name)}</span>
              <span class="setup-install-cmd">${escHtml(dep.installCommand)}</span>
            </div>
            <pre class="setup-install-log" id="install-log-${slugify(dep.name)}"></pre>
          </div>
        `).join('')}
      </div>
    </div>
  `;
  footer.innerHTML = `<div class="setup-text setup-text-dim">Please wait, this may take several minutes...</div>`;

  // Listen for progress events
  const progressCleanup = window.api.setup.onInstallProgress((data) => {
    const slug = slugify(data.name);
    const logEl = document.getElementById(`install-log-${slug}`);
    if (logEl) {
      if (!installLog[slug]) installLog[slug] = '';
      installLog[slug] += data.output;
      logEl.textContent = installLog[slug].slice(-2000);
      logEl.scrollTop = logEl.scrollHeight;
    }
  });

  let failures = [];

  for (const dep of missing) {
    const slug = slugify(dep.name);
    const statusEl = document.querySelector(`#install-row-${slug} .setup-install-status`);
    if (statusEl) {
      statusEl.textContent = '\u25D4';
      statusEl.className = 'setup-install-status running';
    }

    try {
      await window.api.setup.installDep(dep.name, dep.installCommand);
      if (statusEl) {
        statusEl.textContent = '\u2713';
        statusEl.className = 'setup-install-status success';
      }
    } catch (err) {
      failures.push(dep.name);
      if (statusEl) {
        statusEl.textContent = '\u2717';
        statusEl.className = 'setup-install-status failed';
      }
      const logEl = document.getElementById(`install-log-${slug}`);
      if (logEl) {
        logEl.textContent += '\n[ERROR] ' + err.message;
      }
    }
  }

  if (failures.length === 0) {
    body.querySelector('.setup-text').textContent = 'All dependencies installed successfully!';
    footer.innerHTML = `
      <button class="btn btn-primary setup-btn" id="setup-next-btn">Continue to Configuration</button>
    `;
    document.getElementById('setup-next-btn').addEventListener('click', () => { currentStep = 3; renderStep(); });
  } else {
    body.querySelector('.setup-text').textContent = `${failures.length} installation${failures.length === 1 ? '' : 's'} failed. You can retry or skip.`;
    footer.innerHTML = `
      <button class="btn btn-secondary setup-btn" id="setup-retry-btn">Retry Failed</button>
      <button class="btn btn-primary setup-btn" id="setup-skip-btn">Continue Anyway</button>
    `;
    document.getElementById('setup-retry-btn').addEventListener('click', () => { currentStep = 1; renderStep(); });
    document.getElementById('setup-skip-btn').addEventListener('click', () => { currentStep = 3; renderStep(); });
  }
}

// ── Step: Configure ───────────────────────────────────────

async function renderConfigure(body, footer) {
  let hytalePath = '';
  try {
    hytalePath = await window.api.setup.detectHytalePath() || '';
  } catch { /* ignore */ }

  body.innerHTML = `
    <div class="setup-section">
      <h2 class="setup-title">Configure Workspace</h2>
      <p class="setup-text">Set up OpenViking configuration and MCP server configs.</p>
      <div class="setup-config-list">
        <div class="setup-config-item">
          <span class="setup-config-icon">\u2699</span>
          <div class="setup-config-detail">
            <div class="setup-config-name">OpenViking Config</div>
            <div class="setup-config-desc">~/.openviking/ov.conf — Embedding server, storage paths</div>
          </div>
        </div>
        <div class="setup-config-item">
          <span class="setup-config-icon">\u2699</span>
          <div class="setup-config-detail">
            <div class="setup-config-name">MCP Server Config</div>
            <div class="setup-config-desc">.mcp.json — Generated from template if available</div>
          </div>
        </div>
        ${hytalePath ? `
        <div class="setup-config-item">
          <span class="setup-config-icon">\u2713</span>
          <div class="setup-config-detail">
            <div class="setup-config-name">Hytale Game Path Detected</div>
            <div class="setup-config-desc">${escHtml(hytalePath)}</div>
          </div>
        </div>
        ` : ''}
      </div>
      <div class="setup-config-status" id="setup-config-status"></div>
    </div>
  `;
  footer.innerHTML = `
    <button class="btn btn-secondary setup-btn" id="setup-back-btn">Back</button>
    <button class="btn btn-primary setup-btn" id="setup-configure-btn">Apply Configuration</button>
    <button class="btn btn-secondary setup-btn" id="setup-skip-btn">Skip</button>
  `;

  document.getElementById('setup-back-btn').addEventListener('click', () => { currentStep = 1; renderStep(); });
  document.getElementById('setup-skip-btn').addEventListener('click', () => { currentStep = 4; renderStep(); });
  document.getElementById('setup-configure-btn').addEventListener('click', async () => {
    const statusEl = document.getElementById('setup-config-status');
    statusEl.innerHTML = '<div class="setup-spinner-row"><div class="setup-spinner"></div> Applying configuration...</div>';

    try {
      // Use the app's own directory as workspace root for template generation
      const workspaceRoot = window.location.href.includes('ClaudeMultiTerminalDesktopApp')
        ? window.location.href.split('ClaudeMultiTerminalDesktopApp')[0] + 'ClaudeMultiTerminalDesktopApp'
        : '';
      await window.api.setup.configure({ workspaceRoot: workspaceRoot || '.' });
      statusEl.innerHTML = '<div class="setup-success-msg">\u2713 Configuration applied successfully!</div>';

      footer.innerHTML = `
        <button class="btn btn-primary setup-btn" id="setup-next-btn">Continue to AI Models</button>
      `;
      document.getElementById('setup-next-btn').addEventListener('click', () => { currentStep = 4; renderStep(); });
    } catch (err) {
      statusEl.innerHTML = `<div class="setup-error">\u2717 Configuration failed: ${escHtml(err.message)}</div>`;
    }
  });
}

// ── Step: Models ──────────────────────────────────────────

async function renderModels(body, footer) {
  const models = [
    { name: 'qwen3-embedding:4b', desc: 'Embedding model for OpenViking semantic search', required: true },
  ];

  body.innerHTML = `
    <div class="setup-section">
      <h2 class="setup-title">AI Models</h2>
      <p class="setup-text">Pull required Ollama models for local AI features.</p>
      <div class="setup-model-list" id="setup-model-list">
        ${models.map(m => `
          <div class="setup-model-row" id="model-row-${slugify(m.name)}">
            <div class="setup-model-header">
              <span class="setup-model-status pending">\u25CB</span>
              <span class="setup-model-name">${escHtml(m.name)}</span>
              <span class="setup-model-desc">${escHtml(m.desc)}</span>
            </div>
            <div class="setup-model-progress" id="model-progress-${slugify(m.name)}"></div>
          </div>
        `).join('')}
      </div>
      <p class="setup-text setup-text-dim" id="setup-model-note">
        This requires Ollama to be installed and running. Models may be several GB in size.
      </p>
    </div>
  `;
  footer.innerHTML = `
    <button class="btn btn-secondary setup-btn" id="setup-back-btn">Back</button>
    <button class="btn btn-primary setup-btn" id="setup-pull-btn">Pull Models</button>
    <button class="btn btn-secondary setup-btn" id="setup-skip-btn">Skip</button>
  `;

  document.getElementById('setup-back-btn').addEventListener('click', () => { currentStep = 3; renderStep(); });
  document.getElementById('setup-skip-btn').addEventListener('click', () => { currentStep = 5; renderStep(); });
  document.getElementById('setup-pull-btn').addEventListener('click', async () => {
    footer.innerHTML = `<div class="setup-text setup-text-dim">Pulling models, please wait...</div>`;

    const modelProgressCleanup = window.api.setup.onModelProgress((data) => {
      // Show progress for active model
      const progressEls = document.querySelectorAll('.setup-model-progress');
      if (progressEls.length > 0) {
        const lastEl = progressEls[progressEls.length - 1];
        lastEl.textContent = (data.output || '').trim().slice(-200);
      }
    });

    let failures = [];

    for (const model of models) {
      const slug = slugify(model.name);
      const statusEl = document.querySelector(`#model-row-${slug} .setup-model-status`);
      const progressEl = document.getElementById(`model-progress-${slug}`);

      if (statusEl) {
        statusEl.textContent = '\u25D4';
        statusEl.className = 'setup-model-status running';
      }

      try {
        await window.api.setup.pullModel(model.name);
        if (statusEl) {
          statusEl.textContent = '\u2713';
          statusEl.className = 'setup-model-status success';
        }
        if (progressEl) progressEl.textContent = 'Done';
      } catch (err) {
        failures.push(model.name);
        if (statusEl) {
          statusEl.textContent = '\u2717';
          statusEl.className = 'setup-model-status failed';
        }
        if (progressEl) progressEl.textContent = 'Failed: ' + err.message;
      }
    }

    if (failures.length === 0) {
      document.getElementById('setup-model-note').textContent = 'All models pulled successfully!';
    } else {
      document.getElementById('setup-model-note').textContent = `${failures.length} model(s) failed. You can pull them later with: ollama pull <model>`;
    }

    footer.innerHTML = `
      <button class="btn btn-primary setup-btn" id="setup-next-btn">Finish Setup</button>
    `;
    document.getElementById('setup-next-btn').addEventListener('click', () => { currentStep = 5; renderStep(); });
  });
}

// ── Step: Complete ────────────────────────────────────────

async function renderComplete(body, footer) {
  body.innerHTML = `
    <div class="setup-section setup-complete-section">
      <div class="setup-complete-icon">\u2713</div>
      <h2 class="setup-title">Setup Complete</h2>
      <p class="setup-text">
        Your environment is configured and ready to go.
        Claude Sessions will now start normally.
      </p>
      <div class="setup-summary" id="setup-summary"></div>
    </div>
  `;

  // Show summary of what was set up
  const summaryEl = document.getElementById('setup-summary');
  if (depResults.length > 0) {
    const found = depResults.filter(d => d.found).length;
    summaryEl.innerHTML = `
      <div class="setup-info-row">
        <span class="setup-info-label">Dependencies</span>
        <span class="setup-info-value">${found}/${depResults.length} available</span>
      </div>
    `;
  }

  footer.innerHTML = `
    <button class="btn btn-primary setup-btn setup-btn-large" id="setup-finish-btn">Launch Claude Sessions</button>
  `;

  document.getElementById('setup-finish-btn').addEventListener('click', async () => {
    try {
      await window.api.setup.markComplete();
    } catch (err) {
      console.error('[Setup] Failed to mark complete:', err);
    }
    // Remove wizard overlay and start the app
    const overlay = document.getElementById('setup-wizard-overlay');
    if (overlay) overlay.remove();
    // Trigger app initialization
    if (window.__startApp) {
      window.__startApp();
    } else {
      window.location.reload();
    }
  });
}

// ── Helpers ───────────────────────────────────────────────

function escHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// ── Styles ────────────────────────────────────────────────

function injectStyles() {
  if (document.getElementById('setup-wizard-styles')) return;
  const style = document.createElement('style');
  style.id = 'setup-wizard-styles';
  style.textContent = `
    #setup-wizard-overlay {
      position: fixed;
      inset: 0;
      z-index: 10000;
      background: var(--bg, #1a1714);
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: var(--font-mono, 'Fira Code', monospace);
      color: var(--cream, #e8ddd0);
      /* Account for Windows title bar overlay */
      padding-top: env(titlebar-area-height, 36px);
    }

    .setup-wizard {
      width: 600px;
      max-width: 90vw;
      max-height: 85vh;
      display: flex;
      flex-direction: column;
      background: var(--bg-panel, #201d1a);
      border: 1px solid var(--border, #3a3330);
      border-radius: var(--radius, 6px);
      box-shadow: 0 12px 48px rgba(0, 0, 0, 0.5);
      overflow: hidden;
    }

    .setup-header {
      padding: 24px 28px 16px;
      text-align: center;
      border-bottom: 1px solid var(--border-dim, #2a2520);
    }

    .setup-logo {
      font-size: 20px;
      font-weight: 700;
      color: var(--orange, #d4845a);
      letter-spacing: 0.5px;
    }

    .setup-subtitle {
      font-size: 11px;
      color: var(--cream-dim, #a09080);
      margin-top: 4px;
    }

    .setup-progress {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      padding: 14px 0;
      border-bottom: 1px solid var(--border-dim, #2a2520);
    }

    .setup-step-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--border, #3a3330);
      transition: all 200ms ease;
    }

    .setup-step-dot.active {
      background: var(--orange, #d4845a);
      box-shadow: 0 0 8px rgba(212, 132, 90, 0.4);
      transform: scale(1.2);
    }

    .setup-step-dot.done {
      background: var(--green, #7ab87a);
    }

    .setup-body {
      flex: 1;
      overflow-y: auto;
      padding: 20px 28px;
    }

    .setup-footer {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 10px;
      padding: 14px 28px;
      border-top: 1px solid var(--border-dim, #2a2520);
      min-height: 56px;
    }

    .setup-section {}

    .setup-title {
      font-size: 16px;
      font-weight: 600;
      color: var(--cream, #e8ddd0);
      margin-bottom: 10px;
    }

    .setup-text {
      font-size: 12px;
      color: var(--cream-dim, #a09080);
      line-height: 1.6;
      margin-bottom: 14px;
    }

    .setup-text-dim {
      color: var(--cream-faint, #6a5f55);
      font-size: 11px;
    }

    .setup-btn {
      min-width: 100px;
    }

    .setup-btn-large {
      padding: 10px 32px;
      font-size: 14px;
    }

    /* Info box */
    .setup-info-box {
      background: var(--bg-deep, #161310);
      border: 1px solid var(--border-dim, #2a2520);
      border-radius: var(--radius-sm, 4px);
      padding: 12px 14px;
      margin-bottom: 14px;
    }

    .setup-info-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 4px 0;
      font-size: 12px;
    }

    .setup-info-label {
      color: var(--cream-dim, #a09080);
    }

    .setup-info-value {
      color: var(--cream, #e8ddd0);
      font-weight: 500;
    }

    /* Dependency list */
    .setup-dep-list {
      background: var(--bg-deep, #161310);
      border: 1px solid var(--border-dim, #2a2520);
      border-radius: var(--radius-sm, 4px);
      padding: 8px 0;
      margin-bottom: 14px;
    }

    .setup-dep-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 14px;
      font-size: 12px;
    }

    .setup-dep-row:not(:last-child) {
      border-bottom: 1px solid var(--border-dim, #2a2520);
    }

    .setup-dep-icon {
      width: 20px;
      text-align: center;
      font-size: 14px;
      font-weight: 700;
    }

    .setup-dep-icon.found { color: var(--green, #7ab87a); }
    .setup-dep-icon.missing { color: var(--red, #c07070); }

    .setup-dep-name {
      flex: 0 0 100px;
      font-weight: 500;
      color: var(--cream, #e8ddd0);
    }

    .setup-dep-version {
      flex: 1;
      color: var(--cream-dim, #a09080);
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* Install list */
    .setup-install-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-bottom: 14px;
    }

    .setup-install-row {
      background: var(--bg-deep, #161310);
      border: 1px solid var(--border-dim, #2a2520);
      border-radius: var(--radius-sm, 4px);
      padding: 10px 14px;
    }

    .setup-install-header {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
    }

    .setup-install-status {
      font-size: 14px;
      width: 20px;
      text-align: center;
    }
    .setup-install-status.pending { color: var(--cream-faint, #6a5f55); }
    .setup-install-status.running { color: var(--yellow, #c8a96a); }
    .setup-install-status.success { color: var(--green, #7ab87a); }
    .setup-install-status.failed { color: var(--red, #c07070); }

    .setup-install-name {
      font-weight: 500;
      color: var(--cream, #e8ddd0);
    }

    .setup-install-cmd {
      flex: 1;
      text-align: right;
      font-size: 10px;
      color: var(--cream-faint, #6a5f55);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .setup-install-log {
      margin-top: 6px;
      padding: 6px 8px;
      background: var(--bg, #1a1714);
      border-radius: 3px;
      font-size: 10px;
      color: var(--cream-dim, #a09080);
      max-height: 80px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-all;
      line-height: 1.4;
      display: none;
    }

    .setup-install-row:has(.setup-install-status.running) .setup-install-log,
    .setup-install-row:has(.setup-install-status.failed) .setup-install-log {
      display: block;
    }

    /* Config list */
    .setup-config-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-bottom: 14px;
    }

    .setup-config-item {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 10px 14px;
      background: var(--bg-deep, #161310);
      border: 1px solid var(--border-dim, #2a2520);
      border-radius: var(--radius-sm, 4px);
    }

    .setup-config-icon {
      font-size: 16px;
      color: var(--orange, #d4845a);
      margin-top: 2px;
    }

    .setup-config-name {
      font-size: 12px;
      font-weight: 500;
      color: var(--cream, #e8ddd0);
    }

    .setup-config-desc {
      font-size: 10px;
      color: var(--cream-faint, #6a5f55);
      margin-top: 2px;
    }

    .setup-config-status {
      margin-top: 8px;
    }

    .setup-success-msg {
      color: var(--green, #7ab87a);
      font-size: 12px;
      font-weight: 500;
    }

    /* Model list */
    .setup-model-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-bottom: 14px;
    }

    .setup-model-row {
      background: var(--bg-deep, #161310);
      border: 1px solid var(--border-dim, #2a2520);
      border-radius: var(--radius-sm, 4px);
      padding: 10px 14px;
    }

    .setup-model-header {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
    }

    .setup-model-status {
      font-size: 14px;
      width: 20px;
      text-align: center;
    }
    .setup-model-status.pending { color: var(--cream-faint, #6a5f55); }
    .setup-model-status.running { color: var(--yellow, #c8a96a); }
    .setup-model-status.success { color: var(--green, #7ab87a); }
    .setup-model-status.failed { color: var(--red, #c07070); }

    .setup-model-name {
      font-weight: 500;
      color: var(--cream, #e8ddd0);
    }

    .setup-model-desc {
      flex: 1;
      text-align: right;
      font-size: 10px;
      color: var(--cream-faint, #6a5f55);
    }

    .setup-model-progress {
      font-size: 10px;
      color: var(--cream-dim, #a09080);
      margin-top: 4px;
      min-height: 14px;
      white-space: pre-wrap;
      word-break: break-all;
    }

    /* Complete */
    .setup-complete-section {
      text-align: center;
      padding-top: 20px;
    }

    .setup-complete-icon {
      font-size: 48px;
      color: var(--green, #7ab87a);
      margin-bottom: 12px;
    }

    .setup-summary {
      margin-top: 16px;
      background: var(--bg-deep, #161310);
      border: 1px solid var(--border-dim, #2a2520);
      border-radius: var(--radius-sm, 4px);
      padding: 12px 14px;
      text-align: left;
    }

    /* Error */
    .setup-error {
      color: var(--red, #c07070);
      font-size: 12px;
      padding: 10px 14px;
    }

    /* Spinner */
    .setup-spinner-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 14px;
      font-size: 12px;
      color: var(--cream-dim, #a09080);
    }

    .setup-spinner {
      width: 16px;
      height: 16px;
      border: 2px solid var(--border, #3a3330);
      border-top-color: var(--orange, #d4845a);
      border-radius: 50%;
      animation: setup-spin 0.8s linear infinite;
    }

    @keyframes setup-spin {
      to { transform: rotate(360deg); }
    }
  `;
  document.head.appendChild(style);
}

// ── Public API ────────────────────────────────────────────

export function showSetupWizard() {
  createWizardOverlay();
}
