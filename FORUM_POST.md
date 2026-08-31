# [MOD] Edge-Style Web Panels: Instant 0 MB RAM Discard + Manual Close Button + 88% Max Width

**Category**: Modifications  
**Tags**: web-panels, performance, memory-saving, edge, userchrome  

---

### The Problem
Web Panels in Vivaldi are hands-down one of the best features in modern browsers. However, when building an AI workflow (ChatGPT, Claude, Gemini, Grok), running multiple panels consumes gigabytes of memory because:
1. Turning on **"Floating Panel"** + **"Auto-close Inactive Panel"** causes Vivaldi to hide the **X** close button.
2. Clicking away or closing the panel merely hides the DOM element (`visibility: hidden`). Background threads and WebSockets keep running indefinitely.
3. Maximum drag width is hardcoded to the Golden Ratio (`0.618` / 61.8% of screen) and `65vw`, restricting larger views on desktop screens.

---

### The Solution: `vivaldi-sidebar-fix`
This modification brings true Microsoft Edge-style behavior to Vivaldi:
- **Restored Manual Close (X) Button**: Even with Auto-close and Floating mode enabled, a clean close button appears on the panel header.
- **True 0.0 MB RAM Reclamation**: Clicking X triggers `chrome.tabs.discard()` via the exact Chromium `<webview tab_id="...">`.
- **Glide-First Teardown**: The panel slides away first (150ms) before the tab is discarded, eliminating compositor tearing.
- **Glitch-Free Wakeup**: Revives cleanly when clicked again using `wv.src = src` re-spawn. No black boxes, no infinite reload loops.
- **88% Full-Width Expansion**: Modifies the drag clamp to 88% of screen width and `88vw`, giving full desktop layout space.
- **User-Controlled**: No annoying auto-inactivity timers killing your session while multitasking or taking screenshots.

---

### Installation (Linux / Ubuntu / Mint / Debian)

```bash
git clone https://github.com/Tribal-Chief-001/vivaldi-sidebar-fix.git
cd vivaldi-sidebar-fix
sudo bash install.sh
```

Restart Vivaldi and enjoy lightweight, high-performance web panels!

GitHub Repository: https://github.com/Tribal-Chief-001/vivaldi-sidebar-fix
