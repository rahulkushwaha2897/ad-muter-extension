const State = {
  enabled: true,
  mutedTabs: new Set(),
  lastPixelTime: new Map(),
  lastAdDuration: new Map(),
  unmutePollers: new Map(),
};

const BUFFER_AFTER_AD_MS = 3000; // wait 3s after estimated ad end before unmuting
const POLL_INTERVAL_MS = 1500;
const MAX_MUTE_MS = 5 * 60 * 1000;
const safetyTimers = new Map();

console.log("[Ad Muter] Background service worker started");

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ enabled: true });
  console.log("[Ad Muter] Extension installed, enabled by default");
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.enabled) {
    State.enabled = changes.enabled.newValue;
    console.log("[Ad Muter] Enabled:", State.enabled);
    if (!State.enabled) unmuteAllTabs();
  }
});

// ---------------------------------------------------------------------------
// Parse ad duration from the tracking pixel's adName parameter.
// Examples from real IPL streams:
//   PR-26-020366_IPL26_TheBearS4_TBS4FAM30sNS_English_VCTA_30  → 30
//   PR-26-019706_IPL26_JurassicWorldRebirth_JWR15sReview..._VCTA_15  → 15
// The _VCTA_XX suffix is the most reliable indicator.
// ---------------------------------------------------------------------------

function extractAdDuration(adName) {
  // Prefer _VCTA_XX (always at the end of standard Hotstar ad names)
  const vctaMatch = adName.match(/[_]VCTA[_](\d+)$/i);
  if (vctaMatch) return parseInt(vctaMatch[1], 10);

  // XXs in the name (e.g. "30sNS", "20sEng", "15sHin")
  const sMatch = adName.match(/(\d{1,3})s(?:NS|Eng|Hin|Hindi|English|Tam|Tel|Kan|Mal|Ben|Mar)/i);
  if (sMatch) return parseInt(sMatch[1], 10);

  // LANG_XX_SPOT pattern (e.g. "HIN_10_SPOT", "ENG_15_SPOT")
  const spotMatch = adName.match(/(?:HIN|ENG|HINDI|ENGLISH|TAM|TEL|KAN|MAL)[_](\d{1,3})[_]/i);
  if (spotMatch) return parseInt(spotMatch[1], 10);

  // Any _XX_ where XX is a plausible ad duration (5-120s)
  const nums = [...adName.matchAll(/[_](\d{1,3})[_]/g)].map((m) => parseInt(m[1], 10));
  const plausible = nums.filter((n) => n >= 5 && n <= 120);
  if (plausible.length > 0) return plausible[plausible.length - 1];

  return 30;
}

// ---------------------------------------------------------------------------
// Hotstar tracking pixel interception
//
// Each ad in a break fires ONE pixel at its start. An ad break with 5 ads
// fires 5 pixels spaced ~15-30s apart. We must stay muted for the full break.
//
// Strategy:
//   - Mute on first pixel
//   - Track lastPixelTime + ad duration = earliest the current ad could end
//   - Only unmute when: (now > lastPixelTime + lastAdDuration + buffer)
//     AND no new pixel has arrived
// ---------------------------------------------------------------------------

chrome.webRequest.onBeforeRequest.addListener(
  async (details) => {
    if (!State.enabled) return;

    try {
      const url = new URL(details.url);
      const adName = url.searchParams.get("adName") || "(unknown)";
      const duration = extractAdDuration(adName);
      const now = Date.now();

      console.log(`[Ad Muter] Tracking pixel — ad: ${adName} (${duration}s)`);

      const tabs = await chrome.tabs.query({ url: ["*://*.hotstar.com/*", "*://*.jiohotstar.com/*"] });

      for (const tab of tabs) {
        State.lastPixelTime.set(tab.id, now);
        State.lastAdDuration.set(tab.id, duration);

        if (!State.mutedTabs.has(tab.id)) {
          muteTab(tab.id);
          ensureSafetyTimer(tab.id);
        }

        if (!State.unmutePollers.has(tab.id)) {
          startUnmutePoller(tab.id);
        }
      }
    } catch (e) {
      console.error("[Ad Muter] Error:", e);
    }
  },
  { urls: [
    "*://bifrost-api.hotstar.com/v1/events/track/ct_impression*",
    "*://bifrost-api.jiohotstar.com/v1/events/track/ct_impression*"
  ] }
);

// ---------------------------------------------------------------------------
// Unmute poller
// Only unmutes when enough time has passed since (lastPixel + adDuration).
// ---------------------------------------------------------------------------

function startUnmutePoller(tabId) {
  console.log(`[Ad Muter] Started unmute poller for tab ${tabId}`);

  const interval = setInterval(() => {
    const lastPixel = State.lastPixelTime.get(tabId) || 0;
    const adDuration = (State.lastAdDuration.get(tabId) || 30) * 1000;
    const now = Date.now();

    // Earliest the current ad could have ended
    const adEndTime = lastPixel + adDuration;
    // How long since the ad should have ended
    const silenceSinceAdEnd = now - adEndTime;

    if (silenceSinceAdEnd >= BUFFER_AFTER_AD_MS) {
      console.log(
        `[Ad Muter] Ad should have ended ${(silenceSinceAdEnd / 1000).toFixed(1)}s ago, ` +
        `no new pixel — ad break over`
      );
      clearInterval(interval);
      State.unmutePollers.delete(tabId);
      unmuteTab(tabId);
    }
  }, POLL_INTERVAL_MS);

  State.unmutePollers.set(tabId, interval);
}

// ---------------------------------------------------------------------------
// Safety net
// ---------------------------------------------------------------------------

function ensureSafetyTimer(tabId) {
  if (safetyTimers.has(tabId)) return;

  const timer = setTimeout(() => {
    safetyTimers.delete(tabId);
    if (State.mutedTabs.has(tabId)) {
      console.log(`[Ad Muter] Safety net — force unmuting tab ${tabId}`);
      unmuteTab(tabId);
    }
  }, MAX_MUTE_MS);

  safetyTimers.set(tabId, timer);
}

// ---------------------------------------------------------------------------
// Content script messages (for non-Hotstar platforms)
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!State.enabled) {
    sendResponse({ status: "disabled" });
    return;
  }

  const tabId = sender.tab?.id;
  if (!tabId) {
    sendResponse({ status: "no_tab" });
    return;
  }

  if (message.type === "AD_STARTED") {
    muteTab(tabId);
    ensureSafetyTimer(tabId);
    sendResponse({ status: "muted" });
  } else if (message.type === "AD_ENDED") {
    unmuteTab(tabId);
    sendResponse({ status: "unmuted" });
  } else if (message.type === "GET_STATE") {
    sendResponse({
      enabled: State.enabled,
      muted: State.mutedTabs.has(tabId),
    });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => cleanup(tabId));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function muteTab(tabId) {
  if (State.mutedTabs.has(tabId)) return;
  State.mutedTabs.add(tabId);
  chrome.tabs.update(tabId, { muted: true });
  updateBadge(tabId, true);
  console.log(`[Ad Muter] MUTED tab ${tabId}`);
}

function unmuteTab(tabId) {
  if (!State.mutedTabs.has(tabId)) return;
  State.mutedTabs.delete(tabId);
  chrome.tabs.update(tabId, { muted: false });
  updateBadge(tabId, false);
  clearSafetyTimer(tabId);
  console.log(`[Ad Muter] UNMUTED tab ${tabId}`);
}

function unmuteAllTabs() {
  for (const tabId of State.mutedTabs) {
    chrome.tabs.update(tabId, { muted: false }).catch(() => {});
    updateBadge(tabId, false);
  }
  State.mutedTabs.clear();
  for (const [, interval] of State.unmutePollers) clearInterval(interval);
  State.unmutePollers.clear();
  for (const [, timer] of safetyTimers) clearTimeout(timer);
  safetyTimers.clear();
  State.lastPixelTime.clear();
  State.lastAdDuration.clear();
}

function cleanup(tabId) {
  State.mutedTabs.delete(tabId);
  State.lastPixelTime.delete(tabId);
  State.lastAdDuration.delete(tabId);
  if (State.unmutePollers.has(tabId)) {
    clearInterval(State.unmutePollers.get(tabId));
    State.unmutePollers.delete(tabId);
  }
  clearSafetyTimer(tabId);
}

function clearSafetyTimer(tabId) {
  if (safetyTimers.has(tabId)) {
    clearTimeout(safetyTimers.get(tabId));
    safetyTimers.delete(tabId);
  }
}

function updateBadge(tabId, isMuted) {
  if (isMuted) {
    chrome.action.setBadgeText({ text: "AD", tabId });
    chrome.action.setBadgeBackgroundColor({ color: "#e74c3c", tabId });
  } else {
    chrome.action.setBadgeText({ text: "", tabId });
  }
}
