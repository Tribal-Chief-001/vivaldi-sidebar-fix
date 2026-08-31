// =============================================================================
// Edge-Style Close & Discard for Vivaldi Web Panels (Production Edition)
// =============================================================================
//
// Description:
//   Restores a dedicated close (X) button to Vivaldi's web panel header even
//   when "Floating Panel" and "Auto-close Inactive Panel" are both active.
//   When clicked, resets the panel to its original configured base URL (so you
//   always open to a fresh new session instead of an old conversation),
//   triggers a two-stage glide teardown, and discards the guest renderer process
//   down to 0.0 MB RAM via chrome.tabs.discard().
//   On reopen, cleanly wakes up the discarded webview with atomic lock protection,
//   preventing blank boxes and reload loops.
// =============================================================================

(function () {
  'use strict';

  // ── Configuration ─────────────────────────────────────────────────────────
  const GLIDE_DELAY_MS = 150; // Delay to allow panel exit animation before tab discard
  const REVIVE_TIMEOUT_MS = 2500; // Safety timeout for wakeup lock release

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

  // ── Base URL Resolution ───────────────────────────────────────────────────
  // Resolves the original URL configured for this web panel (e.g. https://gemini.google.com/app)
  // so that closing the panel returns it to a fresh prompt rather than an old chat.
  function getPanelConfiguredUrl(panel) {
    if (!panel) return null;

    // 1. Try extracting webPanel.url from React Fiber / Props
    for (const key of Object.keys(panel)) {
      if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
        let fiber = panel[key];
        while (fiber) {
          if (fiber.memoizedProps?.webPanel?.url) {
            return fiber.memoizedProps.webPanel.url;
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

    // 2. Try header React instance
    const header = panel.querySelector('header.webpanel-header');
    if (header) {
      for (const key of Object.keys(header)) {
        if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
          let fiber = header[key];
          while (fiber) {
            if (fiber.memoizedProps?.webPanel?.url) {
              return fiber.memoizedProps.webPanel.url;
            }
            fiber = fiber.return;
          }
        }
      }
    }

    return null;
  }

  function resetWebviewToBaseUrl(panel, wv) {
    if (!panel || !wv) return;

    // 1. If Vivaldi's native Home button is present in the panel header,
    // clicking it executes Vivaldi's internal: home = () => { wv.src = this.props.webPanel.url; }
    const homeBtn = panel.querySelector(
      'header.webpanel-header button[title="Home"], header.webpanel-header button[aria-label="Home"]'
    );
    if (homeBtn && typeof homeBtn.click === 'function') {
      try {
        homeBtn.click();
        log('Reset panel to base URL via native Home button');
        return;
      } catch (_) {}
    }

    // 2. Extracted base URL from React props
    const configuredUrl = getPanelConfiguredUrl(panel);
    if (configuredUrl) {
      wv.src = configuredUrl;
      log('Reset panel to configured base URL:', configuredUrl);
      return;
    }

    // 3. Fallback: truncate chat sub-paths back to origin root (e.g. https://gemini.google.com/app)
    const currentSrc = wv.getAttribute('src') || '';
    if (currentSrc && currentSrc.startsWith('http')) {
      try {
        const u = new URL(currentSrc);
        // Special case for Gemini / Claude / ChatGPT base paths
        if (u.hostname.includes('gemini.google.com')) {
          wv.src = 'https://gemini.google.com/app';
        } else if (u.hostname.includes('claude.ai')) {
          wv.src = 'https://claude.ai/new';
        } else if (u.hostname.includes('chatgpt.com')) {
          wv.src = 'https://chatgpt.com/';
        } else if (u.hostname.includes('grok.com')) {
          wv.src = 'https://grok.com/';
        } else {
          wv.src = u.origin;
        }
        log('Reset panel to calculated base URL:', wv.src);
      } catch (_) {}
    }
  }

  // ── Trigger Panel Close (UI Level) ────────────────────────────────────────
  function closeActivePanel() {
    // 1. First try: dispatch pointerdown / pointerup on the active switcher icon
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
    const src = wv.getAttribute('src') || '';

    if (tabId) {
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
    if (src && src !== 'about:blank') {
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

  // ── Revive Discarded Panel on Reopen ───────────────────────────────────────
  function revivePanelIfNeeded(panel) {
    const wv = getWebview(panel);
    if (!wv) return;

    const tabId = getTabId(wv);
    const isDiscarded = tabId && discardedTabs.has(tabId);

    if (!isDiscarded) return;

    if (tabId && revivingTabs.has(tabId)) {
      return; // Already reviving, avoid loop
    }

    if (tabId) {
      revivingTabs.add(tabId);
      discardedTabs.delete(tabId);
    }

    // Determine target URL: prefer the original configured base URL so it opens clean
    const configuredUrl = getPanelConfiguredUrl(panel);
    const targetUrl = configuredUrl || wv.getAttribute('src') || '';

    log('Reviving discarded webview (tabId:', tabId, ') ->', targetUrl);

    // Resetting wv.src forces Chromium's content layer to re-spawn
    // the guest RenderProcessHost from scratch, avoiding dead blank webviews
    if (targetUrl && targetUrl !== 'about:blank') {
      wv.src = targetUrl;
    } else if (typeof wv.reload === 'function') {
      try { wv.reload(); } catch (_) {}
    }

    // Release lock on load completion or safety timeout
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

  // ── Inject Close Button into Header ────────────────────────────────────────
  function injectCloseButton(panel) {
    if (panel.querySelector('.mod-edge-close-btn')) return;

    const header = panel.querySelector('header.webpanel-header');
    if (!header) return;

    // Locate toolbar container inside header
    const toolbar = header.querySelector('.toolbar-default, .toolbar-group');
    if (!toolbar) return;

    const btn = document.createElement('button');
    btn.className = 'close transparent mod-edge-close-btn ToolbarButton-Button';
    btn.title = 'Close, Reset to Base URL & Discard (Edge Style)';
    btn.setAttribute('aria-label', 'Close & Discard Web Panel');
    btn.style.cssText = [
      'cursor: pointer',
      'display: inline-flex',
      'align-items: center',
      'justify-content: center',
      'margin-left: auto',
      'padding: 4px 6px',
      'border-radius: 4px',
      'opacity: 0.8',
      'transition: opacity 0.15s ease, background-color 0.15s ease'
    ].join(';');

    btn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="18" y1="6" x2="6" y2="18"></line>
        <line x1="6" y1="6" x2="18" y2="18"></line>
      </svg>
    `;

    btn.addEventListener('mouseenter', () => {
      btn.style.opacity = '1';
      btn.style.backgroundColor = 'var(--colorBgAlphaHover, rgba(255, 255, 255, 0.1))';
    });

    btn.addEventListener('mouseleave', () => {
      btn.style.opacity = '0.8';
      btn.style.backgroundColor = 'transparent';
    });

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();

      log('Manual Close (X) triggered');

      const wv = getWebview(panel);

      // Step 1: Reset webview URL to base configured URL (new chat state)
      if (wv) {
        resetWebviewToBaseUrl(panel, wv);
      }

      // Step 2: Trigger UI panel slide-out
      closeActivePanel();

      // Step 3: Discard after glide delay (150ms) to ensure smooth off-screen teardown
      setTimeout(() => {
        discardPanel(panel);
      }, GLIDE_DELAY_MS);
    });

    toolbar.appendChild(btn);
  }

  // ── Panel Visibility Observation ───────────────────────────────────────────
  function handleVisibilityChange(panel) {
    const isVisible = panel.classList.contains('visible');

    if (isVisible) {
      injectCloseButton(panel);
      revivePanelIfNeeded(panel);
    }
  }

  function observePanel(panel) {
    if (panel.__edgeModObserved) return;
    panel.__edgeModObserved = true;

    new MutationObserver(() => handleVisibilityChange(panel))
      .observe(panel, { attributes: true, attributeFilter: ['class'] });

    if (panel.classList.contains('visible')) {
      injectCloseButton(panel);
      revivePanelIfNeeded(panel);
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
