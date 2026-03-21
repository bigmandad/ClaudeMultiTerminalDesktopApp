// ── Auth Manager — Coordinates provider authentication ──

const { BrowserWindow } = require('electron');
const { credentialStore } = require('./credential-store');

class AuthManager {
  constructor() {
    this._authWindows = new Map();
  }

  /**
   * Get authentication status for all providers.
   */
  getStatus() {
    return {
      openai: {
        configured: credentialStore.hasCredential('openai', 'api_key'),
        method: 'api_key',
      },
      gemini: {
        configured: credentialStore.hasCredential('gemini', 'api_key'),
        method: 'api_key',
      },
      ollama: {
        configured: true, // Always available (local)
        method: 'local',
      },
      claude: {
        configured: true, // Uses CLI auth
        method: 'cli',
      },
    };
  }

  /**
   * Set an API key for a provider.
   */
  setApiKey(provider, apiKey) {
    credentialStore.setCredential(provider, 'api_key', apiKey);
    console.log(`[AuthManager] API key set for ${provider}`);
    return { success: true };
  }

  /**
   * Remove credentials for a provider.
   */
  disconnect(provider) {
    credentialStore.deleteProvider(provider);
    console.log(`[AuthManager] Disconnected ${provider}`);
    return { success: true };
  }

  /**
   * Validate a provider's credentials by making a test API call.
   */
  async validate(provider) {
    try {
      switch (provider) {
        case 'openai': return await this._validateOpenAI();
        case 'gemini': return await this._validateGemini();
        case 'ollama': return await this._validateOllama();
        case 'claude': return { valid: true, message: 'Claude uses CLI authentication' };
        default: return { valid: false, message: `Unknown provider: ${provider}` };
      }
    } catch (e) {
      return { valid: false, message: e.message };
    }
  }

  /**
   * Open a browser window for guided API key setup.
   * @param {string} provider
   * @param {Electron.BrowserWindow} parentWindow
   */
  openAuthWindow(provider, parentWindow) {
    const urls = {
      openai: 'https://platform.openai.com/api-keys',
      gemini: 'https://aistudio.google.com/apikey',
    };

    const url = urls[provider];
    if (!url) return { success: false, message: 'No auth URL for this provider' };

    // Close existing window for this provider
    if (this._authWindows.has(provider)) {
      this._authWindows.get(provider).close();
    }

    const authWindow = new BrowserWindow({
      width: 900,
      height: 700,
      parent: parentWindow,
      modal: false,
      title: `Connect ${provider} — Get API Key`,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      }
    });

    authWindow.loadURL(url);
    this._authWindows.set(provider, authWindow);

    authWindow.on('closed', () => {
      this._authWindows.delete(provider);
    });

    return { success: true, message: `Opened ${provider} API key page` };
  }

  async _validateOpenAI() {
    const apiKey = credentialStore.getCredential('openai', 'api_key');
    if (!apiKey) return { valid: false, message: 'No API key configured' };

    try {
      const OpenAI = require('openai');
      const client = new OpenAI({ apiKey });
      const models = await client.models.list();
      return { valid: true, message: `Connected — ${models.data.length} models available` };
    } catch (e) {
      if (e.code === 'MODULE_NOT_FOUND') {
        return { valid: false, message: 'openai package not installed' };
      }
      return { valid: false, message: e.message };
    }
  }

  async _validateGemini() {
    const apiKey = credentialStore.getCredential('gemini', 'api_key');
    if (!apiKey) return { valid: false, message: 'No API key configured' };

    try {
      const { GoogleGenerativeAI } = require('@google/generative-ai');
      const client = new GoogleGenerativeAI(apiKey);
      const model = client.getGenerativeModel({ model: 'gemini-2.0-flash' });
      const result = await model.generateContent('Say "connected" in one word.');
      return { valid: true, message: 'Connected — API key valid' };
    } catch (e) {
      if (e.code === 'MODULE_NOT_FOUND') {
        return { valid: false, message: '@google/generative-ai package not installed' };
      }
      return { valid: false, message: e.message };
    }
  }

  async _validateOllama() {
    const http = require('http');
    return new Promise((resolve) => {
      const req = http.get('http://localhost:11434/api/version', { timeout: 3000 }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve({ valid: true, message: `Ollama ${json.version} running` });
          } catch {
            resolve({ valid: false, message: 'Invalid response from Ollama' });
          }
        });
      });
      req.on('error', () => resolve({ valid: false, message: 'Ollama not running on localhost:11434' }));
      req.on('timeout', () => { req.destroy(); resolve({ valid: false, message: 'Ollama not reachable' }); });
    });
  }
}

const authManager = new AuthManager();
module.exports = { authManager, AuthManager };
