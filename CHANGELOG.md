# 📜 Chronological Engineering Ledger & Fix Autopsy

> *"Why did it take so many iterations? What broke, why did it break, and how was it solved?"*

This document provides a transparent, low-level technical autopsy of every bug, regression, race condition, and architectural roadblock encountered throughout the development of `vivaldi-sidebar-fix`, detailing exactly how Chromium and Vivaldi's internal systems reacted at each stage.

---

## 📑 Timeline of Releases

| Version | Core Objective | Bug / Roadblock Encountered | Root Cause | Engineering Solution |
|---|---|---|---|---|
| **v1.0.0** | Initial discard & 88% width | Black screen void on reopen; visual tearing | Severed GuestView IPC & immediate un-glided discard | `wv.src` reassignment wakeup + 150ms glide delay |
| **v1.0.1** | Restoring missing close (X) button | Microscopic and duplicate close buttons | CSS/DOM injection conflicted with `bundle.js` logic | Patched `shouldShowCloseButton` in `bundle.js` + captured native SVG |
| **v1.0.2** | Native close button unification | Race condition: Chromium reopened old session | `chrome.tabs.discard` fired before navigation committed | Explicit `chrome.tabs.update` + deferred navigation |
| **v1.0.3** | Clean URL reset on close | Auto-hide and multitasking wiped chat context | Visibility observer triggered reset on any `!isVisible` | Introduced `pendingResetPanels` Set; isolated reset strictly to 'X' |
| **v1.0.4** | Auto-hide vs. Close isolation | Validated session persistence on blur | Reopening checks `pendingResetPanels` before reset | Production release of dual-lifecycle architecture |
| **v1.0.5** | Comprehensive systems hardening | Extension panel crashes, rapid-click race, memory leaks | Unchecked `chrome.tabs.discard`, timer desync, uncleaned Sets | Full audit resolution: `isExtensionPanel`, atomic debounce, `onRemoved` listener |
| **v1.0.6** | Web Panel Shortcut & Submit Fix | `Ctrl+Enter` / `Meta+Enter` failed in Twitter, Claude, ChatGPT | Vivaldi `bundle.js` shortcut hijacking + web panel focus blindspot | Patched passthrough set `f`, patched `handleShortcut` for `#panels`, added capture guard |
| **v1.0.7** | Universal Web Panel Close & Reset | Close button only hid Twitter, Claude, Reddit, etc.; only Gemini reset | Native `Rge` close bypassed `home()`, fallback preserved subpaths | Hooked native `Rge` close button, universal `origin + '/'` reset, global capture listener |
| **v1.0.8** | Dual-Key Reset & Clean Native Shortcuts | Some custom panels lost base URL on reopen; window capture blocked Shift+Enter | Panel ID mismatch between close and reopen; window `stopImmediatePropagation` blocked native input | Dual-key tracking (`panelId` + `tabId`) with `panelResetUrls` map; removed window capture listener in favor of pure bundle patch |

---

## 🔍 Technical Autopsies: Iteration by Iteration

### Iteration 1 (v1.0.0): The Ghost GuestView & Visual Tearing
* **The Goal**: Free up RAM by discarding web panel tabs when closed and expand sidebar width from 61.8% to 88%.
* **What Broke**:
  1. **Visual Tearing**: When closing the panel, the screen flickered, compositor frames dropped, and Chromium occasionally displayed an `Aw, Snap!` dialog.
  2. **The Black Void**: When reopening the panel, the webview appeared as an empty, completely black rectangle. Calling `webview.reload()` produced zero output.
* **Why It Happened (The Autopsy)**:
  - Standard browser tabs use `RenderFrameHost`. But Vivaldi web panels run inside Chromium `<webview>` elements governed by the Chromium **GuestView Subsystem** (`content/browser/bad_message.cc` & `guest_view_base.cc`).
  - Calling `chrome.tabs.discard(tabId)` immediately while the panel was still animating out caused the GPU compositor to lose its target surface mid-frame.
  - Furthermore, when a GuestView is discarded, Chromium **destroys the guest render process and severs the underlying IPC channel**. A standard DOM `.reload()` fails because there is no live process to receive the reload command.
* **The Engineering Fix**:
  1. Implemented `GLIDE_DELAY_MS = 150`, allowing Vivaldi's slide-out transition to complete smoothly off-screen before triggering tab discard.
  2. To revive a dead GuestView, the mod reassigns `wv.src = currentSrc`. This forces Chromium's content layer to re-spawn a brand-new guest renderer process from scratch.

---

### Iteration 2 (v1.0.1): The Microscopic & Duplicate Close Button
* **The Goal**: Give users an explicit Close (X) button on the web panel header.
* **What Broke**:
  - In some configurations, two close buttons appeared side-by-side (`[ ✖ ] [ x ]`).
  - The injected button had arbitrary 2px stroked SVG paths that rendered microscopic and blurry on HiDPI displays.
  - Clicking the first button bypassed the mod entirely, while clicking the second closed the panel.
* **Why It Happened (The Autopsy)**:
  - Inside Vivaldi's minified React bundle (`bundle.js`), Vivaldi contains a method:
    ```javascript
    shouldShowCloseButton = e => this.props.prefValues[D.kPanelsShowCloseButton] && 
      !((si.ZP.getSeparateFloating(e, this.winId) || this.props.prefValues[D.kPanelsAsOverlayEnabled]) && 
        this.props.prefValues[D.kPanelsAsOverlayAutoClose]);
    ```
    If both **Floating Panel** and **Auto-close Inactive Panel** are enabled, Vivaldi **deliberately suppresses its native close button**.
  - Custom CSS had injected a mock button. When the user's settings changed or during initial render, both the native button and the injected button fought for layout space.
* **The Engineering Fix**:
  1. Created `patch-bundle.py` to patch `shouldShowCloseButton` in `bundle.js`, preserving exact byte lengths so source maps and React runtimes remained intact.
  2. Extracted Vivaldi's native `Pe.kze` SVG path (`M4.293 4.293...`) to match native 18x18px sizing.
  3. Switched to an event-capturing listener (`useCapture: true`) on the header, guaranteeing that clicks on *either* button route through our mod's teardown logic.

---

### Iteration 3 (v1.0.2): Navigation vs. Discard Race Condition
* **The Goal**: Ensure closing an AI panel (e.g. Gemini, Claude) resets back to a fresh prompt (`gemini.google.com/app`) rather than reopening to an old chat thread.
* **What Broke**:
  - The user clicked (X) on an active chat. Upon reopening, the web panel loaded the *exact same old chat* instead of the home page!
* **Why It Happened (The Autopsy)**:
  - When you set `wv.src = baseUrl`, the DOM updates synchronously, but Chromium's network and navigation commit process takes between 50ms to 200ms.
  - When `chrome.tabs.discard(tabId)` was called 150ms later, Chromium discarded the tab **before the navigation commit had finalized**.
  - On restart, Chromium's Session Restore loaded the *last committed URL* in the session ledger—which was the old chat!
* **The Engineering Fix**:
  - Introduced direct Chromium tab navigation via `chrome.tabs.update(tabId, { url: targetUrl })` on the live tab.
  - Added an in-memory session reset queue (`pendingResetPanels`). When a panel is explicitly closed, its ID is queued. Upon reopening, `handleReopen` verifies the panel's reset state and enforces the clean base URL.

---

### Iteration 4 (v1.0.3): The Overzealous Auto-Hide Regression
* **The Goal**: Clean the session whenever the panel was hidden.
* **What Broke**:
  - When the user clicked on their main webpage to read documentation or copy code, Vivaldi's auto-close feature slid the panel away (as designed).
  - When the user reopened the panel to paste their code, their **entire active conversation was gone**, completely wiped back to the clean prompt!
* **Why It Happened (The Autopsy)**:
  - In v1.0.3, a `MutationObserver` on `panel.classList` observed when the panel lost the `.visible` class and triggered the reset routine unconditionally.
  - But in an Edge-style workflow:
    - **Clicking outside / Blur**: Means *"I am multitasking. Keep my chat session warm and alive!"*
    - **Clicking the (X) button**: Means *"I am finished with this session. Clean my chat and free my RAM!"*
* **The Engineering Fix**:
  - Introduced `pendingResetPanels = new Set()`.
  - Only an explicit click on the dedicated `button.close` ('X') adds the panel to `pendingResetPanels`.
  - Auto-hide, switcher clicks, and blur events **never** touch `pendingResetPanels`, leaving active conversations completely intact.

---

### Iteration 5 (v1.0.4): Dual-Lifecycle Architecture
* **The Goal**: Perfectly isolate multitasking blur from manual reset.
* **Result**:
  - Verified: Clicking outside leaves AI chats warm and responsive.
  - Verified: Clicking (X) frees 100% of renderer memory and resets to clean base URLs.
  - Released to GitHub as `v1.0.4`.

---

### Iteration 6 (v1.0.5): Deep Systems Hardening & Resilience
* **The Goal**: Audit and eliminate all remaining edge cases, performance bottlenecks, and extension incompatibilities.
* **What Was Identified & Fixed**:
  1. **Extension Panel Isolation**: Extension panels (Bitwarden vault, Translate) were previously subject to URL resets and discards, invalidating their background extension contexts. Added `isExtensionPanel` guard to skip URL resets and discards for extension panels.
  2. **Rapid-Click Debounce**: Clicking (X) multiple times rapidly caused switcher toggling and overlapping timers. Added atomic `panel.__isClosing` lock and direct timer tracking (`panel.__glideDiscardTimer`).
  3. **Memory Set Leaks**: If tabs were closed or removed by Vivaldi, `discardedTabs` and `revivingTabs` retained their IDs. Added a listener on `chrome.tabs.onRemoved` to clean memory tracking.
  4. **SPA Subpath & Hash Safety**: Enhanced `getCleanBaseUrlFallback` to cleanly strip `#hashes` and `?queries` while preserving valid SPA paths.
  5. **DOM Thrashing**: Replaced the global `document.body` MutationObserver with a scoped `#panels-container` observer with `subtree: false`.
  6. **Hidden Sidebar Fallback**: Added multi-tier fallback (switcher -> toggle button -> synthetic F4 -> DOM class removal) so the close button works even if the user completely hides the sidebar switcher.

---

### Iteration 7 (v1.0.6): The Web Panel Keyboard Shortcut & Submit Conspiracy
* **The Goal**: Allow instant submission shortcuts (e.g. `Ctrl+Enter` on Twitter/X to tweet, `Ctrl+Enter` on ChatGPT/Claude, `Ctrl+Enter` on GitHub comments, Discord, Slack) to work directly inside Web Panels.
* **What Broke**:
  - Typing a tweet or prompt inside a Web Panel and pressing `Ctrl+Enter` (or `Cmd+Enter` on macOS) did nothing or triggered browser spatial navigation / mail actions instead of posting the tweet.
* **Why It Happened (The Autopsy)**:
  - **Two-Fold Bug in Vivaldi's Core Engine (`bundle.js`)**:
    1. **Missing Text Passthrough Key**: In module `84451`, Vivaldi maintains `f`, a `Set` of keyboard combinations that are considered text-editing keystrokes (`ctrl+a`, `ctrl+z`, `enter`, `shift+enter`, etc.) and should **never** be intercepted by browser hotkeys. Vivaldi **omitted `ctrl+enter`, `meta+enter`, `ctrl+shift+enter`, and `alt+enter` from `f`**. Thus, `shortcutAllowedInText("ctrl+enter")` returned `true` ("allowed for browser consumption").
    2. **The Web Panel Focus Blindspot**: In `handleShortcut`, when the focused element was a `<webview>` (`m === "WEBVIEW"`), Vivaldi called `windowPrivate.getFocusedElementInfo(windowId)`. This Chromium private API checks the **main window tab**, *not* the sidebar web panel! Because the background tab was not focused on an input (`editable: false`), Vivaldi evaluated `if (!i || S(r))` as `true`, concluding the user was in an inactive area and executing browser commands over the web panel!
* **The Engineering Fix**:
  1. Updated `src/patch-bundle.py` to add `"ctrl+enter"`, `"meta+enter"`, `"ctrl+shift+enter"`, `"meta+shift+enter"`, and `"alt+enter"` to `f`.
  2. Patched `handleShortcut` in `bundle.js` so when `p?.closest?.("#panels")` is true, text editing shortcuts are never hijacked by outer browser command handlers.

---

### Iteration 8 (v1.0.7): Universal Web Panel Close & Base URL Reset
* **The Goal**: Ensure closing *any* web panel (Twitter/X, Claude, ChatGPT, Grok, Reddit, YouTube, GitHub, Discord, Slack, custom sites) cleanly resets back to its home URL and reclaims RAM down to 0.0 MB.
* **What Broke**:
  - The close button reset Gemini properly, but on Twitter/X, Claude, and custom web panels, clicking the close button only hid the panel without resetting to the base URL or freeing RAM.
* **Why It Happened (The Autopsy)**:
  1. In `bundle.js`, Vivaldi's native `Rge` component rendered its close button with `onClick: () => ii.Z.closePanel(this.winId)`. When clicked, it bypassed `this.home()` and only closed the UI drawer without resetting the webview or triggering discard.
  2. In `getCleanBaseUrlFallback`, generic fallback logic was preserving deep subpaths (`u.pathname`) for non-Gemini sites, so `targetUrl` was evaluated as identical to `currentSrc` rather than resetting to `https://x.com/`, `https://reddit.com/`, or `u.origin + '/'`.
* **The Engineering Fix**:
  1. Connected Vivaldi's native `Rge` close button directly to `__edgeCloseWebPanel(this)` in `patch-bundle.py`, executing `this.home()`, `chrome.tabs.update()`, and `chrome.tabs.discard()`.
  2. Enhanced `getCleanBaseUrlFallback` to enforce clean base domain resets (`u.origin + '/'` and curated home paths for Twitter/X, Claude, ChatGPT, Grok, Reddit, YouTube, GitHub, Discord, Slack, etc.).

---

### Iteration 9 (v1.0.8): Dual-Key Reset & Clean Native Shortcuts
* **The Goal**: Guarantee that *any* web panel (including custom bookmarks, dashboards, or non-standard URLs) resets to the exact initial URL the user added, and eliminate any keyboard shortcut regressions.
* **What Broke**:
  1. **Reopen Reset Desync**: On some panels, `getPanelId(panel)` on reopen returned a different identifier (`tab-123`) than what was stored during close (`WEBPANEL_xxx`), causing `pendingResetPanels.has()` to return false on reopen and skipping the base URL reset.
  2. **Keyboard Capture Collateral Damage**: A window-level `keydown` capture listener calling `e.stopImmediatePropagation()` for modifier combinations intercepted `Shift+Enter` (newlines in textareas) and interfered with Vivaldi's internal input management.
* **The Engineering Fix**:
  1. Implemented **Dual-Key Tracking** (`panelId` + `tabId`) with a dedicated `panelResetUrls` Map in `edge-panel-mod.js`. When a panel is closed, its configured URL (`this.props.webPanel.url`) is indexed by both its panel ID and its Chromium tab ID, guaranteeing 100% reset precision on reopen for every website.
  2. Removed the window-level `keydown` capture listener entirely. Shortcut passthrough is now handled 100% cleanly and natively by Vivaldi's internal `handleShortcut` and set `f` patch in `bundle.js`, allowing `Ctrl+Enter`, `Shift+Enter`, `Enter`, and all hotkeys to function with zero event blockage.

---

## 🏆 Current Architecture Summary

```
User Action: Click Outside (Blur)
       │
       ▼
Panel Slides Away (Visual Only)
       │
       └─► Session Intact • Memory Warm • Instant Multitask Resume

────────────────────────────────────────────────────────────────────────

User Action: Typing in Web Panel (Twitter, ChatGPT, Claude, GitHub, etc.)
       │
       ▼
Press [Ctrl + Enter] / [Shift + Enter] / [Enter]
       │
       ├─► 1. bundle.js text passthrough set (f) protects combo from browser hijacking
       ├─► 2. handleShortcut detects panel webview and yields control
       └─► 3. Webview receives raw event natively -> Instant Tweet / Prompt / Multiline!

────────────────────────────────────────────────────────────────────────

User Action: Click Dedicated [X] Button (Any Web Panel in Vivaldi)
       │
       ├─► 1. Rge native bridge triggers this.home() + __edgeCloseWebPanel
       ├─► 2. Dual-key index (panelId + tabId) recorded in panelResetUrls
       ├─► 3. Navigate tab to exact initial configured URL (chrome.tabs.update)
       ├─► 4. Slide panel closed (150ms glide animation)
       └─► 5. Discard guest renderer process down to 0.0 MB RAM
               │
               ▼
User Reopens Panel Later:
       │
       ├─► Dual-key lookup in panelResetUrls -> Enforce clean base URL
       └─► Atomically revive GuestView renderer without blank screen or reload loops
```
