// ── Credential Store — Encrypted API key storage using OS keychain ──

const { safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

class CredentialStore {
  constructor() {
    this._dir = path.join(os.homedir(), '.omniclaw', 'credentials');
    if (!fs.existsSync(this._dir)) fs.mkdirSync(this._dir, { recursive: true });
  }

  /**
   * Check if encryption is available on this platform.
   */
  isAvailable() {
    return safeStorage.isEncryptionAvailable();
  }

  /**
   * Store a credential (encrypted at rest).
   * @param {string} provider - Provider ID (openai, gemini, etc.)
   * @param {string} key - Credential key (api_key, refresh_token, etc.)
   * @param {string} value - The secret value
   */
  setCredential(provider, key, value) {
    if (!this.isAvailable()) {
      console.warn('[CredentialStore] Encryption not available — storing in plaintext');
      const filePath = this._getPath(provider, key);
      fs.writeFileSync(filePath, value, 'utf8');
      return;
    }

    const encrypted = safeStorage.encryptString(value);
    const filePath = this._getPath(provider, key);
    fs.writeFileSync(filePath, encrypted);
  }

  /**
   * Retrieve a credential.
   * @param {string} provider
   * @param {string} key
   * @returns {string|null}
   */
  getCredential(provider, key) {
    const filePath = this._getPath(provider, key);
    if (!fs.existsSync(filePath)) return null;

    try {
      const data = fs.readFileSync(filePath);
      if (this.isAvailable()) {
        return safeStorage.decryptString(data);
      }
      return data.toString('utf8');
    } catch (e) {
      console.error(`[CredentialStore] Failed to decrypt ${provider}/${key}:`, e.message);
      return null;
    }
  }

  /**
   * Check if a credential exists.
   */
  hasCredential(provider, key) {
    return fs.existsSync(this._getPath(provider, key));
  }

  /**
   * Delete a credential.
   */
  deleteCredential(provider, key) {
    const filePath = this._getPath(provider, key);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }

  /**
   * Delete all credentials for a provider.
   */
  deleteProvider(provider) {
    const providerDir = path.join(this._dir, provider);
    if (fs.existsSync(providerDir)) {
      fs.rmSync(providerDir, { recursive: true });
    }
  }

  /**
   * List all configured providers (those with at least one credential).
   */
  listConfigured() {
    if (!fs.existsSync(this._dir)) return [];
    return fs.readdirSync(this._dir)
      .filter(f => fs.statSync(path.join(this._dir, f)).isDirectory());
  }

  /**
   * Get status of all known providers.
   */
  getStatus() {
    const providers = ['openai', 'gemini', 'ollama'];
    return providers.map(p => ({
      provider: p,
      configured: this.hasCredential(p, 'api_key'),
    }));
  }

  _getPath(provider, key) {
    const providerDir = path.join(this._dir, provider);
    if (!fs.existsSync(providerDir)) fs.mkdirSync(providerDir, { recursive: true });
    return path.join(providerDir, `${key}.enc`);
  }
}

// Singleton
const credentialStore = new CredentialStore();
module.exports = { credentialStore, CredentialStore };
