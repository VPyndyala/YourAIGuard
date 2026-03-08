/**
 * YourAIGuard - Background Script (ES Module)
 * Loads the MiniLM embedder + gate model + rung scoring model,
 * then classifies user prompts and scores rung responses on request.
 */

import { pipeline, env } from "./transformers.min.js";

env.allowLocalModels = false;
env.useBrowserCache  = true;

let embedder  = null;
let gateModel = null;
let rungModel = null;
let ready     = false;

async function init() {
  try {
    const [gateRes, rungRes] = await Promise.all([
      fetch(browser.runtime.getURL("gate_model.json")),
      fetch(browser.runtime.getURL("rung_model.json")),
    ]);
    gateModel = await gateRes.json();
    rungModel = await rungRes.json();

    embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
      quantized: true,
    });

    ready = true;
    console.log("[YourAIGuard] Ready. Gate threshold:", gateModel.threshold);
  } catch (err) {
    console.error("[YourAIGuard] Init failed:", err);
  }
}

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function dotProduct(coef, vec) {
  let s = 0;
  for (let i = 0; i < vec.length; i++) s += coef[i] * vec[i];
  return s;
}

async function embedText(text) {
  const out = await embedder(text || "", { pooling: "mean", normalize: true });
  return Array.from(out.data);
}

// Gate: does this prompt require a reasoning check?
async function classifyGate(prompt) {
  if (!ready) return { needsCheck: true, proba: 1.0 };
  const emb   = await embedText(prompt);
  const proba = sigmoid(dotProduct(gateModel.coef, emb) + gateModel.intercept);
  return { needsCheck: proba >= gateModel.threshold, proba };
}

// Rungs: score each of the 5 rung responses
async function scoreRungs({ prompt, base, r1, r2, r3, r4, r5 }) {
  if (!ready) return null;

  // Embed all 7 fields separately then concatenate (matches training setup)
  const fields  = [prompt, base, r1, r2, r3, r4, r5];
  const embeddings = await Promise.all(fields.map(embedText));
  const combined   = embeddings.flat(); // 7 × 384 = 2688 dims

  const scores = rungModel.rungs.map((rung) => {
    const proba = sigmoid(dotProduct(rung.coef, combined) + rung.intercept);
    const pass  = proba >= rung.threshold;
    return { name: rung.name, pass, proba: parseFloat(proba.toFixed(3)) };
  });

  const confidence = Math.round((scores.filter(s => s.pass).length / scores.length) * 100);
  return { scores, confidence };
}

// ─── Header Capture ──────────────────────────────────────────────────────────
// Intercept ChatGPT's own conversation requests to capture the sentinel/proof
// tokens that the frontend computes. We reuse these for our invisible rung call.

const CAPTURE_HEADERS = [
  "openai-sentinel-chat-requirements-token",
  "openai-sentinel-proof-token",
  "oai-device-id",
  "oai-language",
  "oai-timezone",
];

let capturedHeaders = {};

browser.webRequest.onBeforeSendHeaders.addListener(
  ({ requestHeaders }) => {
    const found = {};
    for (const h of requestHeaders) {
      if (CAPTURE_HEADERS.includes(h.name.toLowerCase())) {
        found[h.name] = h.value;
      }
    }
    if (Object.keys(found).length > 0) capturedHeaders = found;
  },
  { urls: ["https://chatgpt.com/backend-api/conversation"] },
  ["requestHeaders"]
);

// ─── Message Handler ──────────────────────────────────────────────────────────

browser.runtime.onMessage.addListener((message) => {
  if (message.type === "classify_prompt")  return classifyGate(message.prompt);
  if (message.type === "score_rungs")      return scoreRungs(message.data);
  if (message.type === "get_conv_headers") return Promise.resolve(capturedHeaders);
});

init();
