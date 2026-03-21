// ── Provider Registry — Singleton managing all LLM providers ──

const { ClaudeProvider } = require('./claude-provider');
const { OpenAIProvider } = require('./openai-provider');
const { GeminiProvider } = require('./gemini-provider');
const { OllamaProvider } = require('./ollama-provider');

class ProviderRegistry {
  constructor() {
    /** @type {Map<string, import('./provider-interface').ProviderInterface>} */
    this.providers = new Map();
    this._credentialStore = null;
  }

  /**
   * Initialize all providers.
   * @param {{ credentialStore?, ptyManager? }} deps
   */
  init(deps = {}) {
    this._credentialStore = deps.credentialStore || null;

    // Claude — always available (uses PTY)
    const claude = new ClaudeProvider(deps.ptyManager);
    this.providers.set(claude.id, claude);

    // OpenAI — available if SDK installed
    try {
      const openai = new OpenAIProvider(this._credentialStore);
      this.providers.set(openai.id, openai);
    } catch (e) {
      console.warn('[ProviderRegistry] OpenAI provider unavailable:', e.message);
    }

    // Gemini — available if SDK installed
    try {
      const gemini = new GeminiProvider(this._credentialStore);
      this.providers.set(gemini.id, gemini);
    } catch (e) {
      console.warn('[ProviderRegistry] Gemini provider unavailable:', e.message);
    }

    // Ollama — always available (local HTTP)
    const ollama = new OllamaProvider();
    this.providers.set(ollama.id, ollama);

    console.log(`[ProviderRegistry] ${this.providers.size} providers registered:`,
      [...this.providers.keys()].join(', '));
  }

  /** Get a provider by ID */
  getProvider(id) {
    return this.providers.get(id) || null;
  }

  /** List all registered providers with their status */
  listProviders() {
    return [...this.providers.values()].map(p => ({
      id: p.id,
      displayName: p.displayName,
      color: p.uiColor,
      configured: p.isConfigured(),
    }));
  }

  /** List all available models across all configured providers */
  async listAllModels() {
    const results = [];
    for (const provider of this.providers.values()) {
      if (!provider.isConfigured()) continue;
      try {
        const models = await provider.models();
        for (const m of models) {
          results.push({ provider: provider.id, providerName: provider.displayName, ...m });
        }
      } catch (e) {
        console.warn(`[ProviderRegistry] Failed to list models for ${provider.id}:`, e.message);
      }
    }
    return results;
  }

  /** Check if a provider is configured and ready */
  isConfigured(id) {
    const p = this.providers.get(id);
    return p ? p.isConfigured() : false;
  }
}

// Singleton
const registry = new ProviderRegistry();
module.exports = { providerRegistry: registry, ProviderRegistry };
