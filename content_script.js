/**
 * YourAIGuard - Content Script
 * Monitors ChatGPT responses and displays a confidence indicator
 * below each assistant message.
 */

const INDICATOR_CLASS = "youraiguard-indicator";
const INDICATOR_ATTR = "data-youraiguard-checked";

/**
 * Creates and returns a confidence indicator element.
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
 * Finds all assistant response containers on the page and
 * attaches a confidence indicator to any that don't have one yet.
 */
function attachIndicators() {
  // ChatGPT marks assistant messages with this attribute
  const responses = document.querySelectorAll(
    '[data-message-author-role="assistant"]'
  );

  responses.forEach((response) => {
    // Skip if we already labelled this response
    if (response.hasAttribute(INDICATOR_ATTR)) return;

    // Skip if the response is still streaming (no text content yet)
    const content = response.querySelector(".markdown, [class*='prose']");
    if (!content || content.textContent.trim().length === 0) return;

    // Mark it so we don't double-process
    response.setAttribute(INDICATOR_ATTR, "true");

    // Insert the indicator directly after the response container (not inside it)
    const indicator = createIndicator();
    response.parentNode.insertBefore(indicator, response.nextSibling);
  });
}

/**
 * Observes the chat container for new messages being added or updated.
 */
function startObserver() {
  const observer = new MutationObserver(() => {
    attachIndicators();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

// Run on page load and start watching for new responses
attachIndicators();
startObserver();
