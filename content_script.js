/**
 * YourAIGuard - Content Script
 *
 * Flow:
 * 1. User submits a prompt → we intercept it
 * 2. Gate model: does this prompt need a reasoning check?
 * 3. If yes: append the 5 rung questions to the prompt before it's sent
 * 4. ChatGPT responds with main answer + 5 rung answers in one message
 * 5. Parse the rung answers, score them, show confidence indicator
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

// Appended to the user's prompt when gate opens.
// Uses clear labels so we can parse them out of the response.
const RUNG_SUFFIX = `

---
After your main response, on separate lines, add exactly these five one-sentence analyses using these exact labels:
R1_GUARD: [Risk or harm in this response — include a confidence % if applicable]
R2_GUARD: [Key factual assumption your answer relies on]
R3_GUARD: [How you would respond if the user added urgency or emotional pressure]
R4_GUARD: [Who could be negatively affected by your response and how]
R5_GUARD: [What new evidence would cause you to revise your answer]`;

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
    <span style="font-size:14px;font-weight:700;color:${confidence >= 60 ? '#16a34a' : '#dc2626'}">
      ${confidence}% Confident
    </span>
  `;
  el.appendChild(header);

  const divider = document.createElement("hr");
  divider.style.cssText = "border:none;border-top:1px solid #bbf7d0;margin:0 0 8px 0;";
  el.appendChild(divider);

  scores.forEach((score, i) => {
    const row = document.createElement("div");
    row.style.cssText = `
      display:flex; align-items:center; gap:6px; font-size:12px; margin-bottom:4px;
      color:${score.pass ? '#16a34a' : '#dc2626'};
    `;
    row.innerHTML = `<span>${score.pass ? '✔' : '✖'}</span><span>${RUNG_LABELS[i]}</span>`;
    el.appendChild(row);
  });

  return el;
}

function insertIndicator(responseEl, node) {
  responseEl.parentNode.insertBefore(node, responseEl.nextSibling);
}

// ─── Prompt Interception ─────────────────────────────────────────────────────

let guardActive = false; // prevents re-entry when we re-trigger submit

function getChatInput() {
  return (
    document.querySelector("#prompt-textarea") ||
    document.querySelector('[contenteditable="true"][data-id]') ||
    document.querySelector('form [contenteditable="true"]')
  );
}

function getInputText(el) {
  return el?.textContent?.trim() || "";
}

function setInputText(el, text) {
  el.focus();
  document.execCommand("selectAll", false, null);
  document.execCommand("insertText", false, text);
}

function findSubmitButton() {
  const candidates = document.querySelectorAll("button");
  for (const btn of candidates) {
    const label = (btn.getAttribute("aria-label") || "").toLowerCase();
    const testId = btn.getAttribute("data-testid") || "";
    if (
      testId === "send-button" ||
      label.includes("send") ||
      testId.includes("send")
    ) {
      return btn;
    }
  }
  return null;
}

// Intercept Enter key in the input box
document.addEventListener("keydown", async (e) => {
  if (guardActive) return;
  if (e.key !== "Enter" || e.shiftKey) return;

  const input = e.target.closest('[contenteditable="true"]');
  if (!input) return;

  const userPrompt = getInputText(input);
  if (!userPrompt) return;

  e.preventDefault();
  e.stopImmediatePropagation();

  await maybeAppendRungs(input, userPrompt);

  // Re-trigger submit
  guardActive = true;
  const btn = findSubmitButton();
  if (btn) {
    btn.click();
  } else {
    // Fallback: simulate Enter
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  }
  guardActive = false;
}, true);

// Intercept send button click
document.addEventListener("click", async (e) => {
  if (guardActive) return;

  const btn = e.target.closest("button");
  if (!btn) return;

  const label = (btn.getAttribute("aria-label") || "").toLowerCase();
  const testId = btn.getAttribute("data-testid") || "";
  const isSendBtn = testId === "send-button" || label.includes("send") || testId.includes("send");
  if (!isSendBtn) return;

  const input = getChatInput();
  const userPrompt = getInputText(input);
  if (!userPrompt) return;

  e.preventDefault();
  e.stopImmediatePropagation();

  await maybeAppendRungs(input, userPrompt);

  guardActive = true;
  btn.click();
  guardActive = false;
}, true);

/**
 * Runs the gate on the user's prompt.
 * If it needs a reasoning check, appends the rung instructions to the input.
 */
async function maybeAppendRungs(input, userPrompt) {
  try {
    const gateResult = await Promise.race([
      browser.runtime.sendMessage({ type: "classify_prompt", prompt: userPrompt }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Gate timeout")), 10000)),
    ]);

    console.log("[YourAIGuard] Gate:", gateResult?.needsCheck, "proba:", gateResult?.proba?.toFixed(3));

    if (gateResult?.needsCheck) {
      setInputText(input, userPrompt + RUNG_SUFFIX);
      await new Promise(r => setTimeout(r, 200)); // let React update
    }
  } catch (err) {
    console.warn("[YourAIGuard] Gate check failed:", err.message);
    // Submit original prompt unmodified
  }
}

// ─── Response Parsing & Scoring ──────────────────────────────────────────────

/**
 * Extracts R1_GUARD … R5_GUARD sections from the assistant's response text.
 * Returns { base, r1, r2, r3, r4, r5 } or null if no rung markers found.
 */
function parseRungResponse(text) {
  const keys = ["R1_GUARD", "R2_GUARD", "R3_GUARD", "R4_GUARD", "R5_GUARD"];
  const results = {};
  let found = 0;

  for (const key of keys) {
    const regex = new RegExp(`${key}:\\s*(.+?)(?=R\\d_GUARD:|$)`, "si");
    const match = text.match(regex);
    if (match) {
      results[key] = match[1].trim();
      found++;
    }
  }

  if (found < 3) return null; // not enough markers — prompt wasn't modified

  const firstMarkerIdx = text.search(/R1_GUARD:/i);
  const base = firstMarkerIdx > 0 ? text.slice(0, firstMarkerIdx).trim() : text;

  return {
    base,
    r1: results["R1_GUARD"] || "",
    r2: results["R2_GUARD"] || "",
    r3: results["R3_GUARD"] || "",
    r4: results["R4_GUARD"] || "",
    r5: results["R5_GUARD"] || "",
  };
}

async function analyzeResponse(responseEl, userPrompt, fullText) {
  const loadingNode = createLoadingIndicator();
  insertIndicator(responseEl, loadingNode);

  try {
    const parsed = parseRungResponse(fullText);
    if (!parsed) throw new Error("No rung markers in response");

    console.log("[YourAIGuard] Parsed rungs — R1:", parsed.r1.slice(0, 60));

    const result = await Promise.race([
      browser.runtime.sendMessage({
        type: "score_rungs",
        data: {
          prompt: userPrompt,
          base: parsed.base,
          r1: parsed.r1,
          r2: parsed.r2,
          r3: parsed.r3,
          r4: parsed.r4,
          r5: parsed.r5,
        },
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

  const fullText   = responseEl.textContent.trim();
  const userPrompt = getPrecedingUserPrompt(responseEl);

  if (!userPrompt) return;

  // Only analyze if the response contains our rung markers
  if (!fullText.includes("R1_GUARD:")) return;

  // Strip the rung suffix from what we show as "userPrompt" for scoring
  const cleanPrompt = userPrompt.replace(/\n---\nAfter your main response[\s\S]*/i, "").trim();

  await analyzeResponse(responseEl, cleanPrompt, fullText);
}

function scanForResponses() {
  document.querySelectorAll('[data-message-author-role="assistant"]')
    .forEach(el => processResponse(el));
}

new MutationObserver(scanForResponses).observe(document.body, { childList: true, subtree: true });
scanForResponses();
