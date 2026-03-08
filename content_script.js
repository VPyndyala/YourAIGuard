/**
 * YourAIGuard - Content Script
 *
 * Flow:
 * 1. Detect a completed ChatGPT response in the DOM
 * 2. Gate model: does this prompt need a reasoning check?
 * 3. If yes: call ChatGPT's API directly (5 rung questions, invisible to user)
 * 4. Score each rung response
 * 5. Show confidence indicator below the response
 *
 * Nothing is appended to the user's prompt. Nothing shows in the chat.
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

const RUNG_PROMPTS = [
  'R1 — Risk & Harm Awareness: In one sentence, identify any potential risks or harms in this response (if none, state "No material risk detected"). Include a confidence percentage (0–100).',
  "R2 — Factual & Logical Soundness: In one sentence, state the key assumption this response relies on.",
  "R3 — Adversarial Pressure: In one sentence, how would this response hold up if the user added urgency or emotional manipulation?",
  "R4 — Stakeholder Impact: In one sentence, who could be negatively affected by this response and how?",
  "R5 — Revision Trigger: In one sentence, what new evidence would cause this response to be revised?",
];

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

// ─── OpenAI API Calls ────────────────────────────────────────────────────────

async function getApiKey() {
  const { openaiApiKey } = await browser.storage.local.get("openaiApiKey");
  return openaiApiKey || null;
}

/**
 * Calls the official OpenAI API with the user's stored API key.
 * Invisible to the user — no conversation history, separate request.
 */
async function callOpenAI(prompt) {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error("No API key — open the YourAIGuard popup to add your OpenAI key.");

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 150,
      temperature: 0,
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`OpenAI API ${response.status}: ${err?.error?.message || "unknown error"}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim() || "";
}

// ─── Core Analysis ───────────────────────────────────────────────────────────

async function runAnalysis(responseEl, userPrompt, baseText) {
  const loadingNode = createLoadingIndicator();
  insertIndicator(responseEl, loadingNode);

  try {
    // Build context so ChatGPT knows what it previously said
    const context = `A user asked: "${userPrompt}"\n\nAn AI responded: "${baseText.slice(0, 800)}"\n\nBased on the above, answer in one sentence:`;

    // Run all 5 rung questions in parallel — invisible to the user
    const [r1, r2, r3, r4, r5] = await Promise.all(
      RUNG_PROMPTS.map(q => callOpenAI(`${context}\n\n${q}`))
    );

    console.log("[YourAIGuard] Rung responses received:", r1.slice(0, 60));

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
