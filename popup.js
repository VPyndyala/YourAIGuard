const input  = document.getElementById("apiKey");
const btn    = document.getElementById("saveBtn");
const status = document.getElementById("status");

// Load saved key on open (show masked)
browser.storage.local.get("openaiApiKey").then(({ openaiApiKey }) => {
  if (openaiApiKey) {
    input.placeholder = "sk-…" + openaiApiKey.slice(-4);
    status.textContent = "✔ Key saved";
  }
});

btn.addEventListener("click", async () => {
  const key = input.value.trim();
  if (!key.startsWith("sk-")) {
    status.textContent = "Key must start with sk-";
    status.className = "error";
    return;
  }
  await browser.storage.local.set({ openaiApiKey: key });
  input.value = "";
  input.placeholder = "sk-…" + key.slice(-4);
  status.textContent = "✔ Key saved";
  status.className = "";
});
