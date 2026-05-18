// ── Peer Review — Synthesizes multiple LLM responses ──

const { providerRegistry } = require('../providers/provider-registry');
const { ApiPtyEmitter } = require('../providers/api-pty-emitter');

// ── Quality scoring helpers ─────────────────────────────
// Cheap, no-dependency signals about whether the synthesis is good.
// Used to populate the peer_review_runs table and inform whether the
// self-improvement loop should trust a given synthesis.

const STOPWORDS = new Set([
  'the','a','an','and','or','but','if','then','of','to','in','on','at',
  'is','are','was','were','be','been','being','for','as','with','by',
  'this','that','these','those','it','its','from','will','would','can',
  'could','should','may','might','do','does','did','have','has','had',
]);

function _significantTerms(text) {
  if (!text) return new Set();
  return new Set(
    String(text).toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 4 && !STOPWORDS.has(w))
  );
}

function _jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Score a synthesis run on a 0..1 composite.
 *   - 40%: providers agreed (avg pairwise Jaccard of their responses)
 *   - 30%: synthesis cites every participant
 *   - 30%: synthesis is reasonably long (>200 chars) — short syntheses
 *           tend to be evasive/under-thought
 */
function scoreSynthesis(responses, synthesis) {
  const valid = responses.filter(r =>
    (r.status === 'complete' || r.status === 'fulfilled') && (r.response || '').length > 0
  );
  if (valid.length === 0) {
    return {
      responseCount: 0, avgResponseLength: 0, jaccardOverlap: 0,
      synthesisLength: (synthesis || '').length, citesAll: false, qualityScore: 0,
      participantIds: [],
    };
  }

  const termSets = valid.map(r => _significantTerms(r.response));
  let pairCount = 0;
  let jaccardSum = 0;
  for (let i = 0; i < termSets.length; i++) {
    for (let j = i + 1; j < termSets.length; j++) {
      jaccardSum += _jaccard(termSets[i], termSets[j]);
      pairCount++;
    }
  }
  const jaccardOverlap = pairCount > 0 ? jaccardSum / pairCount : 1; // single-provider case → no disagreement

  const synthLower = String(synthesis || '').toLowerCase();
  const citesCount = valid.filter(r => synthLower.includes(r.providerId.toLowerCase())).length;
  const citesAll = citesCount === valid.length;

  const avgLen = valid.reduce((s, r) => s + (r.response || '').length, 0) / valid.length;
  const synthLen = synthLower.length;

  const lengthScore = Math.min(1, synthLen / 200);
  const score = 0.4 * jaccardOverlap + 0.3 * (citesAll ? 1 : citesCount / valid.length) + 0.3 * lengthScore;

  return {
    responseCount: valid.length,
    avgResponseLength: avgLen,
    jaccardOverlap,
    synthesisLength: synthLen,
    citesAll,
    qualityScore: score,
    participantIds: valid.map(r => r.providerId),
  };
}

class PeerReview {
  /**
   * Synthesize multiple LLM responses into a comparative analysis.
   *
   * @param {Array<{providerId, model, response}>} responses - Collected responses
   * @param {string} originalPrompt - The user's original message
   * @param {object} opts
   * @param {string} opts.reviewerId - Provider to use as reviewer (default: 'claude')
   * @param {string} opts.reviewerModel - Model for the reviewer
   * @param {string} opts.sessionId - Session ID for output
   * @param {Electron.WebContents} opts.webContents - For streaming output
   * @returns {Promise<string>} Synthesis text
   */
  static async synthesize(responses, originalPrompt, opts = {}) {
    const reviewerId = opts.reviewerId || 'claude';
    const reviewer = providerRegistry.getProvider(reviewerId);

    if (!reviewer) {
      throw new Error(`Reviewer provider not available: ${reviewerId}`);
    }

    // Build the synthesis prompt
    const synthesisPrompt = PeerReview._buildPrompt(responses, originalPrompt);

    // For Claude (PTY), we can't easily use the API path —
    // fall back to a non-Claude reviewer or use the first available API provider
    let actualReviewer = reviewer;
    let actualReviewerId = reviewerId;

    if (reviewerId === 'claude') {
      // Try to use an API-based provider for synthesis since Claude uses PTY
      const apiProviders = ['openai', 'gemini', 'ollama'];
      for (const pid of apiProviders) {
        const p = providerRegistry.getProvider(pid);
        if (p && p.isConfigured()) {
          actualReviewer = p;
          actualReviewerId = pid;
          break;
        }
      }

      // If only Claude is available, return a formatted comparison without AI synthesis
      if (actualReviewerId === 'claude') {
        return PeerReview._staticComparison(responses, originalPrompt);
      }
    }

    const synthesisSessionId = `${opts.sessionId || 'synthesis'}__review`;
    const model = opts.reviewerModel || (await actualReviewer.models())[0]?.id;

    await actualReviewer.createSession(synthesisSessionId, {
      model,
      systemPrompt: 'You are an expert analyst synthesizing responses from multiple AI models. Be concise, insightful, and highlight key differences and agreements.',
    });

    // Stream + collect in a single pass.
    // Previously this code called sendMessage twice — once via streamResponse and
    // once to "collect text". The second call ran on a session whose history
    // already contained the synthesis exchange, so it produced a follow-up rather
    // than a fresh synthesis (double-billed tokens, mismatched UI vs return value).
    const emitter = opts.webContents
      ? new ApiPtyEmitter(opts.webContents, synthesisSessionId, actualReviewerId)
      : null;

    if (emitter) emitter.writeHeader(`Synthesis (${actualReviewer.displayName})`);

    let fullSynthesis = '';
    const generator = actualReviewer.sendMessage(synthesisSessionId, synthesisPrompt);
    for await (const chunk of generator) {
      switch (chunk.type) {
        case 'text':
          fullSynthesis += chunk.content;
          if (emitter) emitter.writeChunk(chunk.content);
          break;
        case 'error':
          if (emitter) emitter.writeError(chunk.content);
          break;
        case 'cancelled':
          if (emitter) emitter.writeStatus('Synthesis cancelled');
          break;
      }
    }

    if (emitter) emitter.writeDone();

    actualReviewer.destroy(synthesisSessionId);

    // Persist a quality record so the AutoResearch loop has a signal about
    // whether peer review is producing useful syntheses or junk.
    try {
      const db = require('../db/database');
      const quality = scoreSynthesis(responses, fullSynthesis);
      db.peerReview.record({
        sessionId: opts.sessionId || null,
        reviewerId: actualReviewerId,
        reviewerModel: model,
        ...quality,
      });
    } catch (e) {
      console.warn('[PeerReview] quality scoring failed:', e.message);
    }

    return fullSynthesis;
  }

  /**
   * Build the synthesis meta-prompt.
   */
  static _buildPrompt(responses, originalPrompt) {
    let prompt = `## Multi-LLM Peer Review\n\n`;
    prompt += `**Original Prompt:** ${originalPrompt}\n\n`;
    prompt += `The following responses were generated by different AI models for the same prompt. `;
    prompt += `Analyze them and provide:\n`;
    prompt += `1. **Consensus** — What all models agree on\n`;
    prompt += `2. **Divergences** — Where models disagree and why\n`;
    prompt += `3. **Strengths** — Best insights from each model\n`;
    prompt += `4. **Gaps** — What all models missed\n`;
    prompt += `5. **Recommended Answer** — Your synthesized best response\n\n`;
    prompt += `---\n\n`;

    for (const r of responses) {
      if (r.status !== 'complete' && r.status !== 'fulfilled') continue;
      const response = r.response || '';
      const truncated = response.length > 3000 ? response.slice(0, 3000) + '\n[truncated]' : response;
      prompt += `### ${r.providerId.toUpperCase()} (${r.model})\n\n${truncated}\n\n---\n\n`;
    }

    return prompt;
  }

  /**
   * Fallback: static comparison when no API provider is available for synthesis.
   */
  static _staticComparison(responses, originalPrompt) {
    let output = `\n═══ MULTI-LLM COMPARISON ═══\n\n`;
    output += `Prompt: ${originalPrompt.slice(0, 200)}\n\n`;

    for (const r of responses) {
      const status = r.status === 'complete' ? '✓' : '✗';
      const duration = r.duration ? `(${(r.duration / 1000).toFixed(1)}s)` : '';
      output += `── ${r.providerId.toUpperCase()} / ${r.model} ${status} ${duration} ──\n`;
      output += `${(r.response || 'No response').slice(0, 500)}\n\n`;
    }

    output += `═══ END COMPARISON ═══\n`;
    return output;
  }
}

module.exports = { PeerReview };
