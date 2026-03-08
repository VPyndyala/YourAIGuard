/**
 * YourAIGuard - Content Script
 * Monitors ChatGPT for completed assistant responses.
 * Extracts the user prompt that triggered each response,
 * runs it through the gate model, and shows a confidence
 * indicator only when the prompt involves reasoning.
 */

const INDICATOR_CLASS = "youraiguard-indicator";
const INDICATOR_ATTR = "data-youraiguard-checked";

/**
 * Creates the YourAIGuard confidence indicator element.
 */
function createIndicator() {
  const wrapper = document.createElement("div");
  wrapper.className = INDICATOR_CLASS;
  wrapper.style.cssText = `
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 10px;
    margin-bottom: 4px;
    padding: 8px 12px;
    background-color: #f0fdf4;
    border: 1px solid #bbf7d0;
    border-radius: 8px;
    font-family: sans-serif;
    width: fit-content;
    max-width: 100%;
  `;

  const shield = document.createElement("span");
  shield.textContent = "🛡️";
  shield.style.fontSize = "16px";

  const label = document.createElement("span");
  label.style.cssText = `
    font-size: 12px;
    font-weight: 700;
    color: #15803d;
    letter-spacing: 0.03em;
    text-transform: uppercase;
  `;
  label.textContent = "YourAIGuard";

  const divider = document.createElement("span");
  divider.textContent = "·";
  divider.style.cssText = "color: #86efac; font-size: 14px;";

  const message = document.createElement("span");
  message.style.cssText = `
    font-size: 13px;
    font-weight: 500;
    color: #16a34a;
  `;
  message.textContent = "100% Confident in this response ✔";

  wrapper.appendChild(shield);
  wrapper.appendChild(label);
  wrapper.appendChild(divider);
  wrapper.appendChild(message);

  return wrapper;
}

/**
 * Given an assistant message element, finds the user prompt
 * that immediately preceded it in the conversation.
 */
function getPrecedingUserPrompt(assistantEl) {
  // Walk up to the message container, then look for the previous user message
  let node = assistantEl.parentElement;
  while (node) {
    const prev = node.previousElementSibling;
    if (prev) {
      const userMsg = prev.querySelector('[data-message-author-role="user"]');
      if (userMsg) {
        return userMsg.textContent.trim();
      }
    }
    node = node.parentElement;
  }
  return null;
}

/**
 * Checks if a response is still streaming by looking for
 * the animated cursor or empty content.
 */
function isStreaming(responseEl) {
  const content = responseEl.querySelector(".markdown, [class*='prose']");
  if (!content || content.textContent.trim().length === 0) return true;
  // ChatGPT adds a streaming cursor element while generating
  if (responseEl.querySelector(".result-streaming, [data-testid='streaming-cursor']")) return true;
  return false;
}

/**
 * Processes a single assistant response element:
 * - Extracts preceding user prompt
 * - Sends to gate model via background
 * - Inserts indicator if gate says it needs a check
 */
async function processResponse(responseEl) {
  if (responseEl.hasAttribute(INDICATOR_ATTR)) return;
  if (isStreaming(responseEl)) return;

  // Mark immediately to prevent double-processing
  responseEl.setAttribute(INDICATOR_ATTR, "true");

  const userPrompt = getPrecedingUserPrompt(responseEl);

  // If we can't find the prompt, default to showing the indicator (safe fallback)
  if (!userPrompt) {
    insertIndicator(responseEl);
    return;
  }

  try {
    const result = await browser.runtime.sendMessage({
      type: "classify_prompt",
      prompt: userPrompt,
    });

    if (result && result.needsCheck) {
      insertIndicator(responseEl);
    }
  } catch (err) {
    // If gate fails for any reason, show indicator (safe fallback)
    insertIndicator(responseEl);
  }
}

/**
 * Inserts the indicator directly after the response container.
 */
function insertIndicator(responseEl) {
  // Avoid duplicates
  if (responseEl.nextElementSibling?.classList.contains(INDICATOR_CLASS)) return;
  const indicator = createIndicator();
  responseEl.parentNode.insertBefore(indicator, responseEl.nextSibling);
}

/**
 * Scans the page for new completed assistant responses.
 */
function scanForResponses() {
  const responses = document.querySelectorAll(
    '[data-message-author-role="assistant"]'
  );
  responses.forEach((el) => processResponse(el));
}

/**
 * Watches for DOM changes (new messages being added or streaming finishing).
 */
function startObserver() {
  const observer = new MutationObserver(() => {
    scanForResponses();
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

// Kick off
scanForResponses();
startObserver();
