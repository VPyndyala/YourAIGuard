/**
 * YourAIGuard - Background Script (ES Module)
 * Loads the MiniLM embedder + gate model weights,
 * then classifies user prompts on request from the content script.
 */

import { pipeline, env } from "./transformers.min.js";

// Use browser cache; don't look for local models
env.allowLocalModels = false;
env.useBrowserCache = true;

let embedder = null;
let modelData = null;
let ready = false;

async function init() {
  try {
    // Load gate model weights (logistic regression)
    const res = await fetch(browser.runtime.getURL("gate_model.json"));
    modelData = await res.json();

    // Load the MiniLM embedder (downloads ~23MB on first use, then cached)
    embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
      quantized: true,
    });

    ready = true;
    console.log("[YourAIGuard] Gate model ready. Threshold:", modelData.threshold);
  } catch (err) {
    console.error("[YourAIGuard] Failed to initialise gate model:", err);
  }
}

/**
 * Sigmoid — matches sklearn's predict_proba for logistic regression.
 */
function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Runs dot product of logistic regression weights against the embedding.
 */
function predictProba(embedding) {
  let dot = modelData.intercept;
  for (let i = 0; i < embedding.length; i++) {
    dot += modelData.coef[i] * embedding[i];
  }
  return sigmoid(dot);
}

/**
 * Classifies a user prompt.
 * Returns { needsCheck: bool, proba: float }
 */
async function classify(prompt) {
  if (!ready) {
    // Model still loading — default to showing indicator (safe fallback)
    return { needsCheck: true, proba: 1.0 };
  }

  const output = await embedder(prompt, { pooling: "mean", normalize: true });
  const embedding = Array.from(output.data);
  const proba = predictProba(embedding);
  const needsCheck = proba >= modelData.threshold;

  console.log(`[YourAIGuard] "${prompt.slice(0, 60)}..." → proba=${proba.toFixed(3)} needsCheck=${needsCheck}`);
  return { needsCheck, proba };
}

// Handle messages from content scripts
browser.runtime.onMessage.addListener((message) => {
  if (message.type === "classify_prompt") {
    return classify(message.prompt);
  }
});

// Start loading model immediately
init();
