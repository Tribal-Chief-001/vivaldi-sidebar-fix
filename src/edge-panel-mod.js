// =============================================================================
// Edge-Style Close & Discard for Vivaldi Web Panels (Production Edition)
// =============================================================================
//
// Description:
//   Restores a clean, dedicated close (X) button to Vivaldi's web panel header even
//   when "Floating Panel" and "Auto-close Inactive Panel" are both active.
//   Seamlessly integrates with Vivaldi's native UI system without duplicate buttons.
//   When clicked:
//     1. Resets the web panel tab to its clean base URL (e.g. https://gemini.google.com/app)
//        via chrome.tabs.update() and webview navigation so it opens to a fresh new chat session.
//     2. Triggers an edge-style slide-out animation (150ms).
//     3. Discards the guest renderer process down to 0.0 MB RAM via chrome.tabs.discard().
//   On reopen:
//     Wakes up the discarded webview cleanly to the base prompt URL with atomic lock protection,
//     preventing blank boxes, zombie processes, or reload loops.
// =============================================================================

(function () {
  'use strict';

  // ── Configuration ─────────────────────────────────────────────────────────
  const GLIDE_DELAY_MS = 150;     // Delay to allow panel exit animation before tab discard
  const REVIVE_TIMEOUT_MS = 2500;  // Safety timeout for wakeup lock release

  // Exact native Vivaldi close icon SVG (extracted directly from Vivaldi's core icon library Pe.kze)
  const NATIVE_CLOSE_SVG = [
    '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">',
    '  <path d="M4.293 4.293a1 1 0 0 1 1.414 0L8 6.586l2.293-2.293a1 1 0 1 1 1.414 1.414L9.414 8l2.293 2.293a1 1 0 0 1-1.414 1.414L8 9.414l-2.293 2.293a1 1 0 0 1-1.414-1.414L6.586 8 4.293 5.707a1 1 0 0 1 0-1.414Z"/>',
    '</svg>'
  ].join('');

  // ── State ─────────────────────────────────────────────────────────────────
  const discardedTabs = new Set(); // Stores tab_id of discarded panels
  const revivingTabs = new Set();  // Atomic lock to prevent duplicate reload loops

  // ── Logging ───────────────────────────────────────────────────────────────
  const LOG_PREFIX = '%c[EdgePanels]';
  const LOG_STYLE = 'color: #00d2ff; font-weight: bold;';

  function log(...args) {
    console.log(LOG_PREFIX, LOG_STYLE, ...args);
  }

  function warn(...args) {
    console.warn(LOG_PREFIX, LOG_STYLE, ...args);
  }

  function error(...args) {
    console.error(LOG_PREFIX, LOG_STYLE, ...args);
  }

  // ── DOM Helpers ───────────────────────────────────────────────────────────
  function getLivePanels() {
    return Array.from(document.querySelectorAll('#panels .panel.webpanel'));
  }

  function getWebview(panel) {
    return panel.querySelector('.webpanel-content webview');
  }

  function getTabId(wv) {
    if (!wv) return null;
    const tabIdAttr = wv.getAttribute('tab_id');
    if (tabIdAttr) {
      const parsed = parseInt(tabIdAttr, 10);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }
    return null;
  }

  // ── Rge (WebPanel Component) Resolver ────────────────────────────────────
  // Locates Vivaldi's internal React WebPanel component instance from the DOM
  function getRgeComponent(panel) {
    if (!panel) return null;

    // 1. Search panel DOM node's Fiber hierarchy
    for (const key of Object.keys(panel)) {
      if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
        let fiber = panel[key];
        while (fiber) {
          if (fiber.stateNode && typeof fiber.stateNode.home === 'function') {
            return fiber.stateNode;
          }
          if (fiber.child && fiber.child.stateNode && typeof fiber.child.stateNode.home === 'function') {
            return fiber.child.stateNode;
          }
          fiber = fiber.return;
        }
      }
    }

    // 2. Search webpanel header's Fiber hierarchy
    const header = panel.querySelector('header.webpanel-header') || panel.querySelector('header');
    if (header) {
      for (const key of Object.keys(header)) {
        if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
          let fiber = header[key];
          while (fiber) {
            if (fiber.stateNode && typeof fiber.stateNode.home === 'function') {
              return fiber.stateNode;
            }
            fiber = fiber.return;
          }
        }
      }
    }

    return null;
  }

  // ── Base URL Resolution ───────────────────────────────────────────────────
  // Resolves the original base URL configured for this web panel (e.g. https://gemini.google.com/app)
  // so that closing the panel returns it to a fresh prompt rather than an old chat session.
  function getPanelConfiguredUrl(panel) {
    if (!panel) return null;

    // 1. Check Rge instance directly
    const rge = getRgeComponent(panel);
    if (rge?.props?.webPanel?.url) {
      return rge.props.webPanel.url;
    }

    // 2. Try extracting webPanel.url from React Fiber / Props on panel
    for (const key of Object.keys(panel)) {
      if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
        let fiber = panel[key];
        while (fiber) {
          if (fiber.memoizedProps?.webPanel?.url) {
            return fiber.memoizedProps.webPanel.url;
          }
          if (fiber.stateNode?.props?.webPanel?.url) {
            return fiber.stateNode.props.webPanel.url;
          }
          fiber = fiber.return;
        }
      }
      if (key.startsWith('__reactProps$')) {
        if (panel[key]?.webPanel?.url) {
          return panel[key].webPanel.url;
        }
      }
    }

    // 3. Try extracting from webpanel header React instance
    const header = panel.querySelector('header.webpanel-header');
    if (header) {
      for (const key of Object.keys(header)) {
        if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
          let fiber = header[key];
          while (fiber) {
            if (fiber.memoizedProps?.webPanel?.url) {
              return fiber.memoizedProps.webPanel.url;
            }
            if (fiber.stateNode?.props?.webPanel?.url) {
              return fiber.stateNode.props.webPanel.url;
            }
            fiber = fiber.return;
          }
        }
      }
    }

    return null;
  }

  // Fallback heuristic: clean conversation deep links back to root application URLs
  function getCleanBaseUrlFallback(currentUrl) {
    if (!currentUrl || !currentUrl.startsWith('http')) return null;
    try {
      const u = new URL(currentUrl);
      const host = u.hostname.toLowerCase();

      if (host.includes('gemini.google.com')) return 'https://gemini.google.com/app';
      if (host.includes('claude.ai')) return 'https://claude.ai/new';
      if (host.includes('chatgpt.com')) return 'https://chatgpt.com/';
      if (host.includes('grok.com')) return 'https://grok.com/';
      if (host.includes('copilot.microsoft.com')) return 'https://copilot.microsoft.com/';
      if (host.includes('notebooklm.google.com') || host.includes('notebook.google.com')) return 'https://notebooklm.google.com/';
      if (host.includes('perplexity.ai')) return 'https://www.perplexity.ai/';
      if (host.includes('deepseek.com')) return 'https://chat.deepseek.com/';
      if (host.includes('meta.ai')) return 'https://www.meta.ai/';
      if (host.includes('kimi.ai')) return 'https://www.kimi.ai/';
      if (host.includes('qwen.ai')) return 'https://chat.qwen.ai/';
      if (host.includes('z.ai')) return 'https://chat.z.ai/';

      return u.origin;
    } catch (_) {
      return null;
    }
  }

  // ── Reset Webview to Base URL ───────────────────────────────────────────────
  function resetWebviewToBaseUrl(panel, wv) {
    if (!panel) return;
    if (!wv) wv = getWebview(panel);
    if (!wv) return;

    // 1. First attempt: call Vivaldi's native Rge.home() method
    const rge = getRgeComponent(panel);
    if (rge && typeof rge.home === 'function') {
      try {
        log('Resetting via native Vivaldi Rge.home() method');
        rge.home();
      } catch (err) {
        warn('rge.home() threw:', err);
      }
    }

    // 2. Also try clicking Vivaldi's native Home button via Fiber props
    const header = panel.querySelector('header.webpanel-header');
    if (header) {
      const buttons = header.querySelectorAll('button');
      for (const btn of buttons) {
        for (const k of Object.keys(btn)) {
          if (k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')) {
            let f = btn[k];
            while (f) {
              if (f.memoizedProps && (f.memoizedProps.tooltip === 'Home' || f.memoizedProps.title === 'Home')) {
                if (typeof f.memoizedProps.onClick === 'function') {
                  try { f.memoizedProps.onClick(); } catch (_) {}
                }
              }
              f = f.return;
            }
          }
        }
      }
    }

    // Determine target base URL
    const configuredUrl = getPanelConfiguredUrl(panel);
    const currentSrc = wv.getAttribute('src') || wv.src || '';
    const targetUrl = configuredUrl || getCleanBaseUrlFallback(currentSrc) || currentSrc;

    const tabId = getTabId(wv);

    log('Resetting web panel (tabId:', tabId, ') to base URL:', targetUrl);

    // 3. Direct Chromium tab navigation via chrome.tabs.update
    if (tabId && targetUrl && targetUrl.startsWith('http') && typeof chrome !== 'undefined' && chrome?.tabs?.update) {
      try {
        chrome.tabs.update(tabId, { url: targetUrl });
      } catch (err) {
        warn('chrome.tabs.update failed:', err);
      }
    }

    // 4. DOM Webview src navigation
    if (targetUrl && targetUrl !== 'about:blank') {
      try {
        wv.src = targetUrl;
      } catch (_) {}
    }
  }

  // ── Trigger Panel Close (UI Level) ────────────────────────────────────────
  function closeActivePanel() {
    // 1. Dispatch pointerdown / pointerup on the active switcher icon
    // (Vivaldi ToolbarButton listens to pointer events, not standard click)
    const activeSwitchBtn = document.querySelector(
      '#switch .button-toolbar.active button, #switch button.active, .button-toolbar-webpanel.active button'
    );

    if (activeSwitchBtn) {
      const downEvent = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'mouse' });
      const upEvent = new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerType: 'mouse' });
      activeSwitchBtn.dispatchEvent(downEvent);
      activeSwitchBtn.dispatchEvent(upEvent);
      return;
    }

    // 2. Fallback: trigger Vivaldi panel toggle button
    const toggleBtn = document.querySelector(
      '#panels button.panel-collapse-guard, button[name="PanelToggle"], #panels .panel-header button.close'
    );
    if (toggleBtn) {
      toggleBtn.click();
    }
  }

  // ── Discard Panel Tab via Native Chromium API ─────────────────────────────
  function discardPanel(panel) {
    const wv = getWebview(panel);
    if (!wv) return;

    const tabId = getTabId(wv);
    const src = wv.getAttribute('src') || wv.src || '';

    if (tabId && typeof chrome !== 'undefined' && chrome?.tabs?.discard) {
      chrome.tabs.discard(tabId, () => {
        if (chrome.runtime && chrome.runtime.lastError) {
          warn('chrome.tabs.discard failed for tabId:', tabId, chrome.runtime.lastError.message);
        } else {
          discardedTabs.add(tabId);
          log('Tab discarded down to 0 MB (tabId:', tabId, ')');
        }
      });
      return;
    }

    // Fallback if tab_id attribute is pending: query tabs by exact URL
    if (src && src !== 'about:blank' && typeof chrome !== 'undefined' && chrome?.tabs?.query) {
      chrome.tabs.query({}, (tabs) => {
        if (!tabs || chrome.runtime.lastError) return;
        const matchingTab = tabs.find(t => t.url === src && !t.discarded);
        if (matchingTab && !matchingTab.discarded) {
          chrome.tabs.discard(matchingTab.id, () => {
            discardedTabs.add(matchingTab.id);
            log('Tab discarded down to 0 MB via URL match (tabId:', matchingTab.id, ')');
          });
        }
      });
    }
  }

  // ── Handle Edge-Style Close (Reset URL + Glide UI + Discard RAM) ───────────
  function handleEdgeClose(panel) {
    log('Edge Close (X) action triggered');

    const wv = getWebview(panel);

    // Step 1: Reset webview & Chromium tab to clean base URL immediately
    if (wv) {
      resetWebviewToBaseUrl(panel, wv);
    }

    // Step 2: Trigger UI panel slide-out
    closeActivePanel();

    // Step 3: Discard after glide delay (150ms) to ensure smooth off-screen teardown
    setTimeout(() => {
      discardPanel(panel);
    }, GLIDE_DELAY_MS);
  }

  // ── Enforce Base URL & Wakeup on Reopen ────────────────────────────────────
  function enforceBaseUrlOnReopen(panel) {
    const wv = getWebview(panel);
    if (!wv) return;

    const configuredUrl = getPanelConfiguredUrl(panel);
    const currentSrc = wv.getAttribute('src') || wv.src || '';
    const targetUrl = configuredUrl || getCleanBaseUrlFallback(currentSrc);

    // If panel is reopening and currently on a deep chat/session link, reset to base prompt
    if (targetUrl && currentSrc && currentSrc !== targetUrl) {
      // Check if currentSrc is a deeper path/query of the target
      try {
        const currentU = new URL(currentSrc);
        const targetU = new URL(targetUrl);
        if (currentU.hostname === targetU.hostname && currentU.pathname !== targetU.pathname) {
          log('Reopened on deep session link (', currentSrc, '); redirecting to base:', targetUrl);
          resetWebviewToBaseUrl(panel, wv);
        }
      } catch (_) {}
    }

    // If tab was discarded, revive cleanly
    const tabId = getTabId(wv);
    const isDiscarded = tabId && discardedTabs.has(tabId);

    if (isDiscarded) {
      if (tabId && revivingTabs.has(tabId)) return;

      if (tabId) {
        revivingTabs.add(tabId);
        discardedTabs.delete(tabId);
      }

      log('Reviving discarded webview (tabId:', tabId, ') ->', targetUrl || currentSrc);

      if (targetUrl && targetUrl !== 'about:blank') {
        try { wv.src = targetUrl; } catch (_) {}
      } else if (typeof wv.reload === 'function') {
        try { wv.reload(); } catch (_) {}
      }

      const cleanupLock = () => {
        if (tabId) revivingTabs.delete(tabId);
        wv.removeEventListener('loadstop', cleanupLock);
        wv.removeEventListener('loadabort', cleanupLock);
      };

      wv.addEventListener('loadstop', cleanupLock);
      wv.addEventListener('loadabort', cleanupLock);

      setTimeout(() => {
        if (tabId && revivingTabs.has(tabId)) {
          revivingTabs.delete(tabId);
        }
      }, REVIVE_TIMEOUT_MS);
    }
  }

  // ── Unify / Ensure Close Button in Header ──────────────────────────────────
  function setupCloseButton(panel) {
    const header = panel.querySelector('header.webpanel-header');
    if (!header) return;

    // Attach capturing click listener to the header if not already bound
    if (!header.__edgeCloseCaptureBound) {
      header.__edgeCloseCaptureBound = true;
      header.addEventListener(
        'click',
        (e) => {
          const closeBtn = e.target.closest('button.close');
          if (closeBtn) {
            e.stopImmediatePropagation();
            e.preventDefault();
            handleEdgeClose(panel);
          }
        },
        true // Capture phase: intercepts BEFORE Vivaldi's built-in onClick
      );
    }

    // Check if Vivaldi rendered its native close button
    const nativeBtn = header.querySelector('button.close:not(.mod-edge-close-btn)');
    const modBtn = header.querySelector('button.mod-edge-close-btn');

    if (nativeBtn) {
      // Native button exists! If our custom mod button was also present, remove the duplicate
      if (modBtn) {
        modBtn.remove();
        log('Removed duplicate injected close button; bound native close button');
      }
      nativeBtn.title = 'Close Panel & Reset (Edge Style)';
      return;
    }

    // If native close button is absent, inject a single button with exact native styling
    if (!modBtn) {
      const toolbar = header.querySelector('.toolbar-default, .toolbar-group') || header;

      const btn = document.createElement('button');
      btn.className = 'close transparent mod-edge-close-btn';
      btn.title = 'Close Panel & Reset (Edge Style)';
      btn.setAttribute('aria-label', 'Close Panel');
      btn.innerHTML = `<span class="VivaldiSvgIcon" aria-hidden="true">${NATIVE_CLOSE_SVG}</span>`;

      toolbar.appendChild(btn);
      log('Injected single native-styled close button into header');
    }
  }

  // ── Panel Visibility Observation ───────────────────────────────────────────
  function handleVisibilityChange(panel) {
    const isVisible = panel.classList.contains('visible');

    if (isVisible) {
      // Panel opened / focused
      setupCloseButton(panel);
      enforceBaseUrlOnReopen(panel);
    } else {
      // Panel closed / hidden (via close button, panel switcher icon, shortcut, or auto-close)
      // Reset webview immediately so subsequent reopen starts at base URL
      const wv = getWebview(panel);
      if (wv) {
        resetWebviewToBaseUrl(panel, wv);
      }
    }
  }

  function observePanel(panel) {
    if (panel.__edgeModObserved) return;
    panel.__edgeModObserved = true;

    new MutationObserver(() => handleVisibilityChange(panel))
      .observe(panel, { attributes: true, attributeFilter: ['class'] });

    if (panel.classList.contains('visible')) {
      setupCloseButton(panel);
      enforceBaseUrlOnReopen(panel);
    }
  }

  // ── Initialization & DOM Watcher ───────────────────────────────────────────
  function scanAndInit() {
    const panels = getLivePanels();
    if (!panels.length) return false;
    panels.forEach(observePanel);

    new MutationObserver(() => {
      getLivePanels().forEach(observePanel);
    }).observe(document.body, { childList: true, subtree: true });

    return true;
  }

  function bootstrap() {
    if (scanAndInit()) return;

    const observer = new MutationObserver((_, obs) => {
      if (scanAndInit()) obs.disconnect();
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
