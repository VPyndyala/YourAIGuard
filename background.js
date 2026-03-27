/**
 * YourAIGuard - Background Script
 *
 * Local pipeline (no external API calls):
 * 1. Gate model: decides if a response needs analysis (logistic regression on MiniLM embedding)
 * 2. Criteria scoring: 7 reasoning-quality criteria via logistic regression on MiniLM embedding
 * 3. Temporal instability: PCA-compressed instability index I_t, K-means latent state Z_t
 *    Phase Z_t ∈ {0=low, 1=intermediate, 2=high} — computed after MIN_TURNS turns
 *
 * Implements: "Temporal Instability Phases Precede and Predict Reasoning Error in GPTs"
 * by Venkata S. Pendyala
 *
 * Parameters (from paper):
 *   W_S = 3, W_L = 10, MIN_TURNS = 10
 *   f_t = Σ p_{t,k} (expected failed criteria count)
 *   e_t = 1[f_t ≥ τ]
 *   δ_t = mean_short(f) − mean_long(f)
 *   burst_t = LCR(e in short window) / W_S
 *   maxshift_t = max_k(mean_short(p_k) − mean_long(p_k))
 *   I_t = PC1(standardize(δ_t, burst_t, maxshift_t))
 *   Z_t = nearest-centroid(I_t) ∈ {0=low, 1=intermediate, 2=high}
 */

import { pipeline, env } from "./transformers.min.js";

env.allowLocalModels  = true;
env.allowRemoteModels = false;
env.localModelPath    = browser.runtime.getURL("models/");

// ─── State ───────────────────────────────────────────────────────────────────

let embedder          = null;
let criteriaModel     = null;   // { model, criteria: [{name, label, threshold, coef, intercept}×7] }
let instabilityParams = null;   // { W_S, W_L, tau, delta, burst, maxshift, pca_components, pca_mean, kmeans_centroids }
let ready             = false;

// Conversation history: conversationId → [{f, e, p:[7 failProbs], rungs:[bool×7], confidence}]
const conversationHistory = {};

// Tracks message IDs already scored — prevents double-counting on SPA navigation
const processedMessages = new Set();

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  try {
    const [criteriaRes, instabilityRes] = await Promise.all([
      fetch(browser.runtime.getURL("criteria_model.json")),
      fetch(browser.runtime.getURL("instability_params.json")),
    ]);

    criteriaModel     = await criteriaRes.json();
    instabilityParams = await instabilityRes.json();

    embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
      quantized: true,
    });

    ready = true;
  } catch (err) {
    console.error("[YourAIGuard] Init failed:", err);
  }
}

// ─── Math Utilities ───────────────────────────────────────────────────────────

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function dotProduct(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

async function embedText(text) {
  const out = await embedder(text || "", { pooling: "mean", normalize: true });
  return Array.from(out.data);
}

// ─── Criteria Scoring ─────────────────────────────────────────────────────────

/**
 * Scores all 7 reasoning criteria using logistic regression on a single MiniLM embedding.
 * No external API calls — uses the already-loaded MiniLM embedder and criteria_model.json weights.
 *
 * Returns: { scores: [{name, label, pass, prob: failProb}×7], confidence (% passing), probs: [7 failProbs] }
 */
async function scoreCriteria(prompt, response) {
  if (!ready || !criteriaModel) return null;

  const text = `[PROMPT]\n${prompt.slice(0, 400)}\n\n[RESPONSE]\n${response.slice(0, 800)}`;
  const emb  = await embedText(text);

  const scores = criteriaModel.criteria.map(criterion => {
    const passProb = sigmoid(dotProduct(criterion.coef, emb) + criterion.intercept);
    const failProb = 1 - passProb;
    const pass     = passProb >= criterion.threshold;
    return { name: criterion.name, label: criterion.label, pass, prob: failProb };
  });

  const confidence = Math.round((scores.filter(s => s.pass).length / scores.length) * 100);
  const probs      = scores.map(s => s.prob);
  return { scores, confidence, probs };
}

// ─── Temporal Instability Pipeline ───────────────────────────────────────────

function addTurn(conversationId, scores, confidence, probs) {
  if (!conversationHistory[conversationId]) conversationHistory[conversationId] = [];
  const f    = probs.reduce((a, b) => a + b, 0);           // continuous failure burden (0-7)
  const e    = f >= instabilityParams.tau ? 1 : 0;          // exceedance indicator
  const rungs = scores.map(s => s.pass);
  conversationHistory[conversationId].push({ f, e, p: probs, rungs, confidence });
}

function getHistory(conversationId) {
  return (conversationHistory[conversationId] || []).slice(-40);
}

/**
 * Longest contiguous run of 1s in an array.
 */
function lcr(arr) {
  let best = 0, cur = 0;
  for (const v of arr) {
    cur  = v ? cur + 1 : 0;
    best = Math.max(best, cur);
  }
  return best;
}

function computeInstabilityScore(conversationId) {
  const history  = conversationHistory[conversationId] || [];
  const MIN_TURNS = instabilityParams.W_L;  // 10

  if (history.length < MIN_TURNS) return { phase: null, turns: history.length };

  const W_S    = instabilityParams.W_S;   // 3
  const W_L    = instabilityParams.W_L;   // 10
  const recent = history.slice(-W_S);
  const long_  = history.slice(-W_L);

  // δ_t — mean failure-burden shift (short vs long)
  const delta  = recent.reduce((s, h) => s + h.f, 0) / W_S
               - long_.reduce((s, h) => s + h.f, 0) / W_L;

  // burst_t — LCR of e=1 in short window / W_S
  const burst  = lcr(recent.map(h => h.e)) / W_S;

  // maxshift_t — max per-criterion degradation across k=0..6
  let maxDeg = 0;
  for (let k = 0; k < 7; k++) {
    const recentMean = recent.reduce((s, h) => s + h.p[k], 0) / W_S;
    const longMean   = long_.reduce((s, h) => s + h.p[k], 0) / W_L;
    maxDeg = Math.max(maxDeg, recentMean - longMean);
  }

  // Standardize
  const p = instabilityParams;
  const deltaZ    = (delta  - p.delta.mu)    / p.delta.sigma;
  const burstZ    = (burst  - p.burst.mu)    / p.burst.sigma;
  const maxshiftZ = (maxDeg - p.maxshift.mu) / p.maxshift.sigma;

  // PCA projection: I = components · (x - pca_mean)
  const w  = p.pca_components;   // [w0, w1, w2]
  const pm = p.pca_mean;          // [m0, m1, m2]
  const I  = w[0] * (deltaZ - pm[0]) + w[1] * (burstZ - pm[1]) + w[2] * (maxshiftZ - pm[2]);

  // K-means nearest centroid
  const centroids = p.kmeans_centroids;  // [c_low, c_mid, c_high] sorted ascending
  let Z = 0, bestDist = Infinity;
  centroids.forEach((c, idx) => {
    const d = Math.abs(I - c);
    if (d < bestDist) { bestDist = d; Z = idx; }
  });

  const phaseMap = ["low", "intermediate", "high"];

  // Upward/downward transition detection
  let transition = null;
  if (history.length >= 2) {
    const prev = history[history.length - 2];
    const prevZ = (prev.z != null) ? prev.z : null;
    if (prevZ !== null) {
      transition = Z > prevZ ? "up" : Z < prevZ ? "down" : "flat";
    }
  }

  return {
    phase:      phaseMap[Z],
    Z,
    I:          parseFloat(I.toFixed(3)),
    delta:      parseFloat(delta.toFixed(3)),
    burst:      parseFloat(burst.toFixed(3)),
    maxDeg:     parseFloat(maxDeg.toFixed(3)),
    turns:      history.length,
    transition,
  };
}

// ─── Message Handler ──────────────────────────────────────────────────────────

browser.runtime.onMessage.addListener((message) => {
  if (message.type === "analyze_response") {
    if (!ready) return Promise.resolve({ notReady: true });

    const { conversationId, messageId, prompt, base, thinking } = message.data;

    // Skip if this message was already scored (SPA navigation re-scan guard)
    if (messageId && processedMessages.has(messageId)) {
      const instability = computeInstabilityScore(conversationId);
      return Promise.resolve({ cached: true, instability });
    }

    // Build response text — prefer thinking trace for richer reasoning signal
    const responseText = thinking
      ? `${thinking.slice(0, 700)} ${base.slice(0, 400)}`
      : base;

    return scoreCriteria(prompt, responseText).then(result => {
      if (!result) return null;
      if (messageId) processedMessages.add(messageId);
      addTurn(conversationId, result.scores, result.confidence, result.probs);
      const instability = computeInstabilityScore(conversationId);

      // Store I and Z in the current turn entry so the timeline can chart them
      const hist = conversationHistory[conversationId];
      if (hist && instability.phase !== null) {
        hist[hist.length - 1].s = instability.I;
        hist[hist.length - 1].z = instability.Z;
      }

      const history = getHistory(conversationId);
      return { ...result, instability, history };
    });
  }
});

init();
