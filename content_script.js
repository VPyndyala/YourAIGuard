/**
 * YourAIGuard - Content Script
 *
 * Flow:
 * 1. Detect a completed ChatGPT response
 * 2. Gate model: does this prompt need analysis?
 * 3. If yes: score 5 rungs locally (cosine similarity, no API call)
 * 4. Compute temporal instability S_t across conversation history
 * 5. Show per-response rung scores + temporal phase once ≥10 turns
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

const RUNG_SHORT = ["R1 Risk", "R2 Facts", "R3 Adversarial", "R4 Stakeholder", "R5 Revision"];

// ─── Conversation ID ──────────────────────────────────────────────────────────

function getConversationId() {
  const match = window.location.pathname.match(/\/c\/([a-f0-9-]+)/i);
  return match ? match[1] : "default";
}

// ─── UI ───────────────────────────────────────────────────────────────────────

const PHASE_CONFIG = {
  stable:   { emoji: "🟢", label: "AI is reasoning clearly",        color: "#16a34a", bg: "#f0fdf4", border: "#bbf7d0" },
  warning:  { emoji: "🟡", label: "AI reasoning is showing strain", color: "#d97706", bg: "#fffbeb", border: "#fde68a" },
  unstable: { emoji: "🔴", label: "AI reasoning may be unreliable", color: "#dc2626", bg: "#fef2f2", border: "#fecaca" },
};

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
    <span style="font-size:13px;color:#16a34a;font-weight:500">Checking response…</span>
  `;
  return el;
}

function createTimelinePanel(history, border) {
  const panel = document.createElement("div");
  panel.style.cssText = `
    display:none; margin-top:10px; padding-top:10px;
    border-top:1px solid ${border};
  `;

  const RUNG_TIMELINE_LABELS = ["R1 Risk", "R2 Facts", "R3 Advers.", "R4 Stakeh.", "R5 Revision"];

  // ── Rung dot grid ──
  for (let k = 0; k < 5; k++) {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:4px;margin-bottom:5px;";

    const label = document.createElement("span");
    label.style.cssText = "font-size:10px;color:#6b7280;width:72px;flex-shrink:0;";
    label.textContent = RUNG_TIMELINE_LABELS[k];
    row.appendChild(label);

    const dots = document.createElement("div");
    dots.style.cssText = "display:flex;gap:3px;align-items:center;flex-wrap:wrap;";
    history.forEach(h => {
      const dot = document.createElement("span");
      dot.style.cssText = `
        display:inline-block; width:9px; height:9px; border-radius:50%;
        background:${h.rungs[k] ? "#16a34a" : "#ef4444"};
        flex-shrink:0;
      `;
      dots.appendChild(dot);
    });
    row.appendChild(dots);
    panel.appendChild(row);
  }

  // ── Confidence bar chart ──
  const chartLabel = document.createElement("div");
  chartLabel.style.cssText = "font-size:10px;color:#6b7280;margin-top:10px;margin-bottom:4px;";
  chartLabel.textContent = "Confidence per turn";
  panel.appendChild(chartLabel);

  const chart = document.createElement("div");
  chart.style.cssText = "display:flex;align-items:flex-end;gap:3px;height:36px;";
  history.forEach(h => {
    const bar = document.createElement("div");
    bar.style.cssText = `
      width:9px; min-height:2px; height:${Math.round(h.confidence * 0.36)}px;
      border-radius:2px 2px 0 0; flex-shrink:0;
      background:${h.confidence >= 60 ? "#16a34a" : "#ef4444"};
    `;
    bar.title = `${h.confidence}%`;
    chart.appendChild(bar);
  });
  panel.appendChild(chart);

  return panel;
}

function createIndicator(confidence, scores, instability, history) {
  const hasPhase = instability?.phase !== null && instability?.phase !== undefined;
  const phase    = hasPhase ? PHASE_CONFIG[instability.phase] : null;
  const bg       = phase?.bg     ?? "#f0fdf4";
  const border   = phase?.border ?? "#bbf7d0";

  const el = document.createElement("div");
  el.className = INDICATOR_CLASS;
  el.style.cssText = `
    margin-top:10px; margin-bottom:4px; padding:10px 14px;
    background:${bg}; border:1px solid ${border};
    border-radius:8px; font-family:sans-serif; width:fit-content; max-width:540px;
  `;

  // ── Header row ──
  const header = document.createElement("div");
  header.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap;";

  let headerHTML = `
    <span style="font-size:16px">🛡️</span>
    <span style="font-size:12px;font-weight:700;color:#15803d;text-transform:uppercase;letter-spacing:.03em">YourAIGuard</span>
    <span style="color:#86efac;font-size:14px">·</span>
  `;

  if (hasPhase) {
    const passed = scores.filter(s => s.pass).length;
    headerHTML += `
      <span style="font-size:13px;font-weight:700;color:${phase.color}">${phase.emoji} ${phase.label}</span>
      <span style="font-size:11px;color:#9ca3af;">(${passed}/5 checks · turn ${instability.turns})</span>
    `;
  } else {
    const turn = (instability?.turns ?? 0) + 1;
    headerHTML += `
      <span style="font-size:13px;color:#16a34a;font-weight:500">Calibrating — turn ${turn} of 10</span>
    `;
  }

  // ── Timeline toggle button (shown if we have history) ──
  if (history?.length > 1) {
    const toggleBtn = document.createElement("button");
    toggleBtn.textContent = "📊";
    toggleBtn.title = "Toggle timeline";
    toggleBtn.style.cssText = `
      margin-left:auto; background:none; border:none; cursor:pointer;
      font-size:14px; padding:0 2px; opacity:0.6; line-height:1;
    `;
    toggleBtn.onmouseenter = () => toggleBtn.style.opacity = "1";
    toggleBtn.onmouseleave = () => toggleBtn.style.opacity = "0.6";
    header.innerHTML = headerHTML;
    header.appendChild(toggleBtn);
    el.appendChild(header);

    const timeline = createTimelinePanel(history, border);
    el.appendChild(timeline);
    toggleBtn.addEventListener("click", () => {
      const visible = timeline.style.display !== "none";
      timeline.style.display = visible ? "none" : "block";
    });
  } else {
    header.innerHTML = headerHTML;
    el.appendChild(header);
  }

  if (!hasPhase) {
    // ── Calibrating: compact single rung line ──
    const rungLine = document.createElement("div");
    rungLine.style.cssText = "font-size:12px;color:#6b7280;margin-top:2px;";
    rungLine.textContent = scores
      .map((s, i) => `${s.pass ? "✔" : "✖"} ${RUNG_SHORT[i]}`)
      .join("  ·  ");
    el.appendChild(rungLine);
  } else {
    // ── Phase active: warning banner + divider + full rung rows ──
    if (instability.phase !== "stable") {
      const banner = document.createElement("div");
      banner.style.cssText = `
        font-size:12px; color:${phase.color}; margin-bottom:8px;
        padding:4px 8px; background:${border}22; border-radius:4px;
      `;
      banner.textContent = instability.phase === "unstable"
        ? "⚠ The AI has been making reasoning errors recently — treat its next responses with extra caution"
        : "⚠ The AI's reasoning quality has been slipping — double-check important claims";
      el.appendChild(banner);
    }

    const hr = document.createElement("hr");
    hr.style.cssText = "border:none;border-top:1px solid " + border + ";margin:0 0 8px 0;";
    el.appendChild(hr);

    scores.forEach((score, i) => {
      const row = document.createElement("div");
      row.style.cssText = `display:flex;align-items:center;gap:6px;font-size:12px;margin-bottom:4px;color:${score.pass ? '#16a34a' : '#dc2626'};`;
      row.innerHTML = `<span>${score.pass ? "✔" : "✖"}</span><span>${RUNG_LABELS[i]}</span>`;
      el.appendChild(row);
    });
  }

  return el;
}

function insertIndicator(responseEl, node) {
  responseEl.parentNode.insertBefore(node, responseEl.nextSibling);
}

// ─── Core Analysis ────────────────────────────────────────────────────────────

async function runAnalysis(responseEl, userPrompt, baseText) {
  const loadingNode = createLoadingIndicator();
  insertIndicator(responseEl, loadingNode);

  try {
    const conversationId = getConversationId();
    const messageId      = responseEl.getAttribute("data-message-id") || null;

    const result = await Promise.race([
      browser.runtime.sendMessage({
        type: "analyze_response",
        data: { conversationId, messageId, prompt: userPrompt, base: baseText },
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Analysis timeout")), 30000)),
    ]);

    if (!result) throw new Error("No result from background");

    // Cached result (SPA re-scan): no scores to show, just remove loading node
    if (result.cached) {
      loadingNode.remove();
      return;
    }

    loadingNode.replaceWith(createIndicator(result.confidence, result.scores, result.instability, result.history));

  } catch {
    loadingNode.remove();
  }
}

// ─── Response Detection ───────────────────────────────────────────────────────

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

    if (gateResult?.needsCheck) {
      await runAnalysis(responseEl, userPrompt, baseText);
    }
  } catch {
    // gate unavailable, skip silently
  }
}

function scanForResponses() {
  document.querySelectorAll('[data-message-author-role="assistant"]')
    .forEach(el => processResponse(el));
}

new MutationObserver(scanForResponses).observe(document.body, { childList: true, subtree: true });
scanForResponses();
