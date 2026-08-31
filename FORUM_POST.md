# [MOD] Edge-Style Web Panels: 0.0 MB RAM Discard (Panel Hibernation) + Restored Close (X) Button + 88% Max Width

**Category**: Modifications  
**Tags**: web-panels, performance, memory-saving, edge, userchrome, ai-tools  

---

### The Problem
Web Panels in Vivaldi are hands-down one of the best features in modern browsers. However, when building an AI workflow (ChatGPT, Claude, Gemini, Grok, Perplexity), running multiple panels consumes gigabytes of memory because:
1. Turning on **"Floating Panel"** + **"Auto-close Inactive Panel"** causes Vivaldi to hide the native **(X) Close** button.
2. Clicking away or closing the panel merely hides the DOM element (`visibility: hidden`). Unlike normal tabs, **web panels have zero background hibernation**—background threads and WebSockets keep eating 3–5 GB of RAM indefinitely.
3. Closing a panel never resets to the clean home prompt; it reloads stale old conversations. Conversely, naive reset scripts wipe your chat even when you just clicked away to multitask!
4. Maximum drag width is artificially clamped to the Golden Ratio (`0.618` / 61.8% of screen) and `65vw`, restricting larger views on desktop screens.

---

### The Solution: `vivaldi-sidebar-fix`
This open-source modification brings true Microsoft Edge-grade flyout sidebar behavior to Vivaldi:
- **Restored Native Close (X) Button**: Restores Vivaldi's native 18x18px `Pe.kze` SVG close button directly into the web panel header.
- **True 0.0 MB RAM Reclamation**: Clicking X triggers Chromium's native `chrome.tabs.discard()` via the exact webview tab ID, dropping renderer RAM down to 0 MB.
- **Smart Dual-Lifecycle Architecture**:
  - *Clicking outside / Blur*: Auto-hides visually while keeping your conversation warm and ready.
  - *Clicking [X]*: Resets back to clean base prompt (`gemini.google.com/app`, `claude.ai/new`, etc.) and frees RAM.
- **Glide-First Teardown**: The panel slides away first (150ms) before the tab is discarded, eliminating compositor tearing.
- **Glitch-Free Wakeup**: Revives cleanly on reopen via source-reassignment without black boxes or infinite reload loops.
- **88% Full-Width Expansion**: Byte-safe patch expands the drag clamp to 88% of screen width and `88vw`, giving full desktop layout space.
- **Edge-Case Hardened**: Automatically isolates extension panels (Bitwarden vault, Translate) from unexpected discards or URL resets, debounces rapid clicks, and cleans memory leaks.
- **APT Update Persistence**: Backed by a Debian/Ubuntu/Mint `DPkg::Post-Invoke` hook so `apt upgrade` automatically re-applies your mod.

---

### Installation (1-Step Quick Install)

Open terminal and run:

```bash
git clone https://github.com/Tribal-Chief-001/vivaldi-sidebar-fix.git
cd vivaldi-sidebar-fix
sudo bash install.sh
```

Restart Vivaldi and enjoy lightweight, high-performance web panels!

GitHub Repository: https://github.com/Tribal-Chief-001/vivaldi-sidebar-fix
