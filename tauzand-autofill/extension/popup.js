// popup.js

const profileIdInput = document.getElementById("profileId");
const saveBtn = document.getElementById("saveBtn");
const fillBtn = document.getElementById("fillBtn");
const statusEl = document.getElementById("status");

// Pre-fill the input with whatever profile_id is already saved.
chrome.storage.local.get("profile_id").then(({ profile_id: profileId }) => {
  if (profileId) profileIdInput.value = profileId;
});

saveBtn.addEventListener("click", async () => {
  const value = profileIdInput.value.trim();
  if (!value) {
    statusEl.textContent = "Enter a profile ID first.";
    return;
  }
  await chrome.storage.local.set({ profile_id: value });
  statusEl.textContent = "Saved.";
});

fillBtn.addEventListener("click", async () => {
  statusEl.textContent = "Filling...";
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab) {
    statusEl.textContent = "No active tab found.";
    return;
  }
  chrome.tabs.sendMessage(activeTab.id, { type: "RUN_AUTOFILL" }, (response) => {
    if (chrome.runtime.lastError) {
      statusEl.textContent = "This tab isn't a supported job site.";
      return;
    }
    if (response && response.success) {
      statusEl.textContent = "Done — check the page for results.";
    } else {
      statusEl.textContent = (response && response.error) || "Something went wrong.";
    }
  });
});
