// ── Provider Panel — UI for connecting and managing LLM providers ──

import { showToast } from '../notifications/toast.js';

const PROVIDERS = [
  { id: 'claude', name: 'Claude', color: '#cc9966', icon: '🤖', method: 'cli', desc: 'Anthropic CLI — uses your Claude Code login' },
  { id: 'openai', name: 'GPT (OpenAI)', color: '#74aa9c', icon: '💚', method: 'api_key', desc: 'GPT-4o, o3, o4-mini via API' },
  { id: 'gemini', name: 'Gemini (Google)', color: '#4285f4', icon: '💎', method: 'api_key', desc: 'Gemini 2.5 Pro/Flash via API' },
  { id: 'ollama', name: 'Ollama (Local)', color: '#a07ab8', icon: '🦙', method: 'local', desc: 'Run models locally — no API key needed' },
];

let _statusCache = {};

export async function initProviderPanel() {
  await refreshProviderStatus();
  renderProviders();
}

async function refreshProviderStatus() {
  try {
    _statusCache = await window.api.auth.status();
  } catch (e) {
    console.warn('[ProviderPanel] Failed to get status:', e);
  }
}

function renderProviders() {
  const container = document.getElementById('providers-list');
  if (!container) return;

  container.innerHTML = PROVIDERS.map(p => {
    const status = _statusCache[p.id] || {};
    const configured = status.configured || false;
    const statusClass = configured ? 'provider-connected' : 'provider-disconnected';
    const statusText = configured ? 'Connected' : 'Not connected';
    const statusDot = configured ? '●' : '○';

    return `
      <div class="provider-card ${statusClass}" data-provider="${p.id}">
        <div class="provider-card-header">
          <span class="provider-icon">${p.icon}</span>
          <div class="provider-info">
            <span class="provider-name">${p.name}</span>
            <span class="provider-desc">${p.desc}</span>
          </div>
          <span class="provider-status" style="color: ${configured ? '#7ab87a' : '#888'}">${statusDot} ${statusText}</span>
        </div>
        <div class="provider-actions">
          ${p.method === 'api_key' ? `
            <input type="password" class="provider-key-input" id="key-${p.id}"
              placeholder="Paste API key..." ${configured ? 'value="••••••••"' : ''}>
            <button class="provider-connect-btn" data-action="setKey" data-provider="${p.id}">
              ${configured ? 'Update' : 'Connect'}
            </button>
            <button class="provider-auth-btn" data-action="openAuth" data-provider="${p.id}" title="Get API key from provider">
              🔑
            </button>
          ` : p.method === 'local' ? `
            <button class="provider-connect-btn" data-action="validate" data-provider="${p.id}">
              Test Connection
            </button>
          ` : `
            <span class="provider-auto-text">Auto-configured via CLI</span>
          `}
          ${configured && p.method === 'api_key' ? `
            <button class="provider-disconnect-btn" data-action="disconnect" data-provider="${p.id}">
              Disconnect
            </button>
          ` : ''}
        </div>
      </div>
    `;
  }).join('');

  // Wire up event handlers
  container.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', handleProviderAction);
  });
}

async function handleProviderAction(e) {
  const action = e.target.dataset.action;
  const provider = e.target.dataset.provider;

  switch (action) {
    case 'setKey': {
      const input = document.getElementById(`key-${provider}`);
      const key = input?.value?.trim();
      if (!key || key === '••••••••') {
        showToast('Enter an API key first', 'warning');
        return;
      }
      try {
        await window.api.auth.setApiKey(provider, key);
        const validation = await window.api.auth.validate(provider);
        if (validation.valid) {
          showToast(`${provider} connected: ${validation.message}`, 'success');
        } else {
          showToast(`${provider}: ${validation.message}`, 'error');
        }
      } catch (e) {
        showToast(`Failed: ${e.message}`, 'error');
      }
      await refreshProviderStatus();
      renderProviders();
      break;
    }

    case 'openAuth': {
      await window.api.auth.openAuthWindow(provider);
      showToast(`Opening ${provider} API key page...`, 'info');
      break;
    }

    case 'validate': {
      const result = await window.api.auth.validate(provider);
      showToast(`${provider}: ${result.message}`, result.valid ? 'success' : 'warning');
      await refreshProviderStatus();
      renderProviders();
      break;
    }

    case 'disconnect': {
      await window.api.auth.disconnect(provider);
      showToast(`${provider} disconnected`, 'info');
      await refreshProviderStatus();
      renderProviders();
      break;
    }
  }
}
