/**
 * YourAIGuard - Background Script
 * Manages the gate worker and routes messages between
 * content scripts and the inference worker.
 */

let worker = null;
let workerReady = false;
const pendingRequests = new Map();
let requestId = 0;

function initWorker() {
  const workerUrl = browser.runtime.getURL("gate_worker.js");
  const modelUrl = browser.runtime.getURL("gate_model.json");

  worker = new Worker(workerUrl);

  worker.onmessage = (event) => {
    const { type, id, needsCheck, proba } = event.data;

    if (type === "ready") {
      workerReady = true;
      // Flush any queued requests
      pendingRequests.forEach(({ resolve, prompt }, queuedId) => {
        worker.postMessage({ type: "classify", id: queuedId, prompt });
      });
      return;
    }

    if (type === "result") {
      const entry = pendingRequests.get(id);
      if (entry) {
        entry.resolve({ needsCheck, proba });
        pendingRequests.delete(id);
      }
    }
  };

  worker.onerror = (err) => {
    console.error("[YourAIGuard] Worker error:", err);
  };

  // Kick off model loading
  worker.postMessage({ type: "init", modelUrl });
}

function classifyPrompt(prompt) {
  return new Promise((resolve) => {
    const id = ++requestId;
    pendingRequests.set(id, { resolve, prompt });

    if (workerReady) {
      worker.postMessage({ type: "classify", id, prompt });
    }
    // If not ready yet, the flush in the "ready" handler will pick it up
  });
}

// Listen for messages from content scripts
browser.runtime.onMessage.addListener((message, sender) => {
  if (message.type === "classify_prompt") {
    return classifyPrompt(message.prompt).then((result) => result);
  }
});

// Start the worker when the background page loads
initWorker();
