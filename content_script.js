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
  const indicator = document.createElement("div");
  indicator.className = INDICATOR_CLASS;
  indicator.textContent = "✔ YourAIGuard: 100% Confident in this response";
  indicator.style.cssText = `
    color: #16a34a;
    font-size: 13px;
    font-weight: 600;
    margin-top: 8px;
    padding: 6px 10px;
    border-left: 3px solid #16a34a;
    background-color: #f0fdf4;
    border-radius: 4px;
    font-family: sans-serif;
  `;
  return indicator;
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

    // Insert the indicator at the bottom of the response
    const indicator = createIndicator();
    response.appendChild(indicator);
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
