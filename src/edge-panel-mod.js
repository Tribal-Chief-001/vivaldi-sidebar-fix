// =============================================================================
// Edge-Style Close & Discard for Vivaldi Web Panels (Hardened Production Edition)
// =============================================================================
//
// Description:
//   Restores a clean, dedicated close (X) button to Vivaldi's web panel header even
//   when "Floating Panel" and "Auto-close Inactive Panel" are both active.
//   Seamlessly integrates with Vivaldi's native UI system without duplicate buttons.
//
//   Core Behaviors:
//     1. Preserves Warm Sessions on Auto-Hide / Toggle:
//        Clicking outside or toggling the panel icon simply hides the panel while
//        preserving the active session, form state, and chat history untouched.
//     2. Clean Base URL Reset on Explicit (X) Click:
//        Clicking the dedicated 'X' button resets the panel to its clean base URL
//        (e.g. https://gemini.google.com/app, https://x.com/, https://claude.ai/new)
//        via native Rge.home(), chrome.tabs.update(), and webview navigation.
//     3. 0.0 MB RAM Discard:
//        After an off-screen glide delay (150ms), discards the guest renderer process
//        down to 0.0 MB RAM via chrome.tabs.discard().
//     4. Resilient Atomic Wakeup:
//        Wakes up the discarded webview cleanly on reopen via source-reassignment,
//        preventing blank black screens, zombie processes, or infinite reload loops.
//     5. Instant Submit Shortcut Passthrough:
//        Protects Ctrl+Enter / Cmd+Enter inside web panels (Twitter/X, ChatGPT, Claude)
//        from being intercepted by Vivaldi's outer action dispatcher.
//     6. Edge-Case Hardening:
//        - Protects extension panels (Bitwarden, Translate) from discard or URL resets.
//        - Guards against internal schemes (chrome://, vivaldi://, file://).
//        - Atomic debounce prevents rapid-click oscillation and duplicate discards.
//        - Tab removal listener cleans state Sets, preventing memory leaks.
//        - Multi-tier close fallback works even if the sidebar switcher is hidden.
//        - Scoped MutationObserver prevents full document.body DOM thrashing.
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

  // ── State Tracking & Leak Prevention ──────────────────────────────────────
  const discardedTabs = new Set();      // Stores tab_id of discarded panels
  const revivingTabs = new Set();       // Atomic lock to prevent duplicate reload loops
  const pendingResetPanels = new Set(); // Stores panel IDs explicitly closed via the 'X' button

  // Evict closed tabs from memory tracking when destroyed in Chromium
  if (typeof chrome !== 'undefined' && chrome?.tabs?.onRemoved) {
    chrome.tabs.onRemoved.addListener((closedTabId) => {
      discardedTabs.delete(closedTabId);
      revivingTabs.delete(closedTabId);
    });
  }

  // ── Debug Logging ─────────────────────────────────────────────────────────
  const DEBUG = false;
  function log(...args) {
    if (DEBUG) console.log('[EdgePanelMod]', ...args);
  }
  function warn(...args) {
    console.warn('[EdgePanelMod]', ...args);
  }

  // ── DOM Helpers ───────────────────────────────────────────────────────────
  function getLivePanels() {
    return Array.from(document.querySelectorAll('#panels .panel, #panels .webpanel, .panel-group .panel, #panels-container .panel'));
  }

  function getWebview(panel) {
    if (!panel) return null;
    return panel.querySelector('webview') || document.querySelector('#panels webview');
  }

  function getTabId(wv) {
    if (!wv) return null;
    const raw = wv.getAttribute('tab_id') || wv.tab_id;
    const parsed = parseInt(raw, 10);
    return isNaN(parsed) ? null : parsed;
  }

  function getPanelId(panel) {
    if (!panel) return null;
    // 1. Try DOM attributes
    const idAttr = panel.getAttribute('data-id') || panel.getAttribute('id') || panel.dataset?.id;
    if (idAttr) return idAttr;

    // 2. Try Rge props
    const rge = getRgeComponent(panel);
    if (rge?.props?.webPanel?.id) return rge.props.webPanel.id;

    // 3. Fallback: webview tab_id
    const wv = getWebview(panel);
    if (wv) {
      const tabId = getTabId(wv);
      if (tabId) return `tab-${tabId}`;
    }
    return null;
  }

  // ── Extension Panel Guard ─────────────────────────────────────────────────
  // Identifies whether a panel is an internal extension view (e.g. Bitwarden,
  // Google Translate, or a Chrome Side Panel extension).
  function isExtensionPanel(panel) {
    if (!panel) return false;

    const rge = getRgeComponent(panel);
    if (rge && typeof rge.isExtension === 'function') {
      try {
        if (rge.isExtension()) return true;
      } catch (_) {}
    }

    const panelId = getPanelId(panel);
    if (panelId && typeof panelId === 'string') {
      if (panelId.startsWith('ext-') || panelId.startsWith('extension-') || panelId.startsWith('panel-ext')) {
        return true;
      }
    }

    const wv = getWebview(panel);
    const src = wv?.src || wv?.getAttribute('src') || '';
    if (src.startsWith('chrome-extension://') || src.startsWith('vivaldi://') || src.startsWith('chrome://')) {
      return true;
    }

    return false;
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
    const header = panel.querySelector('header.webpanel-header, .panel-header, header');
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
  // Resolves the original base URL configured for this web panel (e.g. https://gemini.google.com/app, https://x.com/)
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
    const header = panel.querySelector('header.webpanel-header, .panel-header, header');
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

  // Fallback heuristic: clean conversation deep links, subpaths, and query parameters back to root application URLs
  function getCleanBaseUrlFallback(currentUrl) {
    if (!currentUrl || !currentUrl.startsWith('http')) return null;
    try {
      const u = new URL(currentUrl);
      const host = u.hostname.toLowerCase();

      // Curated AI workspaces
      if (host.includes('gemini.google.com')) return 'https://gemini.google.com/app';
      if (host.includes('claude.ai')) return 'https://claude.ai/new';
      if (host.includes('chatgpt.com') || host.includes('chat.openai.com')) return 'https://chatgpt.com/';
      if (host.includes('grok.com')) return 'https://grok.com/';
      if (host.includes('copilot.microsoft.com')) return 'https://copilot.microsoft.com/';
      if (host.includes('notebooklm.google.com') || host.includes('notebook.google.com')) return 'https://notebooklm.google.com/';
      if (host.includes('perplexity.ai')) return 'https://www.perplexity.ai/';
      if (host.includes('deepseek.com')) return 'https://chat.deepseek.com/';
      if (host.includes('meta.ai')) return 'https://www.meta.ai/';
      if (host.includes('kimi.ai')) return 'https://www.kimi.ai/';
      if (host.includes('qwen.ai')) return 'https://chat.qwen.ai/';
      if (host.includes('z.ai')) return 'https://chat.z.ai/';

      // Social, productivity, and communication platforms
      if (host === 'x.com' || host === 'www.x.com' || host === 'mobile.x.com') {
        return 'https://x.com/';
      }
      if (host === 'twitter.com' || host === 'www.twitter.com' || host === 'mobile.twitter.com') {
        return 'https://twitter.com/';
      }
      if (host.includes('reddit.com')) return 'https://www.reddit.com/';
      if (host.includes('youtube.com')) return 'https://www.youtube.com/';
      if (host.includes('github.com')) return 'https://github.com/';
      if (host.includes('discord.com')) return 'https://discord.com/app';
      if (host.includes('slack.com')) return 'https://app.slack.com/';
      if (host.includes('whatsapp.com')) return 'https://web.whatsapp.com/';
      if (host.includes('telegram.org') || host.includes('web.telegram.org')) return 'https://web.telegram.org/';

      // Universal base domain fallback for ANY web panel (resets to home page of domain)
      return u.origin + '/';
    } catch (_) {
      return null;
    }
  }

  // ── Reset Webview to Base URL ───────────────────────────────────────────────
  function resetWebviewToBaseUrl(panel, wv) {
    if (!panel) return;
    if (!wv) wv = getWebview(panel);
    if (!wv) return;

    // Never reset internal extension panels (preserves Bitwarden vault, Translate state)
    if (isExtensionPanel(panel)) {
      log('Skipping URL reset on internal extension panel');
      return;
    }

    // 1. Call Vivaldi's native Rge.home() method if available
    const rge = getRgeComponent(panel);
    if (rge && typeof rge.home === 'function') {
      try {
        log('Resetting via native Vivaldi Rge.home() method');
        rge.home();
      } catch (err) {
        warn('rge.home() threw:', err);
      }
    }

    // Prioritize live DOM property over potentially stale getAttribute
    const currentSrc = wv.src || wv.getAttribute('src') || '';
    const configuredUrl = getPanelConfiguredUrl(panel);
    const targetUrl = configuredUrl || getCleanBaseUrlFallback(currentSrc) || currentSrc;

    // Internal non-http schemes (chrome://, vivaldi://, file://) must not be mutated
    if (!targetUrl || !targetUrl.startsWith('http')) return;

    const tabId = getTabId(wv);

    log('Resetting web panel (tabId:', tabId, ') to base URL:', targetUrl);

    // 2. Direct Chromium tab navigation via chrome.tabs.update
    if (tabId && typeof chrome !== 'undefined' && chrome?.tabs?.update) {
      try {
        chrome.tabs.update(tabId, { url: targetUrl });
      } catch (err) {
        warn('chrome.tabs.update failed:', err);
      }
    }

    // 3. Webview navigation & state refresh
    try {
      if (wv.src !== targetUrl) {
        wv.src = targetUrl;
      } else if (typeof wv.reload === 'function') {
        wv.reload(); // Force state reset if URL was already identical to base URL
      }
    } catch (_) {}
  }

  // ── Multi-Tier Panel Close Trigger (UI Level) ──────────────────────────────
  function closeActivePanel(panel) {
    // 1. Dispatch pointerdown / pointerup on the active switcher button
    // (Vivaldi ToolbarButton listens to pointer events, not click)
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
      '#panels button.panel-collapse-guard, button[name="PanelToggle"], #panels .panel-header button.close, #panels header button.close'
    );
    if (toggleBtn && typeof toggleBtn.click === 'function') {
      toggleBtn.click();
      return;
    }

    // 3. Fallback: dispatch synthetic F4 shortcut to document
    try {
      const f4Event = new KeyboardEvent('keydown', { key: 'F4', code: 'F4', keyCode: 115, which: 115, bubbles: true, cancelable: true });
      document.dispatchEvent(f4Event);
    } catch (_) {}

    // 4. Direct DOM class removal fallback
    if (panel && panel.classList.contains('visible')) {
      panel.classList.remove('visible');
    }
  }

  // ── Discard Panel Tab via Native Chromium API ─────────────────────────────
  function discardPanel(panel) {
    if (isExtensionPanel(panel)) {
      log('Skipping discard on internal extension panel');
      return;
    }

    const wv = getWebview(panel);
    if (!wv) return;

    const tabId = getTabId(wv);
    const src = wv.src || wv.getAttribute('src') || '';

    // Safety guard: only discard external web URLs (never internal schemes)
    if (src && !src.startsWith('http')) return;

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
    if (src && src.startsWith('http') && typeof chrome !== 'undefined' && chrome?.tabs?.query) {
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
  // ONLY triggered when the user explicitly clicks the 'X' button!
  function handleEdgeClose(panel) {
    if (!panel || panel.__isClosing) return; // Atomic re-entrance lock against rapid clicks
    panel.__isClosing = true;

    // Clear any pending discard timer on this panel
    if (panel.__glideDiscardTimer) {
      clearTimeout(panel.__glideDiscardTimer);
      panel.__glideDiscardTimer = null;
    }

    log('Edge Close (X) action triggered — flagging panel for clean reset');

    const panelId = getPanelId(panel);
    if (panelId) {
      pendingResetPanels.add(panelId);
    }

    const wv = getWebview(panel);

    // Step 1: Immediately reset webview & Chromium tab to clean base URL
    if (wv) {
      resetWebviewToBaseUrl(panel, wv);
    }

    // Step 2: Trigger UI panel slide-out
    closeActivePanel(panel);

    // Step 3: Discard after glide delay (150ms) to ensure smooth off-screen teardown
    panel.__glideDiscardTimer = setTimeout(() => {
      panel.__glideDiscardTimer = null;
      panel.__isClosing = false;
      discardPanel(panel);
    }, GLIDE_DELAY_MS);
  }

  // ── Global Native Rge Close Bridge ──────────────────────────────────────────
  // Called directly when the user clicks Vivaldi's native close button in Rge toolbar
  window.__edgeCloseWebPanel = function (rge) {
    if (!rge) return;
    try {
      const panelId = rge.props?.webPanel?.id;
      const configuredUrl = rge.props?.webPanel?.url;
      const wv = rge.refWebpanelwebview?.current;
      const tabId = rge.props?.tabId || (wv ? getTabId(wv) : null);
      const domPanel = rge.nodeRef?.current || (panelId ? document.querySelector(`#panels [data-id="${panelId}"], #panels .panel, #panels .webpanel`) : null);

      if (panelId) {
        pendingResetPanels.add(panelId);
      }

      // 1. Reset via native home() if not extension
      if (typeof rge.home === 'function' && !isExtensionPanel(domPanel)) {
        try { rge.home(); } catch (_) {}
      }

      // 2. Compute target base URL and update Chromium tab
      const currentSrc = wv ? (wv.src || wv.getAttribute('src')) : null;
      const targetUrl = configuredUrl || getCleanBaseUrlFallback(currentSrc) || (currentSrc ? new URL(currentSrc).origin + '/' : null);

      if (tabId && targetUrl && targetUrl.startsWith('http') && typeof chrome !== 'undefined' && chrome?.tabs?.update) {
        try {
          chrome.tabs.update(tabId, { url: targetUrl });
        } catch (_) {}
      }

      if (wv && targetUrl && wv.src !== targetUrl) {
        try { wv.src = targetUrl; } catch (_) {}
      }

      // 3. Close panel UI
      if (domPanel) {
        closeActivePanel(domPanel);
      }

      // 4. Discard after glide delay
      if (tabId && targetUrl && targetUrl.startsWith('http') && typeof chrome !== 'undefined' && chrome?.tabs?.discard) {
        setTimeout(() => {
          chrome.tabs.discard(tabId, () => {
            discardedTabs.add(tabId);
          });
        }, GLIDE_DELAY_MS);
      }
    } catch (err) {
      console.warn('__edgeCloseWebPanel error:', err);
    }
  };

  // ── Handle Reopen ──────────────────────────────────────────────────────────
  function handleReopen(panel) {
    if (!panel) return;

    // Cancel any pending discard timer immediately upon reopening
    if (panel.__glideDiscardTimer) {
      clearTimeout(panel.__glideDiscardTimer);
      panel.__glideDiscardTimer = null;
      log('Reopened panel before discard timer elapsed; cancelled pending discard');
    }
    panel.__isClosing = false;

    const wv = getWebview(panel);
    if (!wv) return;

    const panelId = getPanelId(panel);
    const wasExplicitlyClosed = panelId && pendingResetPanels.has(panelId);

    if (wasExplicitlyClosed) {
      pendingResetPanels.delete(panelId);
      log('Reopening explicitly closed panel; ensuring clean base URL state');
      resetWebviewToBaseUrl(panel, wv);
    } else {
      // Panel was simply auto-hidden or toggled! Preserve existing conversation completely.
      log('Reopening auto-hidden/toggled panel; preserving active session untouched');
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

      log('Reviving discarded webview (tabId:', tabId, ')');

      // To respawn a severed guest process in Chromium, re-assign wv.src
      const currentSrc = wv.src || wv.getAttribute('src');
      if (currentSrc) {
        wv.src = currentSrc;
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
    const header = panel.querySelector('header.webpanel-header, .panel-header, header');
    if (!header) return;

    // Attach capturing click listener to the header if not already bound
    if (!header.__edgeCloseCaptureBound) {
      header.__edgeCloseCaptureBound = true;
      header.addEventListener(
        'click',
        (e) => {
          const closeBtn = e.target.closest('button.close, .mod-edge-close-btn, [aria-label="Close Panel"]');
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
      nativeBtn.setAttribute('tabindex', '-1');
      return;
    }

    // If native close button is absent, inject a single button with exact native styling
    if (!modBtn) {
      const toolbar = header.querySelector('.toolbar-default, .toolbar-group') || header;

      const btn = document.createElement('button');
      btn.className = 'close transparent mod-edge-close-btn';
      btn.title = 'Close Panel & Reset (Edge Style)';
      btn.setAttribute('aria-label', 'Close Panel');
      btn.setAttribute('tabindex', '-1');
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
      handleReopen(panel);
    } else {
      // Panel hidden via auto-hide or switcher click:
      // DO NOT reset URL! DO NOT discard tab! Preserve session untouched.
      log('Panel hidden (auto-hide or switcher toggle); session preserved.');
    }
  }

  function observePanel(panel) {
    if (panel.__edgeModObserved) return;
    panel.__edgeModObserved = true;

    new MutationObserver(() => handleVisibilityChange(panel))
      .observe(panel, { attributes: true, attributeFilter: ['class'] });

    if (panel.classList.contains('visible')) {
      setupCloseButton(panel);
      handleReopen(panel);
    }
  }

  // ── Web Panel Shortcut Passthrough & Key Event Guard ─────────────────────────
  // Prevents Vivaldi UI from swallowing text-editing shortcuts (Ctrl+Enter, Meta+Enter,
  // Shift+Enter, Ctrl+Shift+Enter) when focus is inside a Web Panel (e.g. Twitter/X
  // tweet submission, ChatGPT, Claude, GitHub comments, Discord, Slack).
  let shortcutGuardActive = false;
  function setupPanelShortcutGuard() {
    if (shortcutGuardActive) return;
    shortcutGuardActive = true;

    window.addEventListener('keydown', (e) => {
      const activeEl = document.activeElement;
      const target = e.target;
      const isInsidePanel = Boolean(
        (activeEl && (activeEl.closest('#panels') || activeEl.closest('.webpanel') || activeEl.tagName === 'WEBVIEW')) ||
        (target && (target.closest('#panels') || target.closest('.webpanel') || target.tagName === 'WEBVIEW'))
      );

      if (!isInsidePanel) return;

      const isEnter = e.key === 'Enter' || e.code === 'Enter';
      const isModifierEnter = isEnter && (e.ctrlKey || e.metaKey || e.shiftKey);

      if (isModifierEnter) {
        // Stop immediate propagation to outer Vivaldi action dispatchers so the keystroke
        // is delivered directly into the webview guest process without browser hijacking
        if (e.stopImmediatePropagation) {
          e.stopImmediatePropagation();
        } else {
          e.stopPropagation();
        }
      }
    }, true);
  }

  // ── Global Fallback Close Click Guard ──────────────────────────────────────
  document.addEventListener('click', (e) => {
    const closeBtn = e.target.closest('#panels button.close, #panels .mod-edge-close-btn, #panels [aria-label="Close Panel"]');
    if (closeBtn) {
      const panel = closeBtn.closest('.panel, .webpanel, #panels > div') || getLivePanels()[0];
      if (panel) {
        e.preventDefault();
        e.stopImmediatePropagation();
        handleEdgeClose(panel);
      }
    }
  }, true);

  // ── Initialization & Scoped Container Watcher ──────────────────────────────
  function scanAndInit() {
    setupPanelShortcutGuard();
    const panels = getLivePanels();
    if (!panels.length) return false;
    panels.forEach(observePanel);

    // Scope observer strictly to the panels container rather than document.body
    // to eliminate full-window DOM thrashing on every keystroke or tab switch.
    const container = document.querySelector('#panels-container') || document.querySelector('#panels') || document.body;
    new MutationObserver(() => {
      getLivePanels().forEach(observePanel);
    }).observe(container, { childList: true, subtree: false });

    return true;
  }

  function bootstrap() {
    setupPanelShortcutGuard();
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
