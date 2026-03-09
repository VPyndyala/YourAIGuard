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
  panel.style.cssText = `display:none; margin-top:10px; padding-top:10px; border-top:1px solid ${border};`;

  const N = history.length;
  if (N < 2) return panel;

  const NS     = "http://www.w3.org/2000/svg";
  const STEP   = 20;   // px per turn
  const LPAD   = 60;   // left label column
  const RPAD   = 8;
  const CONF_H = 50;   // confidence chart height
  const RUNG_H = 16;   // per-rung track height
  const GAP    = 4;    // gap between rung tracks
  const XAXIS  = 16;   // x-axis label height

  const chartW = N * STEP;
  const totalW = LPAD + chartW + RPAD;
  const totalH = 14 + CONF_H + 10 + 5 * (RUNG_H + GAP) + XAXIS;

  const mk = (tag, attrs = {}, text) => {
    const e = document.createElementNS(NS, tag);
    Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v));
    if (text !== undefined) e.textContent = text;
    return e;
  };

  const tip = (node, text) => { node.appendChild(mk("title", {}, text)); return node; };
  const xAt = i => LPAD + i * STEP + STEP / 2;

  const wrap = document.createElement("div");
  wrap.style.cssText = "overflow-x:auto;";

  const svg = mk("svg", { width: totalW, height: totalH });

  // ── Confidence line chart ─────────────────────────────────────────
  const confTop = 12;
  const confBot = confTop + CONF_H;

  // Section label
  svg.appendChild(mk("text", { x: LPAD, y: confTop - 2, "font-size": "9", fill: "#9ca3af" }, "Checks passed %"));

  // Gridlines at 0 / 60 / 100
  [[0, "#e5e7eb", "0.5", ""], [60, "#fbbf24", "1", "3,3"], [100, "#e5e7eb", "0.5", ""]].forEach(([pct, stroke, sw, dash]) => {
    const y = confBot - (pct / 100) * CONF_H;
    const line = mk("line", { x1: LPAD, y1: y, x2: LPAD + chartW, y2: y, stroke, "stroke-width": sw });
    if (dash) line.setAttribute("stroke-dasharray", dash);
    svg.appendChild(line);
    svg.appendChild(mk("text", { x: LPAD - 3, y: y + 3, "text-anchor": "end", "font-size": "8", fill: "#9ca3af" }, pct + "%"));
  });

  // Area fill under confidence line
  const areaPts = [`${xAt(0)},${confBot}`,
    ...history.map((h, i) => `${xAt(i)},${confBot - (h.confidence / 100) * CONF_H}`),
    `${xAt(N - 1)},${confBot}`].join(" ");
  svg.appendChild(mk("polygon", { points: areaPts, fill: "#dcfce7", opacity: "0.6" }));

  // Confidence polyline
  const linePts = history.map((h, i) => `${xAt(i)},${confBot - (h.confidence / 100) * CONF_H}`).join(" ");
  svg.appendChild(mk("polyline", { points: linePts, fill: "none", stroke: "#16a34a", "stroke-width": "1.5", "stroke-linejoin": "round" }));

  // Confidence dots
  history.forEach((h, i) => {
    const cy = confBot - (h.confidence / 100) * CONF_H;
    tip(svg.appendChild(mk("circle", { cx: xAt(i), cy, r: "3", fill: h.confidence >= 60 ? "#16a34a" : "#ef4444" })),
      `q${i + 1}: ${h.confidence}% (${h.confidence >= 60 ? "pass" : "fail"})`);
  });

  // ── Rung tracks ───────────────────────────────────────────────────
  const RLABELS = ["R1 Risk", "R2 Facts", "R3 Advers.", "R4 Stakeh.", "R5 Rev."];
  const rungTop = confBot + 12;

  for (let k = 0; k < 5; k++) {
    const trackY = rungTop + k * (RUNG_H + GAP);
    const passY  = trackY + 3;
    const failY  = trackY + RUNG_H - 3;

    svg.appendChild(mk("text", { x: LPAD - 3, y: trackY + RUNG_H / 2 + 3, "text-anchor": "end", "font-size": "9", fill: "#6b7280" }, RLABELS[k]));
    svg.appendChild(mk("rect", { x: LPAD, y: trackY, width: chartW, height: RUNG_H, fill: "#f9fafb", rx: "2" }));

    // Dashed step guide
    const stepPts = history.map((h, i) => `${xAt(i)},${h.rungs[k] ? passY : failY}`).join(" ");
    svg.appendChild(mk("polyline", { points: stepPts, fill: "none", stroke: "#d1d5db", "stroke-width": "1", "stroke-dasharray": "2,2" }));

    // Dots
    history.forEach((h, i) => {
      const pass = h.rungs[k];
      tip(svg.appendChild(mk("circle", { cx: xAt(i), cy: pass ? passY : failY, r: "4", fill: pass ? "#16a34a" : "#ef4444" })),
        `q${i + 1}: ${pass ? "Pass" : "Fail"}`);
    });
  }

  // ── X-axis labels ─────────────────────────────────────────────────
  history.forEach((_, i) => {
    if (N <= 12 || i === 0 || (i + 1) % 5 === 0 || i === N - 1) {
      svg.appendChild(mk("text", { x: xAt(i), y: rungTop + 5 * (RUNG_H + GAP) + 11, "text-anchor": "middle", "font-size": "8", fill: "#9ca3af" }, `q${i + 1}`));
    }
  });

  wrap.appendChild(svg);
  panel.appendChild(wrap);
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

  // ── Timeline toggle button (only shown after phase is established at turn 10) ──
  if (hasPhase && history?.length > 1) {
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
