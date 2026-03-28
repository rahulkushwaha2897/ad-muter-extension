(() => {
  "use strict";

  const DEBUG = true;

  let adActive = false;
  let pollTimer = null;
  let observer = null;
  let pollCount = 0;

  function log(...args) {
    console.log("[Ad Muter]", ...args);
  }

  log("Content script loaded on", location.hostname, location.pathname);

  // ---------------------------------------------------------------------------
  // DIAGNOSTIC: dump what we can see on the page (runs every 10th poll)
  // ---------------------------------------------------------------------------

  function dumpDiagnostics() {
    // All data-testid values on the page
    const testIds = [...document.querySelectorAll("[data-testid]")]
      .map((el) => el.getAttribute("data-testid"))
      .filter((v) => v);
    if (testIds.length > 0) {
      log("DIAG data-testid values:", JSON.stringify([...new Set(testIds)]));
    }

    // Video elements
    const videos = document.querySelectorAll("video");
    log("DIAG video elements:", videos.length);
    videos.forEach((v, i) => {
      log(`DIAG video[${i}]: paused=${v.paused}, muted=${v.muted}, duration=${v.duration}, currentTime=${v.currentTime}`);
    });

    // Player area text (first 500 chars)
    const player =
      document.querySelector('[data-testid="player-container"]') ||
      document.querySelector("video")?.closest('[class*="player"], [class*="Player"]') ||
      document.querySelector("video")?.parentElement?.parentElement?.parentElement;
    if (player) {
      const text = (player.innerText || "").slice(0, 500).replace(/\n/g, " | ");
      log("DIAG player text:", text);
    } else {
      log("DIAG no player container found");
    }

    // Any elements with "ad" in class or id (be specific)
    const adEls = document.querySelectorAll(
      '[class*="ad-"], [class*="Ad-"], [class*="_ad"], [class*="adTag"], ' +
      '[class*="ad_"], [id*="ad-"], [id*="ad_"]'
    );
    if (adEls.length > 0) {
      const info = [...adEls].slice(0, 10).map((el) => ({
        tag: el.tagName,
        class: el.className?.toString().slice(0, 100),
        id: el.id,
        visible: el.offsetParent !== null,
        text: (el.innerText || "").slice(0, 80),
      }));
      log("DIAG ad-related elements:", JSON.stringify(info, null, 2));
    }

    // Check for iframes (ads often run in iframes)
    const iframes = document.querySelectorAll("iframe");
    if (iframes.length > 0) {
      const iframeInfo = [...iframes].slice(0, 5).map((f) => ({
        src: (f.src || "").slice(0, 120),
        class: f.className?.toString().slice(0, 60),
        visible: f.offsetParent !== null,
      }));
      log("DIAG iframes:", JSON.stringify(iframeInfo, null, 2));
    }
  }

  // ---------------------------------------------------------------------------
  // Platform-specific ad detection
  // ---------------------------------------------------------------------------

  const detectors = {

    "hotstar.com": {
      detect: () => {
        // Strategy 1: data-testid attributes
        const adHead = document.querySelector('[data-testid="ad-head"]');
        const adDetails = document.querySelector('[data-testid="ad-details"]');
        if (adHead || adDetails) {
          if (DEBUG) log("Detected via data-testid:", adHead ? "ad-head" : "ad-details");
          return true;
        }

        // Strategy 2: Any data-testid containing "ad" (but not "add", "address" etc)
        const adTestIds = document.querySelectorAll(
          '[data-testid^="ad-"], [data-testid^="ad_"], [data-testid="ad"]'
        );
        for (const el of adTestIds) {
          if (el.offsetParent !== null) {
            if (DEBUG) log("Detected via data-testid pattern:", el.getAttribute("data-testid"));
            return true;
          }
        }

        // Strategy 3: Elements with ad-related classes
        const adClassEls = document.querySelectorAll(
          '[class*="ad-overlay"], [class*="ad-container"], [class*="ad-banner"],' +
          '[class*="AdOverlay"], [class*="AdContainer"], [class*="ad-playing"],' +
          '[class*="shaka-ad"]'
        );
        for (const el of adClassEls) {
          if (el.offsetParent !== null) {
            if (DEBUG) log("Detected via class pattern:", el.className.toString().slice(0, 80));
            return true;
          }
        }

        // Strategy 4: Text-based — look for ad indicators in the player area
        if (hotstarAdTextVisible()) {
          if (DEBUG) log("Detected via text indicator in player");
          return true;
        }

        // Strategy 5: Full page text scan as last resort
        if (pageWideAdText()) {
          if (DEBUG) log("Detected via page-wide text scan");
          return true;
        }

        return false;
      },

      observeTarget: () =>
        document.querySelector("video")?.parentElement?.parentElement ||
        document.body,
    },

    "jiocinema.com": {
      detect: () => {
        if (document.querySelector('[class*="adTag"]')) return true;
        if (document.querySelector('[class*="ad-overlay"]')) return true;
        if (document.querySelector('[class*="adOverlay"]')) return true;
        if (document.querySelector('[class*="ad-playing"]')) return true;
        if (document.querySelector('[class*="preroll"]')) return true;
        if (document.querySelector('[class*="midroll"]')) return true;
        return jioCinemaAdTextVisible();
      },

      observeTarget: () =>
        document.querySelector('[class*="player"]') ||
        document.getElementById("root") ||
        document.body,
    },

    "youtube.com": {
      detect: () => {
        const player = document.querySelector(".html5-video-player");
        if (player?.classList.contains("ad-showing")) return true;
        return !!document.querySelector(
          ".ytp-ad-player-overlay-layout," +
          ".ytp-ad-skip-button-container"
        );
      },

      observeTarget: () =>
        document.querySelector(".html5-video-player") ||
        document.getElementById("movie_player") ||
        document.body,
    },

    "sonyliv.com": {
      detect: () =>
        !!document.querySelector(
          '[class*="ad-overlay"], [class*="ad-container"],' +
          '[class*="adContainer"], [class*="ad-playing"],' +
          '[class*="preroll"], [class*="midroll"]'
        ) || genericAdTextVisible(),

      observeTarget: () =>
        document.querySelector('[class*="player"]') || document.body,
    },

    "fancode.com": {
      detect: () =>
        !!document.querySelector(
          '[class*="ad-overlay"], [class*="ad-container"],' +
          '[class*="adContainer"], [class*="ad-playing"]'
        ) || genericAdTextVisible(),

      observeTarget: () =>
        document.querySelector('[class*="player"]') || document.body,
    },
  };

  // ---------------------------------------------------------------------------
  // Text-based ad checks
  // ---------------------------------------------------------------------------

  const AD_TEXT_MARKERS = [
    "Ad ·", "Ad·", "Ad playing", "Skip Ad", "Skip Ads",
    "Advertisement", "Your video will resume", "Video will play after ad",
    "Ad will end in", "विज्ञापन", "ads remaining",
    "Ad 1 of", "Ad 2 of", "Ad 3 of", "Ad 4 of", "Ad 5 of",
  ];

  function hotstarAdTextVisible() {
    const player =
      document.querySelector('[data-testid="player-container"]') ||
      document.querySelector("video")?.closest('[class*="player"], [class*="Player"]') ||
      document.querySelector("video")?.parentElement?.parentElement?.parentElement;
    if (!player) return false;

    const text = player.innerText || "";
    return AD_TEXT_MARKERS.some((m) => text.includes(m)) ||
      /Ad\s?\d+\s?of\s?\d+/i.test(text);
  }

  function jioCinemaAdTextVisible() {
    const player =
      document.querySelector('[class*="player"]') ||
      document.querySelector("video")?.parentElement;
    if (!player) return false;

    const text = player.innerText || "";
    return AD_TEXT_MARKERS.some((m) => text.includes(m));
  }

  function genericAdTextVisible() {
    const player =
      document.querySelector('[class*="player"]') ||
      document.querySelector("video")?.parentElement;
    if (!player) return false;

    const text = player.innerText || "";
    return AD_TEXT_MARKERS.some((m) => text.includes(m));
  }

  function pageWideAdText() {
    // Scan the full page body but only for very specific ad-during-video markers
    const text = document.body?.innerText || "";
    return (
      text.includes("Skip Ad") ||
      text.includes("Ad playing") ||
      /Ad\s\d+\sof\s\d+/.test(text)
    );
  }

  function genericDetector() {
    return (
      !!document.querySelector(
        '[class*="ad-overlay"], [class*="ad-container"],' +
        '[class*="ad-playing"], [class*="preroll-ad"],' +
        '[class*="midroll-ad"], iframe[src*="doubleclick"],' +
        'iframe[src*="googlesyndication"]'
      ) || genericAdTextVisible()
    );
  }

  // ---------------------------------------------------------------------------
  // Pick platform
  // ---------------------------------------------------------------------------

  function getPlatform() {
    const host = location.hostname;
    for (const [domain, config] of Object.entries(detectors)) {
      if (host.includes(domain)) return config;
    }
    return { detect: genericDetector, observeTarget: () => document.body };
  }

  const platform = getPlatform();
  log("Platform matched:", Object.keys(detectors).find((d) => location.hostname.includes(d)) || "generic");

  // ---------------------------------------------------------------------------
  // State machine
  // ---------------------------------------------------------------------------

  function checkAds() {
    pollCount++;
    let isAd = false;
    try {
      isAd = platform.detect();
    } catch (e) {
      log("Detection error:", e.message);
      return;
    }

    // Dump diagnostics every 10th poll when in DEBUG mode
    if (DEBUG && pollCount % 10 === 0) {
      log(`Poll #${pollCount}, adActive=${adActive}, detected=${isAd}`);
      dumpDiagnostics();
    }

    if (isAd && !adActive) {
      adActive = true;
      chrome.runtime.sendMessage({ type: "AD_STARTED" });
      log(">>> AD STARTED — requesting mute");
    } else if (!isAd && adActive) {
      adActive = false;
      chrome.runtime.sendMessage({ type: "AD_ENDED" });
      log(">>> AD ENDED — requesting unmute");
    }
  }

  // ---------------------------------------------------------------------------
  // Observer + polling
  // ---------------------------------------------------------------------------

  function startObserving() {
    if (observer) return;
    log("Starting observer + polling");

    let debounceTimer = null;
    observer = new MutationObserver(() => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(checkAds, 300);
    });

    const target = platform.observeTarget();
    log("Observing target:", target.tagName, target.className?.toString().slice(0, 60) || target.id || "(body)");

    observer.observe(target, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "data-testid", "data-state", "hidden"],
    });

    pollTimer = setInterval(checkAds, 2000);

    // Run diagnostics once immediately and check for ads
    setTimeout(() => {
      dumpDiagnostics();
      checkAds();
    }, 2000);
  }

  function stopObserving() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    clearInterval(pollTimer);
    pollTimer = null;
    if (adActive) {
      adActive = false;
      chrome.runtime.sendMessage({ type: "AD_ENDED" });
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  chrome.storage.local.get("enabled", ({ enabled }) => {
    if (enabled !== false) startObserving();
    else log("Extension is disabled");
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.enabled) {
      changes.enabled.newValue ? startObserving() : stopObserving();
    }
  });
})();
