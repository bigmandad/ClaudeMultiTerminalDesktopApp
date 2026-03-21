// ── Setup Wizard Panel — First-Run UI ─────────────────────

const STEPS = ['welcome', 'dependencies', 'install', 'configure', 'models', 'verify', 'complete'];

let currentStep = 0;
let depResults = [];
let installLog = {};

async function saveAndAdvance(stepName, nextStepIndex) {
  try {
    const state = await window.api.setup.getState();
    if (!state.completedSteps.includes(stepName)) {
      state.completedSteps.push(stepName);
    }
    state.currentStep = STEPS[nextStepIndex];
    await window.api.setup.saveState(state);
  } catch {}
  currentStep = nextStepIndex;
  renderStep();
}

function goToStep(idx) {
  currentStep = idx;
  renderStep();
}

function findPrevStep() {
  return Math.max(0, currentStep - 1);
}

async function createWizardOverlay() {
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

  // Resume support — pick up where we left off
  try {
    const state = await window.api.setup.getState();
    if (state.completedSteps && state.completedSteps.length > 0) {
      const lastCompleted = state.completedSteps[state.completedSteps.length - 1];
      const lastIdx = STEPS.indexOf(lastCompleted);
      if (lastIdx >= 0 && lastIdx < STEPS.length - 1) {
        currentStep = lastIdx + 1;
      }
    }
  } catch {}

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
    case 'verify': renderVerify(body, footer); break;
    case 'complete': renderComplete(body, footer); break;
  }
}

// ── Step 1: Welcome ──────────────────────────────────────

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
      <p class="setup-text setup-text-dim">
        Setup is resumable — if you close this window, you can pick up where you left off next time.
      </p>
    </div>
  `;
  footer.innerHTML = `
    <button class="btn btn-primary setup-btn" id="setup-next-btn">Begin System Check</button>
  `;
  document.getElementById('setup-next-btn').addEventListener('click', () => {
    saveAndAdvance('welcome', 1);
  });
}

// ── Step 2: Dependencies ─────────────────────────────────

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
      <button class="btn btn-primary setup-btn" id="setup-next-btn">Continue to Cloud Sync</button>
    `;
    document.getElementById('setup-back-btn').addEventListener('click', () => goToStep(0));
    document.getElementById('setup-next-btn').addEventListener('click', () => saveAndAdvance('dependencies', 3));
  } else {
    body.querySelector('.setup-text').textContent = `${missing.length} missing dependenc${missing.length === 1 ? 'y' : 'ies'} detected.`;
    footer.innerHTML = `
      <button class="btn btn-secondary setup-btn" id="setup-back-btn">Back</button>
      <button class="btn btn-primary setup-btn" id="setup-install-btn">Install Missing (${missing.length})</button>
      <button class="btn btn-secondary setup-btn" id="setup-skip-btn">Skip</button>
    `;
    document.getElementById('setup-back-btn').addEventListener('click', () => goToStep(0));
    document.getElementById('setup-install-btn').addEventListener('click', () => goToStep(2));
    document.getElementById('setup-skip-btn').addEventListener('click', () => saveAndAdvance('dependencies', 3));
  }
}

// ── Step 3: Install ──────────────────────────────────────

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
      // Refresh PATH so newly installed binaries are found
      try { await window.api.setup.refreshPath(); } catch {}
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
      <button class="btn btn-primary setup-btn" id="setup-next-btn">Continue to Cloud Sync</button>
    `;
    document.getElementById('setup-next-btn').addEventListener('click', () => saveAndAdvance('install', 3));
  } else {
    body.querySelector('.setup-text').textContent = `${failures.length} installation${failures.length === 1 ? '' : 's'} failed. You can retry or skip.`;
    footer.innerHTML = `
      <button class="btn btn-secondary setup-btn" id="setup-retry-btn">Retry Failed</button>
      <button class="btn btn-primary setup-btn" id="setup-skip-btn">Continue Anyway</button>
    `;
    document.getElementById('setup-retry-btn').addEventListener('click', () => goToStep(1));
    document.getElementById('setup-skip-btn').addEventListener('click', () => saveAndAdvance('install', 3));
  }
}

// ── Step 4: Configure ────────────────────────────────────

async function renderConfigure(body, footer) {
  const actions = [
    { id: 'start-ollama', label: 'Start Ollama Service', fn: () => window.api.setup.startOllama() },
    { id: 'gen-config', label: 'Generate OpenViking Config', fn: () => window.api.setup.configure() },
    { id: 'clone-repos', label: 'Clone Project Repositories', fn: () => window.api.setup.cloneRepos() },
    { id: 'config-plugins', label: 'Configure Plugins', fn: () => window.api.setup.configurePlugins() },
  ];

  body.innerHTML = `
    <div class="setup-section">
      <h2 class="setup-title">Configure Workspace</h2>
      <p class="setup-text">Setting up your development environment...</p>
      <div class="setup-action-list" id="setup-action-list">
        ${actions.map(a => `
          <div class="setup-action-row" id="action-row-${a.id}">
            <span class="setup-action-icon pending" id="action-icon-${a.id}">\u25CB</span>
            <span class="setup-action-name">${escHtml(a.label)}</span>
            <span class="setup-action-detail" id="action-detail-${a.id}">Waiting</span>
          </div>
        `).join('')}
      </div>
    </div>
  `;
  footer.innerHTML = `
    <button class="btn btn-secondary setup-btn" id="setup-back-btn">Back</button>
    <button class="btn btn-primary setup-btn" id="setup-run-btn">Run Configuration</button>
    <button class="btn btn-secondary setup-btn" id="setup-skip-btn">Skip</button>
  `;

  document.getElementById('setup-back-btn').addEventListener('click', () => goToStep(findPrevStep()));
  document.getElementById('setup-skip-btn').addEventListener('click', () => saveAndAdvance('configure', 4));

  document.getElementById('setup-run-btn').addEventListener('click', async () => {
    // Disable buttons while running
    footer.innerHTML = `<div class="setup-text setup-text-dim">Running configuration tasks...</div>`;

    let failures = 0;

    // Listen for clone progress if available
    let cloneCleanup = null;
    try {
      cloneCleanup = window.api.setup.onCloneProgress && window.api.setup.onCloneProgress((data) => {
        const detailEl = document.getElementById('action-detail-clone-repos');
        if (detailEl) {
          detailEl.textContent = (data.output || data.repo || '').slice(0, 60);
        }
      });
    } catch {}

    for (const action of actions) {
      const iconEl = document.getElementById(`action-icon-${action.id}`);
      const detailEl = document.getElementById(`action-detail-${action.id}`);

      if (iconEl) {
        iconEl.textContent = '\u25D4';
        iconEl.className = 'setup-action-icon running';
      }
      if (detailEl) detailEl.textContent = 'Running...';

      try {
        await action.fn();
        if (iconEl) {
          iconEl.textContent = '\u2713';
          iconEl.className = 'setup-action-icon success';
        }
        if (detailEl) detailEl.textContent = 'Done';
      } catch (err) {
        failures++;
        if (iconEl) {
          iconEl.textContent = '\u2717';
          iconEl.className = 'setup-action-icon failed';
        }
        if (detailEl) detailEl.textContent = err.message ? err.message.slice(0, 80) : 'Failed';
      }
    }

    if (cloneCleanup && typeof cloneCleanup === 'function') {
      try { cloneCleanup(); } catch {}
    }

    if (failures === 0) {
      body.querySelector('.setup-text').textContent = 'All configuration tasks completed!';
    } else {
      body.querySelector('.setup-text').textContent = `${failures} task(s) had issues. You can continue or go back.`;
    }

    footer.innerHTML = `
      <button class="btn btn-secondary setup-btn" id="setup-back-btn">Back</button>
      <button class="btn btn-primary setup-btn" id="setup-next-btn">Continue to Models</button>
    `;
    document.getElementById('setup-back-btn').addEventListener('click', () => goToStep(findPrevStep()));
    document.getElementById('setup-next-btn').addEventListener('click', () => saveAndAdvance('configure', 4));
  });
}

// ── Step 6: Models ───────────────────────────────────────

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

  document.getElementById('setup-back-btn').addEventListener('click', () => goToStep(3));
  document.getElementById('setup-skip-btn').addEventListener('click', () => saveAndAdvance('models', 5));
  document.getElementById('setup-pull-btn').addEventListener('click', async () => {
    footer.innerHTML = `<div class="setup-text setup-text-dim">Pulling models, please wait...</div>`;

    // Make sure Ollama is running before pulling
    try {
      await window.api.setup.startOllama();
    } catch {}

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
      <button class="btn btn-primary setup-btn" id="setup-next-btn">Continue to Verification</button>
    `;
    document.getElementById('setup-next-btn').addEventListener('click', () => saveAndAdvance('models', 5));
  });
}

// ── Step 7: Verify ───────────────────────────────────────

async function renderVerify(body, footer) {
  body.innerHTML = `
    <div class="setup-section">
      <h2 class="setup-title">System Verification</h2>
      <p class="setup-text">Checking that all systems are operational...</p>
      <div class="setup-verify-list" id="verify-list">
        <div class="setup-spinner-row"><div class="setup-spinner"></div> Running checks...</div>
      </div>
    </div>
  `;
  footer.innerHTML = '';

  const results = await window.api.setup.verify();
  const listEl = document.getElementById('verify-list');

  const checks = [
    { key: 'ollama', label: 'Ollama AI Engine' },
    { key: 'openviking', label: 'OpenViking Knowledge Base' },
    { key: 'database', label: 'Session Database' },
    { key: 'turso', label: 'Cloud Sync (Turso)' },
    { key: 'mcpConfig', label: 'MCP Server Config' },
    { key: 'plugins', label: 'Modding Plugins' },
    { key: 'models', label: 'AI Models' },
  ];

  listEl.innerHTML = checks.map(c => {
    const r = results[c.key] || { pass: false, detail: 'Not checked' };
    const icon = r.pass ? '\u2713' : (r.skipped ? '\u2014' : '\u2717');
    const cls = r.pass ? 'success' : (r.skipped ? 'skipped' : 'failed');
    return `
      <div class="setup-verify-row">
        <span class="setup-verify-icon ${cls}">${icon}</span>
        <span class="setup-verify-name">${escHtml(c.label)}</span>
        <span class="setup-verify-detail">${escHtml(r.detail)}</span>
      </div>
    `;
  }).join('');

  const allPassed = Object.values(results).every(r => r.pass || r.skipped);
  const failCount = Object.values(results).filter(r => !r.pass && !r.skipped).length;

  if (allPassed) {
    body.querySelector('.setup-text').textContent = 'All systems are operational!';
  } else {
    body.querySelector('.setup-text').textContent = `${failCount} check(s) need attention. You can continue or retry.`;
  }

  footer.innerHTML = `
    <button class="btn btn-secondary setup-btn" id="setup-retry-btn">Retry</button>
    <button class="btn btn-primary setup-btn" id="setup-next-btn">${allPassed ? 'Finish Setup' : 'Continue Anyway'}</button>
  `;
  document.getElementById('setup-retry-btn').addEventListener('click', () => renderVerify(body, footer));
  document.getElementById('setup-next-btn').addEventListener('click', () => saveAndAdvance('verify', 6));
}

// ── Step 8: Complete ─────────────────────────────────────

async function renderComplete(body, footer) {
  // Gather summary info
  let cloudSyncStatus = 'Auto-configured';
  let verifyResults = null;
  try {
    const vr = await window.api.setup.verify();
    verifyResults = vr;
    if (vr.turso && vr.turso.pass) {
      cloudSyncStatus = 'Connected';
    } else if (vr.turso && vr.turso.skipped) {
      cloudSyncStatus = 'Local Only';
    }
  } catch {}

  const depsFound = depResults.filter(d => d.found).length;
  const depsTotal = depResults.length;

  body.innerHTML = `
    <div class="setup-section setup-complete-section">
      <div class="setup-complete-icon">\u2713</div>
      <h2 class="setup-title">Setup Complete</h2>
      <p class="setup-text">
        Your environment is configured and ready to go.
        Claude Sessions will now start normally.
      </p>
      <div class="setup-summary" id="setup-summary">
        ${depsTotal > 0 ? `
        <div class="setup-info-row">
          <span class="setup-info-label">Dependencies</span>
          <span class="setup-info-value">${depsFound}/${depsTotal} available</span>
        </div>
        ` : ''}
        <div class="setup-info-row">
          <span class="setup-info-label">Cloud Sync</span>
          <span class="setup-info-value">${escHtml(cloudSyncStatus)}</span>
        </div>
        ${verifyResults ? `
        <div class="setup-info-row">
          <span class="setup-info-label">Verification</span>
          <span class="setup-info-value">${Object.values(verifyResults).filter(r => r.pass).length}/${Object.values(verifyResults).length} checks passed</span>
        </div>
        ` : ''}
      </div>
      <span class="setup-rerun-link" id="setup-rerun-link">Re-run Setup Wizard</span>
    </div>
  `;

  footer.innerHTML = `
    <button class="btn btn-primary setup-btn setup-btn-large" id="setup-finish-btn">Launch Claude Sessions</button>
  `;

  document.getElementById('setup-rerun-link').addEventListener('click', async () => {
    try {
      const state = await window.api.setup.getState();
      state.completedSteps = [];
      state.currentStep = 'welcome';
      await window.api.setup.saveState(state);
    } catch {}
    currentStep = 0;
    depResults = [];
    installLog = {};
    renderStep();
  });

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

    /* Form inputs */
    .setup-form {
      background: var(--bg-deep, #161310);
      border: 1px solid var(--border-dim, #2a2520);
      border-radius: var(--radius-sm, 4px);
      padding: 16px 14px;
      margin-bottom: 14px;
    }

    .setup-form-group {
      margin-bottom: 12px;
    }

    .setup-form-group:last-child {
      margin-bottom: 0;
    }

    .setup-input-label {
      display: block;
      font-size: 11px;
      color: var(--cream-dim, #a09080);
      margin-bottom: 4px;
      font-weight: 500;
    }

    .setup-input {
      width: 100%;
      padding: 8px 10px;
      background: var(--bg, #1a1714);
      border: 1px solid var(--border, #3a3330);
      border-radius: var(--radius-sm, 4px);
      color: var(--cream, #e8ddd0);
      font-family: var(--font-mono, 'Fira Code', monospace);
      font-size: 12px;
      outline: none;
      box-sizing: border-box;
    }

    .setup-input:focus {
      border-color: var(--orange, #d4845a);
      box-shadow: 0 0 0 1px rgba(212, 132, 90, 0.3);
    }

    .setup-input::placeholder {
      color: var(--cream-faint, #6a5f55);
    }

    .setup-test-row {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-top: 12px;
    }

    .setup-test-btn {
      min-width: 120px;
      font-size: 11px;
    }

    .setup-test-result {
      font-size: 11px;
    }

    .setup-test-result.success { color: var(--green, #7ab87a); }
    .setup-test-result.error { color: var(--red, #c07070); }
    .setup-test-result.pending { color: var(--yellow, #c8a96a); }

    .setup-link {
      color: var(--orange, #d4845a);
      text-decoration: underline;
    }

    /* Verify list */
    .setup-verify-list {
      background: var(--bg-deep, #161310);
      border: 1px solid var(--border-dim, #2a2520);
      border-radius: var(--radius-sm, 4px);
      padding: 8px 0;
      margin-bottom: 14px;
    }

    .setup-verify-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 14px;
      font-size: 12px;
    }

    .setup-verify-row:not(:last-child) {
      border-bottom: 1px solid var(--border-dim, #2a2520);
    }

    .setup-verify-icon {
      width: 20px;
      text-align: center;
      font-size: 14px;
      font-weight: 700;
    }

    .setup-verify-icon.success { color: var(--green, #7ab87a); }
    .setup-verify-icon.failed { color: var(--red, #c07070); }
    .setup-verify-icon.skipped { color: var(--cream-faint, #6a5f55); }

    .setup-verify-name {
      flex: 0 0 180px;
      font-weight: 500;
      color: var(--cream, #e8ddd0);
    }

    .setup-verify-detail {
      flex: 1;
      color: var(--cream-dim, #a09080);
      font-size: 11px;
      text-align: right;
    }

    /* Configure checklist */
    .setup-action-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-bottom: 14px;
    }

    .setup-action-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 14px;
      background: var(--bg-deep, #161310);
      border: 1px solid var(--border-dim, #2a2520);
      border-radius: var(--radius-sm, 4px);
      font-size: 12px;
    }

    .setup-action-icon {
      width: 20px;
      text-align: center;
      font-size: 14px;
    }

    .setup-action-icon.pending { color: var(--cream-faint, #6a5f55); }
    .setup-action-icon.running { color: var(--yellow, #c8a96a); }
    .setup-action-icon.success { color: var(--green, #7ab87a); }
    .setup-action-icon.failed { color: var(--red, #c07070); }

    .setup-action-name {
      flex: 1;
      color: var(--cream, #e8ddd0);
      font-weight: 500;
    }

    .setup-action-detail {
      font-size: 11px;
      color: var(--cream-dim, #a09080);
    }

    /* Re-run setup link */
    .setup-rerun-link {
      display: inline-block;
      margin-top: 12px;
      font-size: 10px;
      color: var(--cream-faint, #6a5f55);
      cursor: pointer;
      text-decoration: underline;
    }

    .setup-rerun-link:hover {
      color: var(--cream-dim, #a09080);
    }
  `;
  document.head.appendChild(style);
}

// ── Public API ────────────────────────────────────────────

export function showSetupWizard() {
  createWizardOverlay();
}
