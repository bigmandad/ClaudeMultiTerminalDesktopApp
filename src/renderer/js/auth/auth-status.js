// ── Auth Status — CLI detection and account status ───────

import { events } from '../events.js';
import { showToast } from '../notifications/toast.js';

let authState = {
  installed: false,
  authenticated: false,
  cliVersion: null,
  accountEmail: null,
  planType: null
};

export function initAuthStatus() {
  console.log('[AuthStatus] init — checking auth...');
  checkAuth();

  // Re-check auth periodically (every 60s) to catch login changes
  setInterval(() => checkAuth(true), 60000);
}

export function getAuthState() {
  return { ...authState };
}

async function checkAuth(silent = false) {
  const banner = document.getElementById('auth-banner');
  const dot = document.getElementById('auth-status-dot');
  const dotLabel = document.getElementById('auth-status-label');

  try {
    authState = await window.api.app.checkClaudeAuth();
    console.log('[AuthStatus] auth result:', JSON.stringify(authState));
  } catch (e) {
    console.error('[AuthStatus] checkAuth error:', e);
    authState = { installed: false, authenticated: false, cliVersion: null, accountEmail: null, planType: null };
  }

  // Update the auth status dot in the icon rail
  if (dot) {
    if (!authState.installed) {
      dot.style.background = 'var(--red)';
      dot.title = 'Claude CLI not found';
    } else if (!authState.authenticated) {
      dot.style.background = 'var(--yellow)';
      dot.title = 'Not authenticated — click to login';
    } else {
      dot.style.background = 'var(--green)';
      const info = [authState.accountEmail, authState.planType, authState.cliVersion].filter(Boolean).join(' | ');
      dot.title = `Authenticated${info ? ': ' + info : ''}`;
    }
  }

  if (dotLabel) {
    if (!authState.installed) {
      dotLabel.textContent = 'No CLI';
      dotLabel.style.color = 'var(--red)';
    } else if (!authState.authenticated) {
      dotLabel.textContent = 'Log In';
      dotLabel.style.color = 'var(--yellow)';
    } else {
      dotLabel.textContent = authState.accountEmail || 'OK';
      dotLabel.style.color = 'var(--green)';
    }
  }

  // Update the banner
  if (banner) {
    if (!authState.installed) {
      banner.className = 'auth-banner auth-error';
      banner.innerHTML = `
        <span class="auth-banner-icon">&#9888;</span>
        <span class="auth-banner-text"><strong>Claude CLI not found.</strong> Install it: <code>npm install -g @anthropic-ai/claude-code</code></span>
      `;
      banner.classList.remove('hidden');
    } else if (!authState.authenticated) {
      banner.className = 'auth-banner auth-warning';
      banner.innerHTML = `
        <span class="auth-banner-icon">&#128274;</span>
        <span class="auth-banner-text"><strong>Not authenticated.</strong> Log in to start using Claude.</span>
        <button class="auth-login-btn" id="auth-login-btn">Log In</button>
      `;
      banner.classList.remove('hidden');

      // Login button handler
      const loginBtn = document.getElementById('auth-login-btn');
      if (loginBtn) {
        loginBtn.addEventListener('click', () => {
          launchLoginSession();
        });
      }
    } else {
      // Authenticated — hide banner completely
      banner.classList.add('hidden');

      if (!silent) {
        showToast({
          title: 'Authenticated',
          message: [authState.accountEmail, authState.planType].filter(Boolean).join(' — ') || 'Connected to Claude',
          icon: '&#9989;'
        });
      }
    }
  }
}

async function launchLoginSession() {
  console.log('[AuthStatus] launchLoginSession called');
  try {
    const { createSession } = await import('../session/session-manager.js');
    const { state } = await import('../state.js');

    showToast({
      title: 'Launching login...',
      message: 'Follow the prompts in the terminal to authenticate.',
      icon: '&#128274;'
    });

    // Create a shell-only session — do NOT auto-launch claude
    console.log('[AuthStatus] creating shell-only session for login...');
    const session = await createSession({
      name: 'Claude Login',
      mode: 'ask',
      skipPerms: false,
      launchClaude: false   // Shell only, we write the command ourselves
    });
    console.log('[AuthStatus] login session created:', session.id);

    // Assign to pane 0 so the terminal is visible
    state.setActiveSession(session.id);
    state.assignPane(0, session.id);
    events.emit('session:assignToPane', {
      sessionId: session.id,
      paneIndex: 0
    });
    console.log('[AuthStatus] assigned login session to pane 0');

    // Write `claude login` after PowerShell is ready
    setTimeout(() => {
      console.log('[AuthStatus] writing "claude login" to session', session.id);
      window.api.pty.write(session.id, 'claude login\r');
    }, 1200);

    // After login completes, re-check auth
    const cleanup = window.api.pty.onExit((id, exitCode) => {
      if (id === session.id) {
        console.log('[AuthStatus] login session exited, re-checking auth...');
        cleanup();
        setTimeout(() => checkAuth(), 2000);
      }
    });
  } catch (err) {
    console.error('[AuthStatus] launchLoginSession ERROR:', err);
    showToast({
      title: 'Login Failed',
      message: err.message || String(err),
      icon: '&#9888;'
    });
  }
}

// Re-export for manual refresh
export { checkAuth as refreshAuth };
