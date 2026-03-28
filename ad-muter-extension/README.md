# Ad Muter — Live Match

A Chrome extension that automatically mutes your browser tab when ads play during live sports streams, and unmutes when the action resumes.

No more scrambling for the volume button during ad breaks.

## Supported Platforms

- **JioHotstar / Hotstar**
- **JioCinema**
- **YouTube**
- **SonyLIV**
- **FanCode**
- **Willow, ESPN, ESPNcricinfo** (basic support)

## How It Works

1. **Install the extension** and pin it to your toolbar.
2. **Open a live stream** on any supported platform.
3. The extension watches for ads in two ways:
   - On Hotstar/JioHotstar, it detects ad-related network activity to know exactly when an ad starts and how long it lasts.
   - On all platforms, it monitors the page for visual cues that an ad is playing (overlay text like "Skip Ad", ad player markers, etc.).
4. When an ad is detected, the **tab is muted instantly**. You'll see a red **"AD"** badge on the extension icon.
5. Once the ad break ends, the **tab is unmuted automatically** and the badge disappears.

There's a built-in safety net — if something goes wrong, the tab is force-unmuted after 5 minutes so you're never stuck on mute.

## Usage

Click the extension icon to open the popup. From there you can:

- **Toggle the extension on/off** with a single switch.
- See whether the current tab is muted or unmuted.

Turning it off will immediately unmute any tabs the extension had muted.

## Installation

1. Download or clone this repository.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the `ad-muter-extension` folder.
5. Pin the extension from the puzzle-piece icon in your toolbar.

## Privacy

This extension runs entirely in your browser. It does not collect, store, or send any personal data. The only thing it saves locally is your on/off preference.
