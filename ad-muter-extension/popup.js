const toggle = document.getElementById("toggle");
const statusLabel = document.getElementById("statusLabel");
const statusText = document.getElementById("statusText");
const statusDot = document.getElementById("statusDot");
const muteLines = document.querySelectorAll(".mute-line");
const soundWaves = document.querySelectorAll(".sound-wave");

chrome.storage.local.get("enabled", ({ enabled }) => {
  const isEnabled = enabled !== false;
  toggle.checked = isEnabled;
  updateUI(isEnabled);
});

checkCurrentTabState();

toggle.addEventListener("change", () => {
  const isEnabled = toggle.checked;
  chrome.storage.local.set({ enabled: isEnabled });
  updateUI(isEnabled);
});

function updateUI(enabled) {
  statusLabel.textContent = enabled ? "Enabled" : "Disabled";

  if (enabled) {
    document.body.classList.remove("disabled");
    checkCurrentTabState();
  } else {
    document.body.classList.add("disabled");
    statusText.textContent = "Extension is off";
    statusDot.className = "status-dot";
    showSoundIcon(true);
  }
}

function checkCurrentTabState() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;

    const tab = tabs[0];
    if (tab.mutedInfo?.muted) {
      statusText.textContent = "Ad detected — tab muted";
      statusDot.className = "status-dot muted";
      showSoundIcon(false);
    } else {
      statusText.textContent = "Monitoring for ads...";
      statusDot.className = "status-dot active";
      showSoundIcon(true);
    }
  });
}

function showSoundIcon(sound) {
  muteLines.forEach((l) => (l.style.display = sound ? "none" : "block"));
  soundWaves.forEach((w) => (w.style.display = sound ? "block" : "none"));
}
