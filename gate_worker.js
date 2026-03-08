/**
 * YourAIGuard - Gate Worker
 * Runs entirely in a Web Worker.
 * Loads the MiniLM embedder + logistic regression weights,
 * then answers "does this prompt need a reasoning check?" (1 or 0).
 */

importScripts("transformers.min.js");

const { pipeline, env } = self.Transformers;

// Use local extension cache; disable remote model shard downloads for WASM
env.allowLocalModels = false;
env.useBrowserCache = true;

let embedder = null;
let modelData = null;

async function loadResources() {
  // Load gate model weights (logistic regression coefficients)
  const response = await fetch(self.MODEL_URL);
  modelData = await response.json();

  // Load the MiniLM sentence embedder
  embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
    quantized: true,
  });

  self.postMessage({ type: "ready" });
}

/**
 * Sigmoid activation — same as logistic regression predict_proba
 */
function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Run logistic regression inference on a single embedding vector.
 * Returns probability that the prompt requires a reasoning check.
 */
function predictProba(embedding) {
  const coef = modelData.coef;
  const intercept = modelData.intercept;

  let dot = intercept;
  for (let i = 0; i < embedding.length; i++) {
    dot += coef[i] * embedding[i];
  }
  return sigmoid(dot);
}

/**
 * Mean-pool the token embeddings returned by the pipeline.
 */
function meanPool(tensorData, dims) {
  const [, seqLen, hiddenSize] = dims;
  const result = new Float32Array(hiddenSize);
  for (let t = 0; t < seqLen; t++) {
    for (let h = 0; h < hiddenSize; h++) {
      result[h] += tensorData[t * hiddenSize + h];
    }
  }
  // Normalize
  let norm = 0;
  for (let h = 0; h < hiddenSize; h++) {
    result[h] /= seqLen;
    norm += result[h] * result[h];
  }
  norm = Math.sqrt(norm);
  for (let h = 0; h < hiddenSize; h++) {
    result[h] /= norm;
  }
  return result;
}

self.onmessage = async (event) => {
  const { type, id, prompt } = event.data;

  if (type === "init") {
    self.MODEL_URL = event.data.modelUrl;
    await loadResources();
    return;
  }

  if (type === "classify") {
    try {
      const output = await embedder(prompt, {
        pooling: "mean",
        normalize: true,
      });

      // output.data is a flat Float32Array; dims = [1, seqLen, hiddenSize]
      const embedding = Array.from(output.data);
      const proba = predictProba(embedding);
      const needsCheck = proba >= modelData.threshold;

      self.postMessage({ type: "result", id, needsCheck, proba });
    } catch (err) {
      self.postMessage({ type: "result", id, needsCheck: true, proba: 1.0 });
    }
  }
};
