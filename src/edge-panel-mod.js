// =============================================================================
// Edge-Style Close & Discard for Vivaldi Web Panels — Root-Cause Fix
// =============================================================================
//
// Why previous fixes failed:
//   Previous iterations used chrome.tabs.discard() on close. Discard only suspends
//   the tab in memory — it does NOT remove the tabId from Vivaldi's internal panel
//   tab registry (Pge.Z). So when the panel reopened:
//     1. Rge._createRelatedTab() checked _getRelatedTabId() → found existing tabId → returned early
//     2. this.home() set wv.src, but Chromium simultaneously un-discarded the old tab
//        and restored its session history → RACE CONDITION → old URL won
//
// The correct fix:
//   On explicit (X) close, call chrome.tabs.remove(tabId). This triggers Chromium's
//   chrome.tabs.onRemoved event, which Vivaldi's internal pe() handler catches and
//   calls Pge.Z.offerEraseTabId(tabId) — completely wiping the tabId from the registry.
//   On reopen, _getRelatedTabId() returns undefined, so _createRelatedTab() runs fully:
//     r.Z.tabs.create({ url: this.props.webPanel.url, ... })
//   Creating a 100% fresh tab with zero navigation history. No race. No session restore.
//
// =============================================================================

(function () {
  'use strict';

  // ── Configuration ─────────────────────────────────────────────────────────
  const GLIDE_DELAY_MS = 150;     // Delay for panel exit animation before tab teardown
  const REVIVE_TIMEOUT_MS = 2500; // Safety timeout for wakeup lock release

  // Exact native Vivaldi close icon SVG (from Vivaldi's core icon library Pe.kze)
  const NATIVE_CLOSE_SVG = [
    '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">',
    '  <path d="M4.293 4.293a1 1 0 0 1 1.414 0L8 6.586l2.293-2.293a1 1 0 1 1 1.414 1.414L9.414 8l2.293 2.293a1 1 0 0 1-1.414 1.414L8 9.414l-2.293 2.293a1 1 0 0 1-1.414-1.414L6.586 8 4.293 5.707a1 1 0 0 1 0-1.414Z"/>',
    '</svg>'
  ].join('');

  // ── State Tracking ────────────────────────────────────────────────────────
  const closedPanelsForReset = new Set(); // Panel IDs flagged for fresh tab creation on reopen
  const revivingTabs = new Set();          // Atomic lock to prevent duplicate reload loops

  // ── React Bridge: Reopen Signal ───────────────────────────────────────────
  // Called by Rge.componentDidUpdate in bundle.js when panel transitions hidden → visible.
  // Returns true if this panel was explicitly closed via (X) and needs a fresh tab.
  window.__edgeShouldReset = function (panelId) {
    if (!panelId) return false;
    if (closedPanelsForReset.has(panelId)) {
      closedPanelsForReset.delete(panelId);
      log('__edgeShouldReset: true for panel', panelId, '→ _createRelatedTab() + home() will fire');
      return true;
    }
    return false;
  };

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
    return Array.from(document.querySelectorAll(
      '#panels .panel, #panels .webpanel, .panel-group .panel, #panels-container .panel'
    ));
  }

  function getWebview(panel) {
    if (!panel) return document.querySelector('#panels webview');
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
    const idAttr = panel.getAttribute('data-id') || panel.getAttribute('id') || panel.dataset?.id;
    if (idAttr && idAttr !== 'panels') return idAttr;

    const rge = getRgeComponent(panel);
    if (rge?.props?.webPanel?.id) return rge.props.webPanel.id;

    const wv = getWebview(panel);
    if (wv) {
      const tabId = getTabId(wv);
      if (tabId) return `tab-${tabId}`;
    }
    return null;
  }

  // ── Extension Panel Guard ─────────────────────────────────────────────────
  function isExtensionPanel(panel) {
    if (!panel) return false;

    const rge = getRgeComponent(panel);
    if (rge && typeof rge.isExtension === 'function') {
      try { if (rge.isExtension()) return true; } catch (_) {}
    }

    const panelId = getPanelId(panel);
    if (panelId && typeof panelId === 'string') {
      if (/^(ext-|extension-|panel-ext|EXT_PANEL_)/.test(panelId)) return true;
    }

    const wv = getWebview(panel);
    const src = wv?.src || wv?.getAttribute('src') || '';
    if (/^(chrome-extension:|vivaldi:|chrome:)/.test(src)) return true;

    return false;
  }

  // ── Rge (WebPanel Component) Resolver ────────────────────────────────────
  function getRgeComponent(panel) {
    if (!panel) return null;

    for (const key of Object.keys(panel)) {
      if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
        let fiber = panel[key];
        while (fiber) {
          if (fiber.stateNode && typeof fiber.stateNode.home === 'function') {
            return fiber.stateNode;
          }
          if (fiber.child?.stateNode && typeof fiber.child.stateNode.home === 'function') {
            return fiber.child.stateNode;
          }
          fiber = fiber.return;
        }
      }
    }

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

  // ── Multi-Tier Panel Close Trigger (UI Level) ──────────────────────────────
  // Toggles the panel closed via the sidebar switcher button, which dispatches
  // PANEL_CLOSE and sets contentVisible=false → Rge receives isVisible=false.
  function closeActivePanel(panel) {
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

    const toggleBtn = document.querySelector(
      '#panels button.panel-collapse-guard, button[name="PanelToggle"], #panels .panel-header button.close, #panels header button.close'
    );
    if (toggleBtn && typeof toggleBtn.click === 'function') {
      toggleBtn.click();
      return;
    }

    try {
      const f4Event = new KeyboardEvent('keydown', { key: 'F4', code: 'F4', keyCode: 115, which: 115, bubbles: true, cancelable: true });
      document.dispatchEvent(f4Event);
    } catch (_) {}

    if (panel && panel.classList.contains('visible')) {
      panel.classList.remove('visible');
    }
  }

  // ── Destroy Panel Tab via chrome.tabs.remove() ────────────────────────────
  // THIS IS THE KEY FIX: remove() (not discard()) completely destroys the tab.
  // Chromium fires chrome.tabs.onRemoved → Vivaldi's pe() handler calls
  // Pge.Z.offerEraseTabId() → tabId wiped from Pge.Z registry.
  // On reopen, _getRelatedTabId() returns undefined → _createRelatedTab() creates fresh tab.
  function destroyPanelTab(panel) {
    if (isExtensionPanel(panel)) {
      log('Skipping tab destruction on extension panel');
      return;
    }

    const wv = getWebview(panel);
    if (!wv) return;

    const tabId = getTabId(wv);
    const src = wv.src || wv.getAttribute('src') || '';

    if (src && !src.startsWith('http')) return;

    if (tabId && typeof chrome !== 'undefined' && chrome?.tabs?.remove) {
      log('Destroying tab via chrome.tabs.remove (tabId:', tabId, ')');
      chrome.tabs.remove(tabId, () => {
        if (chrome.runtime?.lastError) {
          warn('chrome.tabs.remove failed for tabId:', tabId, chrome.runtime.lastError.message);
        } else {
          log('Tab fully removed from Chromium and Pge.Z (tabId:', tabId, ')');
        }
      });
    }
  }

  // ── Handle Edge-Style Close (X): Flag + Close UI + Destroy Tab ────────────
  function handleEdgeClose(panel) {
    if (!panel || panel.__isClosing) return;
    panel.__isClosing = true;

    if (panel.__glideTimer) {
      clearTimeout(panel.__glideTimer);
      panel.__glideTimer = null;
    }

    log('Edge Close (X) triggered — will destroy tab and flag for fresh creation');

    // Dismiss active permission prompts and deny pending requests on close
    dismissAllPanelPrompts(panel, true);

    const panelId = getPanelId(panel);

    // Flag this panel so __edgeShouldReset returns true on reopen
    if (panelId) closedPanelsForReset.add(panelId);

    // Close the panel UI (triggers PANEL_CLOSE → contentVisible=false → isVisible=false)
    closeActivePanel(panel);

    // After glide animation, fully destroy the underlying Chromium tab
    panel.__glideTimer = setTimeout(() => {
      panel.__glideTimer = null;
      panel.__isClosing = false;
      destroyPanelTab(panel);
    }, GLIDE_DELAY_MS);
  }

  // ── Global Native Rge Close Bridge ──────────────────────────────────────────
  // Called from patched bundle.js when the native Rge close button is clicked.
  // Has direct access to the Rge component instance ('this' in Rge render).
  window.__edgeCloseWebPanel = function (rge) {
    if (!rge) return;
    try {
      const panelId = rge.props?.webPanel?.id;
      const wv = rge.refWebpanelwebview?.current || document.querySelector('#panels webview');
      const tabId = rge.props?.tabId || (wv ? getTabId(wv) : null);
      const domPanel = rge.nodeRef?.current ||
        (panelId ? document.querySelector(`#panels [data-id="${panelId}"], #panels .panel, #panels .webpanel`) : null);

      // Flag for fresh tab creation on reopen
      if (panelId) closedPanelsForReset.add(panelId);

      // Dismiss active permission prompts on native close
      if (domPanel) {
        dismissAllPanelPrompts(domPanel, true);
        closeActivePanel(domPanel);
      } else {
        closeActivePanel();
      }

      // Fully destroy the tab (not discard!)
      if (tabId && typeof chrome !== 'undefined' && chrome?.tabs?.remove) {
        setTimeout(() => {
          log('Destroying tab via __edgeCloseWebPanel (tabId:', tabId, ')');
          chrome.tabs.remove(tabId, () => {
            if (chrome.runtime?.lastError) {
              warn('chrome.tabs.remove failed:', chrome.runtime.lastError.message);
            } else {
              log('Tab fully removed (tabId:', tabId, ')');
            }
          });
        }, GLIDE_DELAY_MS);
      }
    } catch (err) {
      console.warn('[EdgePanelMod] __edgeCloseWebPanel error:', err);
    }
  };

  // ── Handle Reopen ──────────────────────────────────────────────────────────
  // When panel becomes visible again after being hidden.
  // For explicit (X) closes: the bundle.js patch handles reset via componentDidUpdate
  //   (_createRelatedTab() + home()) — we don't need to do anything here for those.
  // For auto-hide (multitasking): the tab was never destroyed, so the session is warm.
  //   Nothing to do.
  function handleReopen(panel) {
    if (!panel) return;

    // Cancel any pending destruction if user reopened before glide timer
    if (panel.__glideTimer) {
      clearTimeout(panel.__glideTimer);
      panel.__glideTimer = null;
      log('Reopened panel before destruction timer; cancelled pending tab removal');
    }
    panel.__isClosing = false;
  }

  // ── Unify / Ensure Close Button in Header ──────────────────────────────────
  function setupCloseButton(panel) {
    const header = panel.querySelector('header.webpanel-header, .panel-header, header');
    if (!header) return;

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
        true
      );
    }

    const nativeBtn = header.querySelector('button.close:not(.mod-edge-close-btn)');
    const modBtn = header.querySelector('button.mod-edge-close-btn');

    if (nativeBtn) {
      if (modBtn) {
        modBtn.remove();
        log('Removed duplicate injected close button; using native close button');
      }
      nativeBtn.title = 'Close Panel & Reset (Edge Style)';
      nativeBtn.setAttribute('tabindex', '-1');
      return;
    }

    if (!modBtn) {
      const toolbar = header.querySelector('.toolbar-default, .toolbar-group') || header;

      const btn = document.createElement('button');
      btn.className = 'close transparent mod-edge-close-btn';
      btn.title = 'Close Panel & Reset (Edge Style)';
      btn.setAttribute('aria-label', 'Close Panel');
      btn.setAttribute('tabindex', '-1');
      btn.innerHTML = `<span class="VivaldiSvgIcon" aria-hidden="true">${NATIVE_CLOSE_SVG}</span>`;

      toolbar.appendChild(btn);
      log('Injected close button into header');
    }
  }

  // =============================================================================
  // In-Panel Permission Prompt Subsystem (R1, R2, R3)
  // =============================================================================
  const PERM_STORAGE_KEY = 'vivaldi_sidebar_permissions';
  const SENSITIVE_PERMISSIONS = new Set(['media', 'geolocation', 'notifications', 'notification']);
  const memoryStore = new Map();

  const PERMISSION_CSS = [
    '.edge-permission-banner {',
    '  position: absolute;',
    '  top: 0;',
    '  left: 0;',
    '  right: 0;',
    '  z-index: 9999;',
    '  display: flex;',
    '  align-items: center;',
    '  justify-content: space-between;',
    '  gap: 8px;',
    '  padding: 8px 12px;',
    '  background: var(--colorBgAlphaBlur, var(--colorBg, #252830));',
    '  backdrop-filter: blur(16px);',
    '  -webkit-backdrop-filter: blur(16px);',
    '  border-bottom: 1px solid var(--colorBorder, rgba(255, 255, 255, 0.12));',
    '  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);',
    '  color: var(--colorFg, #d8dee9);',
    '  font-size: 12px;',
    '  font-family: inherit;',
    '  box-sizing: border-box;',
    '}',
    '.edge-perm-text {',
    '  flex: 1;',
    '  overflow: hidden;',
    '  text-overflow: ellipsis;',
    '  white-space: nowrap;',
    '  font-size: 12px;',
    '}',
    '.edge-perm-actions {',
    '  display: flex;',
    '  align-items: center;',
    '  gap: 6px;',
    '  flex-shrink: 0;',
    '}',
    '.edge-perm-btn {',
    '  border: 1px solid var(--colorBorder, rgba(255, 255, 255, 0.15));',
    '  border-radius: 4px;',
    '  padding: 4px 10px;',
    '  font-size: 11px;',
    '  font-weight: 500;',
    '  cursor: pointer;',
    '}',
    '.edge-perm-allow {',
    '  background: var(--colorHighlightBg, #0078d4);',
    '  color: var(--colorHighlightFg, #ffffff);',
    '  border-color: transparent;',
    '}',
    '.edge-perm-block {',
    '  background: var(--colorBtnBg, rgba(255, 255, 255, 0.1));',
    '  color: var(--colorFg, #d8dee9);',
    '}'
  ].join('\n');

  function ensurePermissionStyles() {
    try {
      if (!document.querySelector('#edge-permission-style')) {
        const headOrBody = document.head || document.body;
        if (headOrBody) {
          const style = document.createElement('style');
          style.id = 'edge-permission-style';
          style.textContent = PERMISSION_CSS;
          headOrBody.appendChild(style);
        }
      }
    } catch (_) {}
  }

  function getStorage() {
    try {
      if (typeof localStorage !== 'undefined' && localStorage) {
        return localStorage;
      }
    } catch (_) {}
    return null;
  }

  function loadAllPermissions() {
    const storage = getStorage();
    if (storage) {
      try {
        const raw = storage.getItem(PERM_STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed;
        }
        return {};
      } catch (_) {
        return {};
      }
    }
    const mem = memoryStore.get(PERM_STORAGE_KEY);
    return mem ? { ...mem } : {};
  }

  function saveAllPermissions(data) {
    const storage = getStorage();
    if (storage) {
      try {
        storage.setItem(PERM_STORAGE_KEY, JSON.stringify(data));
        return;
      } catch (_) {}
    }
    memoryStore.set(PERM_STORAGE_KEY, data);
  }

  function isSavableOrigin(origin) {
    if (!origin || typeof origin !== 'string') return false;
    if (origin === 'null' || origin === 'about:blank') return false;
    return /^https?:\/\//i.test(origin);
  }

  function getStoredPermission(origin, permission) {
    if (!isSavableOrigin(origin)) return null;
    const data = loadAllPermissions();
    const originEntry = data[origin];
    if (!originEntry || typeof originEntry !== 'object') return null;
    const permVal = originEntry[permission];
    if (!permVal) return null;
    if (typeof permVal === 'string') return permVal.toLowerCase();
    if (typeof permVal === 'object') return (permVal.decision || permVal.state || '').toLowerCase();
    return null;
  }

  function setStoredPermission(origin, permission, decision) {
    if (!isSavableOrigin(origin)) return;
    const data = loadAllPermissions();
    if (!data[origin] || typeof data[origin] !== 'object') {
      data[origin] = {};
    }
    data[origin][permission] = decision;
    saveAllPermissions(data);
  }

  function revokeStoredPermission(origin, permission) {
    if (!origin) return;
    const data = loadAllPermissions();
    if (data[origin] && typeof data[origin] === 'object') {
      if (permission) {
        delete data[origin][permission];
        if (Object.keys(data[origin]).length === 0) {
          delete data[origin];
        }
      } else {
        delete data[origin];
      }
      saveAllPermissions(data);
    }
  }

  function clearAllStoredPermissions() {
    const storage = getStorage();
    if (storage) {
      try {
        storage.removeItem(PERM_STORAGE_KEY);
      } catch (_) {}
    }
    memoryStore.delete(PERM_STORAGE_KEY);
  }

  // Global APIs for debugging, user revocation, and test suites
  window.__edgeRevokePermission = function (origin, permission) {
    revokeStoredPermission(origin, permission);
  };

  window.__edgeClearAllPermissions = function () {
    clearAllStoredPermissions();
  };

  window.__edgePanelPermissions = {
    get: getStoredPermission,
    set: setStoredPermission,
    revoke: revokeStoredPermission,
    clear: clearAllStoredPermissions,
    getAll: loadAllPermissions
  };

  function extractOriginAndHost(rawUrl, wv) {
    let target = rawUrl;
    if ((!target || typeof target !== 'string' || !target.trim()) && wv) {
      target = wv.src || (typeof wv.getAttribute === 'function' ? wv.getAttribute('src') : '') || '';
    }

    let origin = null;
    let host = '';

    if (target && typeof target === 'string') {
      try {
        const parsed = new URL(target);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          origin = parsed.origin;
          host = parsed.hostname || parsed.host || parsed.origin;
        } else if (parsed.protocol) {
          host = target;
        }
      } catch (_) {
        host = target;
      }
    }

    return { origin, host: host || 'this site' };
  }

  function getResourceLabel(permission) {
    switch (permission) {
      case 'media':
        return 'Microphone & Camera';
      case 'geolocation':
        return 'Location';
      case 'notifications':
      case 'notification':
        return 'Notifications';
      default:
        return permission;
    }
  }

  function safeRespond(request, allow) {
    if (!request) return;
    try {
      if (allow) request.allow();
      else request.deny();
    } catch (err) {
      warn('Safe respond error:', err);
    }
  }

  function attachBannerToPanel(panel, banner) {
    const content = (panel.querySelector && panel.querySelector('section.webpanel-content')) || panel;
    if (typeof content.prepend === 'function') {
      content.prepend(banner);
    } else if (content.firstChild) {
      content.insertBefore(banner, content.firstChild);
    } else {
      content.appendChild(banner);
    }
  }

  function dismissAllPanelPrompts(panel, andDeny = true) {
    if (!panel) return;
    if (panel.__edgeActivePermRequest) {
      const active = panel.__edgeActivePermRequest;
      if (andDeny) {
        active.dismissAndDeny();
      } else {
        active.banner.remove();
        panel.__edgeActivePermRequest = null;
      }
    } else {
      const stray = panel.querySelector ? panel.querySelector('.edge-permission-banner') : null;
      if (stray) stray.remove();
    }

    if (panel.__edgePermQueue && panel.__edgePermQueue.length > 0) {
      if (andDeny) {
        for (const item of panel.__edgePermQueue) {
          try { item.request.deny(); } catch (_) {}
        }
      }
      panel.__edgePermQueue = [];
    }
  }

  function processNextQueued(panel) {
    if (!panel || panel.__edgeActivePermRequest) return;
    if (!panel.__edgePermQueue || panel.__edgePermQueue.length === 0) return;
    const next = panel.__edgePermQueue.shift();
    if (isSavableOrigin(next.origin)) {
      const cached = getStoredPermission(next.origin, next.permission);
      if (cached === 'allow') {
        safeRespond(next.request, true);
        processNextQueued(panel);
        return;
      }
      if (cached === 'block' || cached === 'deny') {
        safeRespond(next.request, false);
        processNextQueued(panel);
        return;
      }
    }
    showPrompt(panel, next.request, next.origin, next.permission, next.displayHost);
  }

  function showPrompt(panel, request, origin, permission, displayHost) {
    ensurePermissionStyles();

    const banner = document.createElement('div');
    banner.className = 'edge-permission-banner';
    banner.setAttribute('data-origin', origin || '');
    banner.setAttribute('data-permission', permission);

    const textEl = document.createElement('div');
    textEl.className = 'edge-perm-text';
    textEl.textContent = `${displayHost} wants to access ${getResourceLabel(permission)}`;
    banner.appendChild(textEl);

    const actionsEl = document.createElement('div');
    actionsEl.className = 'edge-perm-actions';

    const blockBtn = document.createElement('button');
    blockBtn.type = 'button';
    blockBtn.className = 'edge-perm-btn edge-perm-block';
    blockBtn.setAttribute('data-action', 'block');
    blockBtn.textContent = 'Block';
    actionsEl.appendChild(blockBtn);

    const allowBtn = document.createElement('button');
    allowBtn.type = 'button';
    allowBtn.className = 'edge-perm-btn edge-perm-allow';
    allowBtn.setAttribute('data-action', 'allow');
    allowBtn.textContent = 'Allow';
    actionsEl.appendChild(allowBtn);

    banner.appendChild(actionsEl);

    let handled = false;
    const activeRecord = {
      request,
      origin,
      permission,
      banner,
      resolve(allow) {
        if (handled) return;
        handled = true;
        try {
          if (allow) request.allow();
          else request.deny();
        } catch (err) {
          warn('Permission action error:', err);
        }
        if (isSavableOrigin(origin)) {
          setStoredPermission(origin, permission, allow ? 'allow' : 'block');
        }
        banner.remove();
        panel.__edgeActivePermRequest = null;
        processNextQueued(panel);
      },
      dismissAndDeny() {
        if (handled) return;
        handled = true;
        try {
          request.deny();
        } catch (_) {}
        banner.remove();
        panel.__edgeActivePermRequest = null;
      }
    };

    panel.__edgeActivePermRequest = activeRecord;

    allowBtn.addEventListener('click', (e) => {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
      }
      allowBtn.disabled = true;
      blockBtn.disabled = true;
      activeRecord.resolve(true);
    });

    blockBtn.addEventListener('click', (e) => {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
      }
      allowBtn.disabled = true;
      blockBtn.disabled = true;
      activeRecord.resolve(false);
    });

    attachBannerToPanel(panel, banner);
  }

  function handlePermissionRequest(e, wv, panel) {
    if (!e) return;

    // 1. Never interfere with downloads - pass through to Vivaldi's native doDownload handler
    if (e.permission === 'download') return;

    // 2. Only intercept sensitive device permissions (media, geolocation, notifications)
    if (!SENSITIVE_PERMISSIONS.has(e.permission)) return;

    // 3. Prevent Chromium auto-denial
    if (typeof e.preventDefault === 'function') {
      e.preventDefault();
    }

    // 4. Guard against extension panels
    if (isExtensionPanel(panel)) return;

    // 5. Extract origin and display host
    const { origin, host } = extractOriginAndHost(e.url, wv);

    // 6. Check persistence if origin is valid
    if (isSavableOrigin(origin)) {
      const cached = getStoredPermission(origin, e.permission);
      if (cached === 'allow') {
        safeRespond(e.request, true);
        return;
      }
      if (cached === 'block' || cached === 'deny') {
        safeRespond(e.request, false);
        return;
      }
    }

    // 7. Undecided: check if panel already has an active prompt banner
    if (panel) {
      if (panel.__edgeActivePermRequest) {
        panel.__edgePermQueue = panel.__edgePermQueue || [];
        panel.__edgePermQueue.push({
          request: e.request,
          origin,
          permission: e.permission,
          displayHost: host,
          panel
        });
        return;
      }
      showPrompt(panel, e.request, origin, e.permission, host);
    }
  }

  function hookWebview(wv, panel) {
    if (!wv || wv.__edgePermHooked) return;
    wv.__edgePermHooked = true;

    // Intercept permissionrequest on webview in capture phase
    wv.addEventListener('permissionrequest', (e) => {
      const currentPanel = panel || (wv.closest && wv.closest('.panel, .webpanel, #panels > div')) || getLivePanels()[0];
      handlePermissionRequest(e, wv, currentPanel);
    }, true);

    // Watch for webview src changes to dismiss active prompt
    try {
      new MutationObserver((mutations) => {
        for (const m of mutations) {
          if (m.type === 'attributes' && m.attributeName === 'src') {
            const currentPanel = panel || (wv.closest && wv.closest('.panel, .webpanel, #panels > div')) || getLivePanels()[0];
            dismissAllPanelPrompts(currentPanel, true);
          }
        }
      }).observe(wv, { attributes: true, attributeFilter: ['src'] });
    } catch (_) {}
  }

  function hookPanelWebviews(panel) {
    if (!panel) return;
    if (panel.querySelectorAll) {
      const webviews = panel.querySelectorAll('webview');
      for (const wv of webviews) {
        hookWebview(wv, panel);
      }
    }
    const singleWv = panel.querySelector ? panel.querySelector('webview') : null;
    if (singleWv) hookWebview(singleWv, panel);
  }

  // ── Panel Visibility Observation ───────────────────────────────────────────
  function handleVisibilityChange(panel) {
    const isVisible = panel.classList.contains('visible');

    if (isVisible) {
      setupCloseButton(panel);
      handleReopen(panel);
    } else {
      log('Panel hidden; session preserved (if multitask) or tab will be destroyed (if X close).');
    }
  }

  function observePanel(panel) {
    if (panel.__edgeModObserved) return;
    panel.__edgeModObserved = true;

    new MutationObserver(() => handleVisibilityChange(panel))
      .observe(panel, { attributes: true, attributeFilter: ['class'] });

    // Watch for webview additions and removals inside panel
    try {
      new MutationObserver((mutations) => {
        for (const m of mutations) {
          if (m.type === 'childList') {
            if (m.addedNodes && m.addedNodes.length) {
              for (const node of m.addedNodes) {
                if (node.tagName === 'WEBVIEW') {
                  hookWebview(node, panel);
                } else if (node.querySelectorAll) {
                  const wvs = node.querySelectorAll('webview');
                  for (const w of wvs) hookWebview(w, panel);
                }
              }
            }
            if (m.removedNodes && m.removedNodes.length) {
              for (const node of m.removedNodes) {
                if (node.tagName === 'WEBVIEW' || (node.querySelector && node.querySelector('webview'))) {
                  dismissAllPanelPrompts(panel, true);
                }
              }
            }
          }
        }
      }).observe(panel, { childList: true, subtree: true });
    } catch (_) {}

    hookPanelWebviews(panel);

    if (panel.classList.contains('visible')) {
      setupCloseButton(panel);
      handleReopen(panel);
    }
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
    const panels = getLivePanels();
    if (!panels.length) return false;
    panels.forEach(observePanel);

    const container = document.querySelector('#panels-container') || document.querySelector('#panels') || document.body;
    new MutationObserver(() => {
      getLivePanels().forEach(observePanel);
    }).observe(container, { childList: true, subtree: false });

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
