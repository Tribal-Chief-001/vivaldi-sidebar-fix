# Vivaldi Sidebar Fix: Edge-Style Web Panels

Bring Microsoft Edge's best sidebar features to Vivaldi: **Instant 0 MB memory discarding**, a dedicated **manual Close (X) button**, **88% screen-width expansion**, and **glitch-free wakeups** for heavy AI tools (Claude, Gemini, Grok, ChatGPT).

---

## 🎯 The Problem in Stock Vivaldi

1. **Hidden Close Button**: When you enable *Floating Panel* + *Auto-close Inactive Panel*, Vivaldi deliberately suppresses the **X** close button in `bundle.js`.
2. **Hidden ≠ Closed (Memory Bleed)**: Auto-closing or clicking away merely sets CSS `visibility: hidden`. Background webviews stay active with live WebSockets and JavaScript execution loops, easily consuming 2 GB–4 GB+ of RAM across a few AI tabs.
3. **Artificial Width Cap**: Dragging panel width is hardcoded to the Golden Ratio (`0.618` / 61.8% window width) and capped in CSS at `65vw`, preventing desktop-sized multi-column layouts.
4. **Pointer Event Trap**: Vivaldi's sidebar icons listen for `pointerdown`/`pointerup` events rather than standard `.click()` events, causing external scripts to fail when attempting to trigger panel closing.

---

## ✨ What This Mod Does

| Feature | Stock Vivaldi | With This Mod |
| :--- | :--- | :--- |
| **Manual Close Button (X)** | Hidden when auto-close is enabled | **Restored to header toolbar** |
| **Memory Reclamation** | 0% (Stays in RAM, background threads active) | **100% (Instant 0.0 MB RAM discard via `chrome.tabs.discard()`)** |
| **Closing Animation** | Immediate cut / freeze | **Glide-first teardown (150ms slide-out before discard)** |
| **Panel Re-open** | Often black box / dead webview if discarded | **Clean instant wakeup via `wv.src = src` re-spawn** |
| **Multi-tab Isolation** | Origin collisions (e.g. Gemini vs Google Search) | **Exact Chromium `tab_id` targeting (zero collisions)** |
| **Max Panel Width** | Hardcapped at 61.8% / 65vw | **Expanded to 88% of screen (88vw)** |
| **System Updates** | Overwritten by `apt upgrade` | **Persisted automatically via APT `DPkg::Post-Invoke` hook** |
| **Inactivity Timers** | None | **Zero automatic timers (User is in 100% control)** |

---

## 🚀 Quick Install (Linux)

Clone the repository and run the installer:

```bash
git clone https://github.com/Tribal-Chief-001/vivaldi-sidebar-fix.git
cd vivaldi-sidebar-fix
sudo bash install.sh
```

Then restart Vivaldi:
```bash
killall vivaldi-bin vivaldi 2>/dev/null || true
vivaldi &
```

---

## 🛠️ Recommended Vivaldi Settings

For the optimal Edge-like experience:
1. Open **Vivaldi Settings** (`Ctrl + F12` or click the gear icon).
2. Navigate to **Panel** $\to$ **Panel Options**:
   - Check **Floating Panel**
   - Check **Auto-close Inactive Panel**
3. Navigate to **Web Panels**:
   - Add your preferred AI tools (Claude, Gemini, Grok, ChatGPT).
   - Right-click any panel icon in the sidebar and enable **Separate Width** to give each site independent dimensions (up to 88% of your screen!).

---

## 📂 Architecture & Files

```
vivaldi-sidebar-fix/
├── install.sh              # Idempotent installer + APT hook configuration
├── uninstall.sh            # 1-command factory rollback
├── src/
│   ├── edge-panel-mod.js   # Core JavaScript mod (close button + tab discard + wakeups)
│   └── patch-bundle.py     # Width expander (0.618 -> 0.880, 65vw -> 88vw)
├── tests/
│   └── test_mod.js         # Integrity test suite
├── FORUM_POST.md           # Ready-to-publish Vivaldi Forum post
├── LICENSE                 # MIT License
└── README.md
```

### How the Lifecycle Works:
1. **User clicks X**:
   - Dispatches `pointerdown` + `pointerup` to trigger Vivaldi's native panel glide-out.
   - Waits `150ms` (allowing CSS exit transition to finish).
   - Calls `chrome.tabs.discard(tabId)`. Guest renderer process terminates down to 0 MB.
2. **User switches between panels / clicks away**:
   - Panel glides shut without discarding. Memory and session remain warm for quick multitasking or taking screenshots.
3. **User clicks sidebar icon to re-open**:
   - Script detects discarded state and resets `wv.src = currentSrc`.
   - Chromium spawns a fresh `RenderProcessHost`, reloading the site cleanly with zero black screens or reload loops.

---

## 🔄 Factory Rollback / Uninstall

If you ever want to revert Vivaldi back to 100% stock factory condition:

```bash
sudo bash uninstall.sh
```

This restores original `window.html` and `bundle.js` from `.orig` pristine backups and removes the APT persistence hook.

---

## 📜 License

MIT License - see [LICENSE](LICENSE) for details.
