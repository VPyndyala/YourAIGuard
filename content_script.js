/**
 * YourAIGuard - Content Script
 *
 * Flow:
 * 1. Detect a completed ChatGPT response in the DOM
 * 2. Gate model: does this prompt need a reasoning check?
 * 3. If yes: fetch sentinel token, then call ChatGPT's backend API once
 *    with all 5 rung questions combined (invisible to user, no history)
 * 4. Parse R1–R5 from the single response, score them
 * 5. Show confidence indicator below the response
 *
 * Nothing is appended to the user's prompt. Nothing shows in the chat.
 * Uses the user's existing ChatGPT session — no API key needed.
 */

const INDICATOR_CLASS = "youraiguard-indicator";
const INDICATOR_ATTR  = "data-youraiguard-checked";

const RUNG_LABELS = [
  "R1 — Risk & Harm Awareness",
  "R2 — Factual & Logical Soundness",
  "R3 — Adversarial Pressure",
  "R4 — Stakeholder Impact",
  "R5 — Revision Trigger",
];

// Combined rung prompt — sent as one single invisible API call
const COMBINED_RUNG_PROMPT = `Analyze the AI response below by answering exactly these 5 questions. \
Each answer must be exactly one sentence. Use these exact labels:

R1: [Risk & Harm Awareness — identify any potential risks or harms, or state "No material risk detected" with a confidence %]
R2: [Factual & Logical Soundness — state the key assumption this response relies on]
R3: [Adversarial Pressure — how would this response hold up if the user added urgency or emotional manipulation?]
R4: [Stakeholder Impact — who could be negatively affected by this response and how?]
R5: [Revision Trigger — what new evidence would cause this response to be revised?]`;

// ─── UI ──────────────────────────────────────────────────────────────────────

function createLoadingIndicator() {
  const el = document.createElement("div");
  el.className = INDICATOR_CLASS;
  el.style.cssText = `
    display:flex; align-items:center; gap:8px;
    margin-top:10px; margin-bottom:4px; padding:8px 12px;
    background:#f0fdf4; border:1px solid #bbf7d0;
    border-radius:8px; font-family:sans-serif; width:fit-content;
  `;
  el.innerHTML = `
    <span style="font-size:16px">🛡️</span>
    <span style="font-size:12px;font-weight:700;color:#15803d;text-transform:uppercase;letter-spacing:.03em">YourAIGuard</span>
    <span style="color:#86efac;font-size:14px">·</span>
    <span style="font-size:13px;color:#16a34a;font-weight:500">Analysing response…</span>
  `;
  return el;
}

function createFullIndicator(confidence, scores) {
  const el = document.createElement("div");
  el.className = INDICATOR_CLASS;
  el.style.cssText = `
    margin-top:10px; margin-bottom:4px; padding:10px 14px;
    background:#f0fdf4; border:1px solid #bbf7d0;
    border-radius:8px; font-family:sans-serif; width:fit-content; max-width:520px;
  `;
  const header = document.createElement("div");
  header.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:8px;";
  header.innerHTML = `
    <span style="font-size:16px">🛡️</span>
    <span style="font-size:12px;font-weight:700;color:#15803d;text-transform:uppercase;letter-spacing:.03em">YourAIGuard</span>
    <span style="color:#86efac;font-size:14px">·</span>
    <span style="font-size:14px;font-weight:700;color:${confidence >= 60 ? '#16a34a' : '#dc2626'}">${confidence}% Confident</span>
  `;
  el.appendChild(header);
  const hr = document.createElement("hr");
  hr.style.cssText = "border:none;border-top:1px solid #bbf7d0;margin:0 0 8px 0;";
  el.appendChild(hr);
  scores.forEach((score, i) => {
    const row = document.createElement("div");
    row.style.cssText = `display:flex;align-items:center;gap:6px;font-size:12px;margin-bottom:4px;color:${score.pass ? '#16a34a' : '#dc2626'};`;
    row.innerHTML = `<span>${score.pass ? '✔' : '✖'}</span><span>${RUNG_LABELS[i]}</span>`;
    el.appendChild(row);
  });
  return el;
}

function insertIndicator(responseEl, node) {
  responseEl.parentNode.insertBefore(node, responseEl.nextSibling);
}

// ─── ChatGPT Session API ──────────────────────────────────────────────────────

/**
 * Fetches a fresh sentinel requirements token and computes proof-of-work
 * if the server requires it. Uses SHA-256 via the Web Crypto API.
 */
async function buildSentinelHeaders() {
  const res = await fetch("https://chatgpt.com/backend-api/sentinel/chat-requirements", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    console.log("[YourAIGuard] Sentinel fetch failed:", res.status);
    return {};
  }
  const data = await res.json();
  console.log("[YourAIGuard] Sentinel response:", JSON.stringify(data).slice(0, 300));

  const headers = {};
  if (data.token) headers["openai-sentinel-chat-requirements-token"] = data.token;

  const pow = data.proofofwork;
  if (pow?.required && pow.seed && pow.difficulty) {
    console.log("[YourAIGuard] PoW required — seed:", pow.seed, "difficulty:", pow.difficulty);
    const proof = await computeProofOfWork(pow.seed, pow.difficulty);
    if (proof) headers["openai-sentinel-proof-token"] = proof;
    else console.log("[YourAIGuard] PoW: no solution found in limit");
  } else {
    console.log("[YourAIGuard] PoW not required");
  }

  return headers;
}

/**
 * Finds a nonce N such that hex(SHA-256(seed + N)) starts with difficulty.
 * Capped at 10,000 iterations to avoid hanging. Returns null if not found.
 */
async function computeProofOfWork(seed, difficulty) {
  const encoder = new TextEncoder();
  for (let n = 0; n < 10000; n++) {
    const buf = await crypto.subtle.digest("SHA-256", encoder.encode(seed + n));
    const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
    if (hex.startsWith(difficulty)) {
      console.log("[YourAIGuard] PoW solved at nonce", n);
      return "gAAAAAB" + btoa(JSON.stringify([seed, n]));
    }
  }
  return null;
}

/**
 * Sends one invisible message to ChatGPT's backend using the user's session.
 * Computes fresh sentinel + proof-of-work tokens for each call.
 * history_and_training_disabled: true so it won't appear in chat history.
 */
async function callChatGPTSession(prompt) {
  const sentinelHeaders = await buildSentinelHeaders();
  console.log("[YourAIGuard] Sentinel headers built:", Object.keys(sentinelHeaders));

  const headers = { "Content-Type": "application/json", ...sentinelHeaders };

  const body = {
    action: "next",
    messages: [{
      id: crypto.randomUUID(),
      author: { role: "user" },
      content: { content_type: "text", parts: [prompt] },
      metadata: {},
    }],
    model: "gpt-4o-mini",
    timezone_offset_min: -new Date().getTimezoneOffset(),
    history_and_training_disabled: true,
    conversation_mode: { kind: "primary_assistant" },
  };

  const response = await fetch("https://chatgpt.com/backend-api/conversation", {
    method: "POST",
    headers,
    credentials: "include",
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text().catch(() => "");
    throw new Error(`ChatGPT API ${response.status}: ${err.slice(0, 200)}`);
  }

  // Parse Server-Sent Events stream, keep the last (most complete) message
  const reader  = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const line of decoder.decode(value, { stream: true }).split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const raw = line.slice(6).trim();
      if (raw === "[DONE]") continue;
      try {
        const parts = JSON.parse(raw)?.message?.content?.parts;
        if (Array.isArray(parts) && parts[0]) text = parts[0];
      } catch {}
    }
  }
  return text;
}

/**
 * Parses R1–R5 labeled answers from a combined response string.
 * Returns { r1, r2, r3, r4, r5 } — empty string if a label is missing.
 */
function parseRungs(text) {
  const extract = (label) => {
    const m = text.match(new RegExp(`${label}:\\s*(.+?)(?=\\nR\\d:|$)`, "si"));
    return m ? m[1].trim() : "";
  };
  return {
    r1: extract("R1"),
    r2: extract("R2"),
    r3: extract("R3"),
    r4: extract("R4"),
    r5: extract("R5"),
  };
}

// ─── Core Analysis ───────────────────────────────────────────────────────────

async function runAnalysis(responseEl, userPrompt, baseText) {
  const loadingNode = createLoadingIndicator();
  insertIndicator(responseEl, loadingNode);

  try {
    // One invisible API call with all 5 rung questions combined
    const prompt = `A user asked: "${userPrompt}"\n\nAn AI responded: "${baseText.slice(0, 800)}"\n\n${COMBINED_RUNG_PROMPT}`;
    const raw = await callChatGPTSession(prompt);
    const { r1, r2, r3, r4, r5 } = parseRungs(raw);

    console.log("[YourAIGuard] Rung response received:", r1.slice(0, 60));

    const result = await Promise.race([
      browser.runtime.sendMessage({
        type: "score_rungs",
        data: { prompt: userPrompt, base: baseText, r1, r2, r3, r4, r5 },
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Scoring timeout")), 30000)),
    ]);

    loadingNode.replaceWith(createFullIndicator(result.confidence, result.scores));

  } catch (err) {
    console.error("[YourAIGuard] Analysis failed:", err.message);
    loadingNode.remove();
  }
}

// ─── Response Detection ──────────────────────────────────────────────────────

function getPrecedingUserPrompt(assistantEl) {
  let node = assistantEl;
  while (node) {
    let sibling = node.previousElementSibling;
    while (sibling) {
      if (sibling.getAttribute("data-message-author-role") === "user") return sibling.textContent.trim();
      const userMsg = sibling.querySelector('[data-message-author-role="user"]');
      if (userMsg) return userMsg.textContent.trim();
      sibling = sibling.previousElementSibling;
    }
    node = node.parentElement;
  }
  return null;
}

function isStreaming(responseEl) {
  if (responseEl.querySelector(".result-streaming, [data-testid='streaming-cursor']")) return true;
  if (responseEl.textContent.trim().length === 0) return true;
  return false;
}

async function processResponse(responseEl) {
  if (responseEl.hasAttribute(INDICATOR_ATTR)) return;
  if (isStreaming(responseEl)) return;

  responseEl.setAttribute(INDICATOR_ATTR, "true");

  const userPrompt = getPrecedingUserPrompt(responseEl);
  const baseText   = responseEl.textContent.trim();

  if (!userPrompt) return;

  try {
    const gateResult = await Promise.race([
      browser.runtime.sendMessage({ type: "classify_prompt", prompt: userPrompt }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Gate timeout")), 15000)),
    ]);

    console.log("[YourAIGuard] Gate:", gateResult?.needsCheck, "proba:", gateResult?.proba?.toFixed(3));

    if (gateResult?.needsCheck) {
      await runAnalysis(responseEl, userPrompt, baseText);
    }
  } catch (err) {
    console.warn("[YourAIGuard] Gate error:", err.message);
  }
}

function scanForResponses() {
  document.querySelectorAll('[data-message-author-role="assistant"]')
    .forEach(el => processResponse(el));
}

new MutationObserver(scanForResponses).observe(document.body, { childList: true, subtree: true });
scanForResponses();
