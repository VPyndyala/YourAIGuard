/**
 * YourAIGuard - Content Script
 *
 * Supports: ChatGPT (chatgpt.com, chat.openai.com)
 *
 * Flow:
 * 1. Detect a completed AI response
 * 2. Gate model: does this prompt need analysis?
 * 3. Score 7 reasoning criteria locally using MiniLM embeddings
 * 4. Compute temporal instability I_t across conversation history
 * 5. Show per-response criterion scores + temporal phase once ≥10 turns
 */

const INDICATOR_CLASS = "youraiguard-indicator";
const INDICATOR_ATTR  = "data-youraiguard-checked";

const RUNG_LABELS = [
  "C1 — Relevant to Prompt",
  "C2 — Directly Addresses Question",
  "C3 — Structured Reasoning",
  "C4 — Uses Justification",
  "C5 — Internally Consistent",
  "C6 — Acknowledges Uncertainty",
  "C7 — Sufficiently Complete",
];

const RUNG_SHORT = ["C1 Relevant", "C2 Direct", "C3 Structure", "C4 Justif.", "C5 Consistent", "C6 Uncertainty", "C7 Complete"];

// ─── Adapter ──────────────────────────────────────────────────────────────────
// Selectors may need updating as the ChatGPT UI changes.

const ADAPTER = {
    responseSelectors: ['[data-message-author-role="assistant"]'],
    isStreaming: el =>
      !!el.querySelector(".result-streaming, [data-testid='streaming-cursor']") ||
      el.textContent.trim().length === 0,
    getConversationId: () => {
      const m = window.location.pathname.match(/\/c\/([a-f0-9-]+)/i);
      return "chatgpt-" + (m ? m[1] : "default");
    },
    getUserPrompt: el => {
      let node = el;
      while (node) {
        let sib = node.previousElementSibling;
        while (sib) {
          if (sib.getAttribute("data-message-author-role") === "user") return sib.textContent.trim();
          const u = sib.querySelector('[data-message-author-role="user"]');
          if (u) return u.textContent.trim();
          sib = sib.previousElementSibling;
        }
        node = node.parentElement;
      }
      return null;
    },
    getMessageId: el => {
      // Walk up the tree — the search-step element may not carry data-message-id
      // directly, but its ancestor turn container will, giving a stable key shared
      // by both the search-step element and the final response element.
      let node = el;
      while (node) {
        const id = node.getAttribute("data-message-id");
        if (id) return id;
        node = node.parentElement;
      }
      return null;
    },
    getThinking: () => null,
    insertIndicator: (el, node) => el.parentNode.insertBefore(node, el.nextSibling),
};

// ─── Conversation ID ──────────────────────────────────────────────────────────

function getConversationId() {
  return ADAPTER.getConversationId();
}

// ─── UI ───────────────────────────────────────────────────────────────────────

const PHASE_CONFIG = {
  low:          { emoji: "🟢", label: "AI is reasoning clearly",        color: "#16a34a", bg: "#f0fdf4", border: "#bbf7d0" },
  intermediate: { emoji: "🟡", label: "AI reasoning is showing strain", color: "#d97706", bg: "#fffbeb", border: "#fde68a" },
  high:         { emoji: "🔴", label: "AI reasoning may be unreliable", color: "#dc2626", bg: "#fef2f2", border: "#fecaca" },
};

// ─── Sidecar ──────────────────────────────────────────────────────────────────

let _sidecar = null;

function getSidecar() {
  if (_sidecar) return _sidecar;

  const sc = document.createElement("div");
  sc.id = "yag-sidecar";
  sc.style.cssText = `
    position: fixed; top: 0; right: 0; height: 100vh; width: 380px;
    background: #fff; border-left: 1px solid #e5e7eb;
    box-shadow: -4px 0 24px rgba(0,0,0,0.10);
    z-index: 2147483647;
    display: flex; flex-direction: column;
    transform: translateX(100%);
    transition: transform 0.22s cubic-bezier(.4,0,.2,1);
    font-family: sans-serif;
  `;

  // Header
  const hdr = document.createElement("div");
  hdr.style.cssText = `
    display: flex; align-items: center; gap: 8px;
    padding: 12px 14px; border-bottom: 1px solid #e5e7eb;
    background: #f0fdf4; flex-shrink: 0;
  `;
  hdr.innerHTML = `
    <span style="font-size:18px">🛡️</span>
    <span style="font-size:12px;font-weight:700;color:#15803d;text-transform:uppercase;letter-spacing:.04em">YourAIGuard</span>
    <span style="color:#86efac">·</span>
    <span style="font-size:12px;color:#6b7280;font-weight:500">Conversation Timeline</span>
  `;

  const closeBtn = document.createElement("button");
  closeBtn.textContent = "✕";
  closeBtn.style.cssText = `
    margin-left: auto; background: none; border: none; cursor: pointer;
    font-size: 16px; color: #9ca3af; padding: 2px 4px; line-height: 1;
  `;
  closeBtn.onmouseenter = () => closeBtn.style.color = "#374151";
  closeBtn.onmouseleave = () => closeBtn.style.color = "#9ca3af";
  closeBtn.addEventListener("click", () => closeSidecar());
  hdr.appendChild(closeBtn);

  // Body
  const body = document.createElement("div");
  body.id = "yag-sidecar-body";
  body.style.cssText = "flex: 1; overflow: auto; padding: 16px 12px;";

  sc.appendChild(hdr);
  sc.appendChild(body);
  document.documentElement.appendChild(sc);
  _sidecar = sc;
  return sc;
}

function openSidecar(history, instability) {
  const sc   = getSidecar();
  const body = sc.querySelector("#yag-sidecar-body");

  // If already open showing same data, close it (toggle)
  if (sc.dataset.open === "1" && sc.dataset.convTurn === String(history.length)) {
    closeSidecar();
    return;
  }

  body.innerHTML = "";

  // Phase summary pill at top of sidecar
  if (instability?.phase) {
    const phase = PHASE_CONFIG[instability.phase];
    const pill  = document.createElement("div");
    pill.style.cssText = `
      display:inline-flex; align-items:center; gap:6px;
      padding:5px 10px; border-radius:20px; margin-bottom:14px;
      background:${phase.bg}; border:1px solid ${phase.border};
      font-size:12px; font-weight:600; color:${phase.color};
    `;
    const sLabel = instability.I != null && instability.phase !== "low"
      ? ` · I=${instability.I}`
      : "";
    pill.textContent = `${phase.emoji} ${phase.label}${sLabel} · turn ${instability.turns}`;
    body.appendChild(pill);
  }

  // SVG charts
  const wrap = document.createElement("div");
  wrap.style.cssText = "overflow-x: auto;";
  wrap.appendChild(buildTimelineSVG(history));
  body.appendChild(wrap);

  sc.dataset.open    = "1";
  sc.dataset.convTurn = String(history.length);
  sc.style.transform = "translateX(0)";
}

function closeSidecar() {
  if (!_sidecar) return;
  _sidecar.style.transform = "translateX(100%)";
  _sidecar.dataset.open    = "0";
}

// ─── Timeline SVG ─────────────────────────────────────────────────────────────

function buildTimelineSVG(history) {
  const N = history.length;

  const NS     = "http://www.w3.org/2000/svg";
  const STEP   = 20;
  const LPAD   = 56;
  const RPAD   = 8;
  const CONF_H = 50;
  const RUNG_H = 16;
  const GAP    = 4;
  const INST_H = 40;
  const XAXIS  = 16;

  const chartW = N * STEP;
  const totalW = LPAD + chartW + RPAD;
  const totalH = 14 + CONF_H + 10 + 7 * (RUNG_H + GAP) + 14 + INST_H + XAXIS;

  const mk = (tag, attrs = {}, text) => {
    const e = document.createElementNS(NS, tag);
    Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v));
    if (text !== undefined) e.textContent = text;
    return e;
  };

  const tip  = (node, text) => { node.appendChild(mk("title", {}, text)); return node; };
  const xAt  = i => LPAD + i * STEP + STEP / 2;

  const svg = mk("svg", { width: totalW, height: totalH });

  // ── Confidence line chart ──────────────────────────────────────────
  const confTop = 12;
  const confBot = confTop + CONF_H;

  svg.appendChild(mk("text", { x: LPAD, y: confTop - 2, "font-size": "9", fill: "#9ca3af" }, "Checks passed %"));

  [[0, "#e5e7eb", "0.5", ""], [60, "#fbbf24", "1", "3,3"], [100, "#e5e7eb", "0.5", ""]].forEach(([pct, stroke, sw, dash]) => {
    const y = confBot - (pct / 100) * CONF_H;
    const ln = mk("line", { x1: LPAD, y1: y, x2: LPAD + chartW, y2: y, stroke, "stroke-width": sw });
    if (dash) ln.setAttribute("stroke-dasharray", dash);
    svg.appendChild(ln);
    svg.appendChild(mk("text", { x: LPAD - 3, y: y + 3, "text-anchor": "end", "font-size": "8", fill: "#9ca3af" }, pct + "%"));
  });

  const areaPts = [`${xAt(0)},${confBot}`,
    ...history.map((h, i) => `${xAt(i)},${confBot - (h.confidence / 100) * CONF_H}`),
    `${xAt(N - 1)},${confBot}`].join(" ");
  svg.appendChild(mk("polygon", { points: areaPts, fill: "#dcfce7", opacity: "0.6" }));

  const linePts = history.map((h, i) => `${xAt(i)},${confBot - (h.confidence / 100) * CONF_H}`).join(" ");
  svg.appendChild(mk("polyline", { points: linePts, fill: "none", stroke: "#16a34a", "stroke-width": "1.5", "stroke-linejoin": "round" }));

  history.forEach((h, i) => {
    const cy = confBot - (h.confidence / 100) * CONF_H;
    tip(svg.appendChild(mk("circle", { cx: xAt(i), cy, r: "3", fill: h.confidence >= 60 ? "#16a34a" : "#ef4444" })),
      `q${i + 1}: ${h.confidence}% (${h.confidence >= 60 ? "pass" : "fail"})`);
  });

  // ── Rung tracks ────────────────────────────────────────────────────
  const RLABELS = ["C1 Relev.", "C2 Direct", "C3 Struct.", "C4 Justif.", "C5 Consist.", "C6 Uncert.", "C7 Complt."];
  const rungTop = confBot + 12;

  for (let k = 0; k < 7; k++) {
    const trackY = rungTop + k * (RUNG_H + GAP);
    const passY  = trackY + 3;
    const failY  = trackY + RUNG_H - 3;

    svg.appendChild(mk("text", { x: LPAD - 3, y: trackY + RUNG_H / 2 + 3, "text-anchor": "end", "font-size": "9", fill: "#6b7280" }, RLABELS[k]));
    svg.appendChild(mk("rect", { x: LPAD, y: trackY, width: chartW, height: RUNG_H, fill: "#f9fafb", rx: "2" }));

    const stepPts = history.map((h, i) => `${xAt(i)},${h.rungs[k] ? passY : failY}`).join(" ");
    svg.appendChild(mk("polyline", { points: stepPts, fill: "none", stroke: "#d1d5db", "stroke-width": "1", "stroke-dasharray": "2,2" }));

    history.forEach((h, i) => {
      const pass = h.rungs[k];
      tip(svg.appendChild(mk("circle", { cx: xAt(i), cy: pass ? passY : failY, r: "4", fill: pass ? "#16a34a" : "#ef4444" })),
        `q${i + 1}: ${pass ? "Pass" : "Fail"}`);
    });
  }

  // ── Instability I_t chart ──────────────────────────────────────────
  const instTop = rungTop + 7 * (RUNG_H + GAP) + 12;
  const instBot = instTop + INST_H;
  const S_MAX   = 1.5;

  svg.appendChild(mk("text", { x: LPAD, y: instTop - 2, "font-size": "9", fill: "#9ca3af" }, "Instability I_t"));
  svg.appendChild(mk("rect", { x: LPAD, y: instTop, width: chartW, height: INST_H, fill: "#f9fafb", rx: "2" }));

  [[0.4, "#fbbf24"], [1.0, "#ef4444"]].forEach(([val, stroke]) => {
    const y = instBot - (val / S_MAX) * INST_H;
    svg.appendChild(mk("line", { x1: LPAD, y1: y, x2: LPAD + chartW, y2: y, stroke, "stroke-width": "1", "stroke-dasharray": "3,3" }));
    svg.appendChild(mk("text", { x: LPAD - 3, y: y + 3, "text-anchor": "end", "font-size": "8", fill: stroke }, val));
  });

  const sPts = history.map((h, i) => h.s != null ? `${xAt(i)},${instBot - Math.min(h.s, S_MAX) / S_MAX * INST_H}` : null).filter(Boolean);
  if (sPts.length > 1) {
    svg.appendChild(mk("polyline", { points: sPts.join(" "), fill: "none", stroke: "#6366f1", "stroke-width": "1.5", "stroke-linejoin": "round" }));
  }

  history.forEach((h, i) => {
    if (h.s == null) return;
    const cy    = instBot - Math.min(h.s, S_MAX) / S_MAX * INST_H;
    // Color by Z state: 0=low→green, 1=intermediate→amber, 2=high→red
    const color = h.z === 2 ? "#ef4444" : h.z === 1 ? "#fbbf24" : "#16a34a";
    tip(svg.appendChild(mk("circle", { cx: xAt(i), cy, r: "3", fill: color })), `q${i+1}: I=${h.s}`);
  });

  // ── X-axis labels ──────────────────────────────────────────────────
  history.forEach((_, i) => {
    if (N <= 12 || i === 0 || (i + 1) % 5 === 0 || i === N - 1) {
      svg.appendChild(mk("text", { x: xAt(i), y: instBot + 11, "text-anchor": "middle", "font-size": "8", fill: "#9ca3af" }, `q${i + 1}`));
    }
  });

  return svg;
}

// ─── Indicator ────────────────────────────────────────────────────────────────

function createLoadingIndicator() {
  const el = document.createElement("div");
  el.className = INDICATOR_CLASS;
  el.style.cssText = `
    all:initial; box-sizing:border-box;
    display:flex !important; align-items:center; gap:8px;
    margin-top:10px; margin-bottom:4px; padding:8px 12px;
    background:#f0fdf4; border:1px solid #bbf7d0;
    border-radius:8px; font-family:sans-serif !important; width:fit-content;
  `;
  const shield = document.createElement("span");
  shield.textContent = "🛡️";
  shield.style.cssText = "all:initial;font-size:16px";
  const name = document.createElement("span");
  name.textContent = "YourAIGuard";
  name.style.cssText = "all:initial;font-size:12px;font-weight:700;color:#15803d;text-transform:uppercase;letter-spacing:.03em";
  const dot = document.createElement("span");
  dot.textContent = "·";
  dot.style.cssText = "all:initial;color:#86efac;font-size:14px";
  const status = document.createElement("span");
  status.textContent = "Checking response…";
  status.style.cssText = "all:initial;font-size:13px;color:#16a34a;font-weight:500";
  el.appendChild(shield); el.appendChild(name); el.appendChild(dot); el.appendChild(status);
  return el;
}

function createIndicator(confidence, scores, instability, history) {
  const hasPhase = instability?.phase !== null && instability?.phase !== undefined;
  const phase    = hasPhase ? PHASE_CONFIG[instability.phase] : null;
  const bg       = phase?.bg     ?? "#f0fdf4";
  const border   = phase?.border ?? "#bbf7d0";

  const el = document.createElement("div");
  el.className = INDICATOR_CLASS;
  el.style.cssText = `
    all:initial; box-sizing:border-box;
    display:block !important;
    margin-top:10px; margin-bottom:4px; padding:10px 14px;
    background:${bg}; border:1px solid ${border};
    border-radius:8px; font-family:sans-serif !important; width:fit-content; max-width:540px;
  `;

  // ── Header row ──
  const header = document.createElement("div");
  header.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap;";

  function mkSpan(text, css) {
    const s = document.createElement("span");
    s.textContent = text;
    if (css) s.style.cssText = css;
    return s;
  }

  header.appendChild(mkSpan("🛡️", "font-size:16px"));
  header.appendChild(mkSpan("YourAIGuard", "font-size:12px;font-weight:700;color:#15803d;text-transform:uppercase;letter-spacing:.03em"));
  header.appendChild(mkSpan("·", "color:#86efac;font-size:14px"));

  if (hasPhase) {
    const passed = scores.filter(s => s.pass).length;
    const showS  = instability.phase !== "low" && instability.I != null;
    const sMeta  = showS
      ? `— I=${instability.I} (${passed}/7 checks · turn ${instability.turns})`
      : `(${passed}/7 checks · turn ${instability.turns})`;

    // Phase emoji with optional upward transition indicator
    const phaseEmoji = instability.transition === "up"
      ? `${phase.emoji} ↑`
      : phase.emoji;

    header.appendChild(mkSpan(`${phaseEmoji} ${phase.label}`, `font-size:13px;font-weight:700;color:${phase.color}`));
    header.appendChild(mkSpan(sMeta, "font-size:11px;color:#9ca3af;"));
  } else {
    const turn = instability?.turns ?? 1;
    header.appendChild(mkSpan(`Calibrating — turn ${turn} of 10`, "font-size:13px;color:#16a34a;font-weight:500"));
  }

  // ── Sidecar toggle button (only after phase is established at turn 10) ──
  if (hasPhase && history?.length > 1) {
    const toggleBtn = document.createElement("button");
    toggleBtn.textContent = "📊";
    toggleBtn.title = "Open timeline";
    toggleBtn.style.cssText = `
      margin-left:auto; background:none; border:none; cursor:pointer;
      font-size:14px; padding:0 2px; opacity:0.6; line-height:1;
    `;
    toggleBtn.onmouseenter = () => toggleBtn.style.opacity = "1";
    toggleBtn.onmouseleave = () => toggleBtn.style.opacity = "0.6";
    toggleBtn.addEventListener("click", () => openSidecar(history, instability));
    header.appendChild(toggleBtn);
  }

  el.appendChild(header);

  if (!hasPhase) {
    // ── Calibrating: compact single criterion line ──
    const rungLine = document.createElement("div");
    rungLine.style.cssText = "font-size:12px;color:#6b7280;margin-top:2px;";
    rungLine.textContent = scores
      .map((s, i) => `${s.pass ? "✔" : "✖"} ${RUNG_SHORT[i]}`)
      .join("  ·  ");
    el.appendChild(rungLine);
  } else {
    // ── Phase active: warning banner + divider + full criterion rows ──
    if (instability.phase !== "low") {
      const banner = document.createElement("div");
      banner.style.cssText = `
        font-size:12px; color:${phase.color}; margin-bottom:8px;
        padding:4px 8px; background:${border}22; border-radius:4px;
      `;
      banner.textContent = instability.phase === "high"
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
      const check = document.createElement("span");
      check.textContent = score.pass ? "✔" : "✖";
      const label = document.createElement("span");
      label.textContent = RUNG_LABELS[i];
      row.appendChild(check);
      row.appendChild(label);
      el.appendChild(row);
    });
  }

  return el;
}

function insertIndicator(responseEl, node) {
  ADAPTER.insertIndicator(responseEl, node);
}

// ─── Core Analysis ────────────────────────────────────────────────────────────

async function runAnalysis(responseEl, userPrompt, baseText, thinking) {
  const loadingNode = createLoadingIndicator();
  insertIndicator(responseEl, loadingNode);

  try {
    const conversationId = getConversationId();
    const messageId      = ADAPTER.getMessageId(responseEl);

    const result = await Promise.race([
      browser.runtime.sendMessage({
        type: "analyze_response",
        data: { conversationId, messageId, prompt: userPrompt, base: baseText, thinking: thinking || null },
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Analysis timeout")), 30000)),
    ]);

    if (!result || result.notReady) throw new Error("Background not ready");

    if (result.cached) {
      loadingNode.remove();
      return;
    }

    loadingNode.replaceWith(createIndicator(result.confidence, result.scores, result.instability, result.history));

  } catch {
    loadingNode.remove();
    // Remove marker so the next scan can retry (e.g. background was still loading)
    responseEl.removeAttribute(INDICATOR_ATTR);
  }
}

// ─── Response Detection ───────────────────────────────────────────────────────

function isStreaming(responseEl) {
  return ADAPTER.isStreaming(responseEl);
}

async function processResponse(responseEl) {
  if (responseEl.hasAttribute(INDICATOR_ATTR)) return;
  if (isStreaming(responseEl)) return;

  const userPrompt = ADAPTER.getUserPrompt(responseEl) || "";
  const thinking   = ADAPTER.getThinking(responseEl);

  // For thinking models the outer div has only a few chars of textContent —
  // look inside for the prose/markdown container to get the actual response text.
  const proseEl  = responseEl.querySelector('[class*="prose"], [class*="markdown"], [class*="message-content"]') || responseEl;
  const baseText = proseEl.textContent.trim();

  if (baseText.length < 20) return;

  responseEl.setAttribute(INDICATOR_ATTR, "true");
  await runAnalysis(responseEl, userPrompt, baseText, thinking);
}

async function scanForResponses() {
  const seen = new Set();
  const elements = [];
  for (const sel of ADAPTER.responseSelectors) {
    document.querySelectorAll(sel).forEach(el => {
      if (!seen.has(el)) { seen.add(el); elements.push(el); }
    });
  }
  // Sort into DOM order so turns are processed and numbered correctly
  elements.sort((a, b) =>
    a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
  );
  // Keep only outermost matches — drop any element that is a descendant of
  // another element already in the list (prevents triple-indicators when a
  // selector matches both a container and its nested children).
  const outermost = elements.filter(el =>
    !elements.some(other => other !== el && other.contains(el))
  );
  for (const el of outermost) {
    await processResponse(el);
  }
}

// Debounce the scanner so rapid DOM bursts (streaming updates, search steps
// being injected, etc.) settle into a single scan pass before we process.
let _scanTimer = null;
function scheduleScan() {
  clearTimeout(_scanTimer);
  _scanTimer = setTimeout(scanForResponses, 300);
}

new MutationObserver(scheduleScan).observe(document.body, { childList: true, subtree: true });
scanForResponses();
