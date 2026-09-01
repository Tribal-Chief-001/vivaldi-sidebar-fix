# [MOD] Edge-Style Web Panels: 0.0 MB RAM Reclamation + Fresh Home Reset on (X) + Native Shortcuts (Ctrl+Enter) + 88% Max Width

**Category**: Modifications  
**Tags**: web-panels, performance, memory-saving, edge, userchrome, ai-tools, keyboard-shortcuts  

---

### The Problem with Stock Vivaldi Web Panels
Web Panels in Vivaldi are hands-down one of the best features in modern browsers. However, when building an AI or multitasking workflow (ChatGPT, Claude, Gemini, NotebookLM, Twitter/X, Grok, Perplexity), running multiple panels introduces frustrating bottlenecks:
1. **Missing (X) Close Button**: Turning on **"Floating Panel"** + **"Auto-close Inactive Panel"** causes Vivaldi to deliberately suppress the header close button.
2. **Silent RAM Bleed (3–5 GB+)**: When you click away, Vivaldi merely adds `visibility: hidden`. Unlike regular tabs, **web panels have no hibernation**—background renderers, WebSockets, and memory heaps stay alive full blast.
3. **Stale Chat/Article Restore**: Stock panels never reset to the clean home URL on close. Reopening a panel days later reloads the old stale conversation. Naive reset scripts wipe your chat even when you just clicked away to copy text!
4. **Keyboard Shortcut Hijacking**: Pressing `Ctrl+Enter` (or `Cmd+Enter` on macOS) to submit a tweet or prompt fails because Vivaldi's global hotkey dispatcher steals the keystroke.
5. **Artificial Width Limits**: Maximum drag width is artificially clamped to the Golden Ratio (`0.618` / 61.8% of screen) and `65vw`.

---

### The Solution: `vivaldi-sidebar-fix` (v1.2.1)
This mod brings Microsoft Edge Copilot-style flyout sidebar behavior to Vivaldi:

- 🛑 **Unified Native Close (X) Button**: Restores Vivaldi's native 18x18px `Pe.kze` SVG close button directly into the web panel header.
- ⚡ **True 0.0 MB RAM Reclamation**: Clicking (X) completely destroys the underlying tab via `chrome.tabs.remove(tabId)`, freeing 100% of memory.
- 🔄 **Pristine Tab Creation on Reopen**: When reopened, Vivaldi natively executes `_createRelatedTab()`, spawning a 100% fresh tab pointing straight to your configured Home URL across every website.
- 🛡️ **Intelligent Multitasking Isolation**:
  - *Clicking outside / Blur*: Glides away visually while keeping your active chat warm and alive in memory.
  - *Clicking [X]*: Wipes memory to 0.0 MB and prepares a fresh session for next time.
- ⌨️ **Native Submit Shortcut Passthrough**: `Ctrl+Enter`, `Meta+Enter`, `Ctrl+Shift+Enter`, and `Alt+Enter` pass straight to web apps (Twitter/X, ChatGPT, Claude, GitHub comments, Discord, Slack) with zero browser interference.
- 📐 **88% Full-Width Expansion**: Expands panel drag limits from 61.8% $\to$ **88%**, allowing true side-by-side desktop multitasking.
- 🧩 **Extension Panel Guard**: Protects extension side panels (Bitwarden vault, Translate) from unwanted URL resets or teardowns.
- 🌐 **100% Cross-Platform**: Native 1-step installer scripts for **Linux**, **Windows** (PowerShell), **macOS**, and **FreeBSD**.
- 🛡️ **APT Update Persistence**: Debian/Ubuntu/Mint `DPkg::Post-Invoke` hook ensures package updates never overwrite your mod.

---

### Installation (1-Step Quick Install)

#### 🐧 Linux & macOS
```bash
git clone https://github.com/Tribal-Chief-001/vivaldi-sidebar-fix.git
cd vivaldi-sidebar-fix
sudo bash install.sh
```

#### 🪟 Windows (PowerShell)
```powershell
git clone https://github.com/Tribal-Chief-001/vivaldi-sidebar-fix.git
cd vivaldi-sidebar-fix
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\install.ps1
```

Restart Vivaldi and enjoy lightweight, high-performance web panels!

🔗 **GitHub Repository**: https://github.com/Tribal-Chief-001/vivaldi-sidebar-fix  
📜 **Changelog & Technical Autopsies**: https://github.com/Tribal-Chief-001/vivaldi-sidebar-fix/blob/main/CHANGELOG.md
