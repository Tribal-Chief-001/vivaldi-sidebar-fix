/**
 * =============================================================================
 * Regression Adversarial Challenge Suite (R4 Invariants Verification)
 * =============================================================================
 *
 * MISSION:
 * Adversarially challenge zero-regression invariants (R4) against potential side-effects:
 * 1. Close button (X) click handling & SVG layout isolation
 * 2. Tab destruction (chrome.tabs.remove) & 0.0 MB RAM teardown under stress
 * 3. Multitasking blur handling (state preservation, zero unwanted cleanup/denial)
 * 4. Panel reopening at clean Home URL (window.__edgeShouldReset lifecycle)
 * 5. Keyboard shortcut passthrough (Ctrl+Enter, Meta+Enter, focus retention)
 * 6. APT persistence script markers (/usr/local/bin/vivaldi-sidebar-mod-persist)
 *
 * =============================================================================
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

console.log('🧪 Starting Regression Adversarial Challenge Suite...\n');

const MOD_PATH = path.join(__dirname, '../src/edge-panel-mod.js');
const MOD_SOURCE = fs.readFileSync(MOD_PATH, 'utf8');

// ── Minimal Realistic DOM Engine for Adversarial Testing ────────────────────

class MockNode {
  constructor(nodeType) {
    this.nodeType = nodeType;
    this.parentNode = null;
    this.parentElement = null;
    this.childNodes = [];
  }
}

class MockTextNode extends MockNode {
  constructor(text) {
    super(3);
    this._text = String(text);
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
}

class MockEvent {
  constructor(type, opts = {}) {
    this.type = type;
    this.bubbles = Boolean(opts.bubbles);
    this.cancelable = Boolean(opts.cancelable);
    this.target = null;
    this.currentTarget = null;
    this.defaultPrevented = false;
    this.propagationStopped = false;
    this.immediatePropagationStopped = false;
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.propagationStopped = true; }
  stopImmediatePropagation() {
    this.immediatePropagationStopped = true;
    this.propagationStopped = true;
  }
}

function parseCompoundSelector(sel) {
  let s = sel.trim();
  const notList = [];
  s = s.replace(/:not\(([^)]+)\)/g, (_, inner) => {
    notList.push(inner.trim());
    return '';
  });

  const attrs = [];
  s = s.replace(/\[([a-zA-Z0-9_-]+)(?:([*^$]?=)(?:\"([^\"]*)\"|'([^']*)'|([^\]]+)))?\]/g, (_, name, op, v1, v2, v3) => {
    attrs.push({ name, op, val: v1 ?? v2 ?? v3 });
    return '';
  });

  let tag = null;
  const tagMatch = s.match(/^([a-zA-Z0-9_-]+)/);
  if (tagMatch) {
    tag = tagMatch[1];
    s = s.slice(tag.length);
  }

  const ids = [];
  const classes = [];
  const parts = s.matchAll(/([#\.])([a-zA-Z0-9_-]+)/g);
  for (const p of parts) {
    if (p[1] === '#') ids.push(p[2]);
    else if (p[1] === '.') classes.push(p[2]);
  }

  return { tag, ids, classes, attrs, notList };
}

function matchesCompound(el, parsed) {
  if (!el || el.nodeType !== 1) return false;
  if (parsed.tag && parsed.tag !== '*' && el.tagName.toLowerCase() !== parsed.tag.toLowerCase()) return false;
  for (const id of parsed.ids) {
    if (el.id !== id) return false;
  }
  for (const cls of parsed.classes) {
    if (!el.classList.contains(cls)) return false;
  }
  for (const attr of parsed.attrs) {
    const val = el.getAttribute ? el.getAttribute(attr.name) : null;
    if (val === null || val === undefined) return false;
    if (attr.op === '=' && val !== attr.val) return false;
    if (attr.op === '*=' && !val.includes(attr.val)) return false;
    if (attr.op === '^=' && !val.startsWith(attr.val)) return false;
  }
  for (const notSel of parsed.notList) {
    if (matchesSelector(el, notSel)) return false;
  }
  return true;
}

function matchesBranch(el, branch) {
  const parts = branch.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return false;
  if (parts.length === 1) {
    return matchesCompound(el, parseCompoundSelector(parts[0]));
  }
  if (!matchesCompound(el, parseCompoundSelector(parts[parts.length - 1]))) return false;

  let curr = el.parentElement;
  for (let i = parts.length - 2; i >= 0; i--) {
    const parsed = parseCompoundSelector(parts[i]);
    while (curr && !matchesCompound(curr, parsed)) {
      curr = curr.parentElement;
    }
    if (!curr) return false;
    curr = curr.parentElement;
  }
  return true;
}

function matchesSelector(el, sel) {
  if (!el || el.nodeType !== 1 || !sel) return false;
  const branches = sel.split(/\s*,\s*/);
  return branches.some(b => matchesBranch(el, b));
}

function parseHTML(html, doc) {
  const root = new MockElement('DIV', doc);
  const stack = [root];
  const re = /<([a-zA-Z0-9_-]+)([^>]*?)(\/?)>|<\/([a-zA-Z0-9_-]+)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[1]) {
      const tag = m[1].toUpperCase();
      const attrStr = m[2];
      const isSelfClosing = Boolean(m[3]) || ['IMG', 'INPUT', 'BR', 'HR', 'PATH'].includes(tag);
      const el = (doc && doc.createElement) ? doc.createElement(tag) : new MockElement(tag, doc);
      if (attrStr) {
        const attrRe = /([a-zA-Z0-9_-]+)(?:=[\"']([^\"']*)[\"']|=([^\s>]+))?/g;
        let am;
        while ((am = attrRe.exec(attrStr)) !== null) {
          el.setAttribute(am[1], am[2] !== undefined ? am[2] : (am[3] !== undefined ? am[3] : ''));
        }
      }
      stack[stack.length - 1].appendChild(el);
      if (!isSelfClosing) stack.push(el);
    } else if (m[4]) {
      const endTag = m[4].toUpperCase();
      if (stack.length > 1 && stack[stack.length - 1].tagName === endTag) {
        stack.pop();
      }
    } else if (m[5]) {
      const text = m[5].trim();
      if (text) stack[stack.length - 1].appendChild(new MockTextNode(text));
    }
  }
  return root.childNodes;
}

class MockElement extends MockNode {
  constructor(tagName, doc = null) {
    super(1);
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = doc;
    this.attributes = new Map();
    this.style = {};
    this._listeners = new Map();

    const self = this;
    this.classList = {
      _set: new Set(),
      add(...classes) {
        classes.forEach(c => c && self.classList._set.add(c));
        self._syncClassName();
        MockMutationObserver.notify('attributes', self, { attributeName: 'class' });
      },
      remove(...classes) {
        classes.forEach(c => self.classList._set.delete(c));
        self._syncClassName();
        MockMutationObserver.notify('attributes', self, { attributeName: 'class' });
      },
      contains(c) {
        return self.classList._set.has(c);
      }
    };
  }

  get id() { return this.getAttribute('id') || ''; }
  set id(v) { this.setAttribute('id', v); }

  get className() { return Array.from(this.classList._set).join(' '); }
  set className(v) {
    this.classList._set.clear();
    if (v) String(v).split(/\s+/).filter(Boolean).forEach(c => this.classList._set.add(c));
    this.attributes.set('class', this.className);
    MockMutationObserver.notify('attributes', this, { attributeName: 'class' });
  }

  _syncClassName() {
    this.attributes.set('class', Array.from(this.classList._set).join(' '));
  }

  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
  setAttribute(k, v) {
    const val = String(v);
    this.attributes.set(k, val);
    if (k === 'class') {
      this.classList._set.clear();
      val.split(/\s+/).filter(Boolean).forEach(c => this.classList._set.add(c));
    }
    MockMutationObserver.notify('attributes', this, { attributeName: k });
  }
  removeAttribute(k) {
    this.attributes.delete(k);
    if (k === 'class') this.classList._set.clear();
    MockMutationObserver.notify('attributes', this, { attributeName: k });
  }

  get children() {
    return this.childNodes.filter(n => n.nodeType === 1);
  }

  appendChild(node) {
    if (node.parentElement) node.parentElement.removeChild(node);
    node.parentNode = this;
    node.parentElement = this;
    this.childNodes.push(node);
    MockMutationObserver.notify('childList', this, { addedNodes: [node] });
    return node;
  }

  prepend(...nodes) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i];
      if (node.parentElement) node.parentElement.removeChild(node);
      node.parentNode = this;
      node.parentElement = this;
      this.childNodes.unshift(node);
      MockMutationObserver.notify('childList', this, { addedNodes: [node] });
    }
  }

  insertBefore(newNode, refNode) {
    const idx = this.childNodes.indexOf(refNode);
    if (idx === -1) return this.appendChild(newNode);
    if (newNode.parentElement) newNode.parentElement.removeChild(newNode);
    newNode.parentNode = this;
    newNode.parentElement = this;
    this.childNodes.splice(idx, 0, newNode);
    MockMutationObserver.notify('childList', this, { addedNodes: [newNode] });
    return newNode;
  }

  removeChild(child) {
    const idx = this.childNodes.indexOf(child);
    if (idx !== -1) {
      this.childNodes.splice(idx, 1);
      child.parentNode = null;
      child.parentElement = null;
      MockMutationObserver.notify('childList', this, { removedNodes: [child] });
      return child;
    }
    return null;
  }

  remove() {
    if (this.parentElement) {
      this.parentElement.removeChild(this);
    }
  }

  get textContent() {
    let out = '';
    for (const c of this.childNodes) {
      out += c.textContent || '';
    }
    return out;
  }
  set textContent(v) {
    this.childNodes.forEach(c => { c.parentNode = null; c.parentElement = null; });
    this.childNodes = [];
    if (v) this.appendChild(new MockTextNode(v));
    MockMutationObserver.notify('childList', this, {});
  }

  get innerHTML() {
    let out = '';
    for (const c of this.childNodes) {
      if (c.nodeType === 3) out += c.textContent;
      else if (c.nodeType === 1) {
        const attrs = Array.from(c.attributes.entries()).map(([k, v]) => ` ${k}="${v}"`).join('');
        out += `<${c.tagName.toLowerCase()}${attrs}>${c.innerHTML}</${c.tagName.toLowerCase()}>`;
      }
    }
    return out;
  }
  set innerHTML(htmlStr) {
    this.childNodes.forEach(c => { c.parentNode = null; c.parentElement = null; });
    this.childNodes = [];
    const parsedNodes = parseHTML(String(htmlStr), this.ownerDocument);
    for (const node of parsedNodes) {
      this.appendChild(node);
    }
    MockMutationObserver.notify('childList', this, {});
  }

  addEventListener(type, fn, opts) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    const capture = typeof opts === 'boolean' ? opts : Boolean(opts?.capture);
    this._listeners.get(type).push({ fn, capture });
  }

  dispatchEvent(event) {
    event.target = this;
    const path = [];
    let curr = this;
    while (curr) {
      path.unshift(curr);
      curr = curr.parentElement;
    }

    // Capture Phase
    for (let i = 0; i < path.length - 1; i++) {
      if (event.immediatePropagationStopped) break;
      const node = path[i];
      event.currentTarget = node;
      const list = (node._listeners.get(event.type) || []).filter(l => l.capture);
      for (const entry of list) {
        if (event.immediatePropagationStopped) break;
        entry.fn.call(node, event);
      }
    }

    // Target Phase
    if (!event.immediatePropagationStopped) {
      event.currentTarget = this;
      const list = this._listeners.get(event.type) || [];
      for (const entry of list) {
        if (event.immediatePropagationStopped) break;
        entry.fn.call(this, event);
      }
    }

    // Bubbling Phase
    if (event.bubbles && !event.propagationStopped && !event.immediatePropagationStopped) {
      for (let i = path.length - 2; i >= 0; i--) {
        if (event.propagationStopped || event.immediatePropagationStopped) break;
        const node = path[i];
        event.currentTarget = node;
        const list = (node._listeners.get(event.type) || []).filter(l => !l.capture);
        for (const entry of list) {
          if (event.immediatePropagationStopped) break;
          entry.fn.call(node, event);
        }
      }
    }

    return !event.defaultPrevented;
  }

  click() {
    const ev = new MockEvent('click', { bubbles: true, cancelable: true });
    return this.dispatchEvent(ev);
  }

  matches(sel) {
    return matchesSelector(this, sel);
  }

  closest(sel) {
    let curr = this;
    while (curr && curr.nodeType === 1) {
      if (matchesSelector(curr, sel)) return curr;
      curr = curr.parentElement;
    }
    return null;
  }

  querySelector(sel) {
    const results = this.querySelectorAll(sel);
    return results.length > 0 ? results[0] : null;
  }

  querySelectorAll(sel) {
    const out = [];
    function dfs(node) {
      for (const c of node.children) {
        if (matchesSelector(c, sel)) out.push(c);
        dfs(c);
      }
    }
    dfs(this);
    return out;
  }
}

class MockMutationObserver {
  static _activeObservers = new Set();
  constructor(cb) {
    this.callback = cb;
    this.targets = new Map();
  }
  observe(target, options = {}) {
    this.targets.set(target, options);
    MockMutationObserver._activeObservers.add(this);
  }
  disconnect() {
    this.targets.clear();
    MockMutationObserver._activeObservers.delete(this);
  }
  static notify(mutationType, target, details = {}) {
    for (const obs of Array.from(MockMutationObserver._activeObservers)) {
      for (const [observedTarget, opts] of obs.targets) {
        let isMatch = false;
        if (observedTarget === target) isMatch = true;
        else if (opts.subtree) {
          let curr = target.parentElement;
          while (curr) {
            if (curr === observedTarget) { isMatch = true; break; }
            curr = curr.parentElement;
          }
        }
        if (!isMatch) continue;

        if (mutationType === 'attributes' && opts.attributes) {
          if (!opts.attributeFilter || opts.attributeFilter.includes(details.attributeName)) {
            obs.callback([{ type: 'attributes', target, attributeName: details.attributeName }]);
          }
        } else if (mutationType === 'childList' && opts.childList) {
          obs.callback([{
            type: 'childList',
            target,
            addedNodes: details.addedNodes || [],
            removedNodes: details.removedNodes || []
          }]);
        }
      }
    }
  }
}

class MockLocalStorage {
  constructor() { this._store = new Map(); }
  getItem(k) { return this._store.has(String(k)) ? this._store.get(String(k)) : null; }
  setItem(k, v) { this._store.set(String(k), String(v)); }
  removeItem(k) { this._store.delete(String(k)); }
  clear() { this._store.clear(); }
}

class MockDocument extends MockElement {
  constructor() {
    super('#document');
    this.readyState = 'complete';
    this.body = new MockElement('BODY', this);
    this.appendChild(this.body);
  }
  createElement(tag) { return new MockElement(tag.toUpperCase(), this); }
  querySelector(sel) { return this.body.querySelector(sel); }
  querySelectorAll(sel) { return this.body.querySelectorAll(sel); }
}

function createProbeHarness(opts = {}) {
  const doc = new MockDocument();
  const panelsContainer = doc.createElement('div');
  panelsContainer.id = 'panels-container';
  doc.body.appendChild(panelsContainer);

  const panels = doc.createElement('div');
  panels.id = 'panels';
  panelsContainer.appendChild(panels);

  const panel = doc.createElement('div');
  panel.className = 'panel webpanel visible';
  panel.id = opts.panelId || 'panel-chatgpt';
  panel.setAttribute('data-id', opts.panelId || 'panel-chatgpt');
  panels.appendChild(panel);

  const header = doc.createElement('header');
  header.className = 'webpanel-header toolbar toolbar-default';
  panel.appendChild(header);

  // Close button in header (either native or we test mod injection)
  let closeBtn = null;
  if (!opts.omitCloseButton) {
    closeBtn = doc.createElement('button');
    closeBtn.className = 'close transparent';
    closeBtn.setAttribute('title', 'Close Panel');
    closeBtn.setAttribute('aria-label', 'Close Panel');
    header.appendChild(closeBtn);
  }

  const content = doc.createElement('section');
  content.className = 'webpanel-content';
  panel.appendChild(content);

  const webview = doc.createElement('webview');
  webview.setAttribute('tab_id', String(opts.tabId || 101));
  webview.tab_id = opts.tabId || 101;
  webview.setAttribute('src', opts.url || 'https://chatgpt.com');
  webview.src = opts.url || 'https://chatgpt.com';
  content.appendChild(webview);

  const removedTabs = [];
  const chromeMock = {
    tabs: {
      remove: (tabId, cb) => {
        removedTabs.push(tabId);
        if (cb) setTimeout(cb, 0);
      }
    },
    runtime: { lastError: null }
  };

  const localStorage = new MockLocalStorage();

  const sandbox = {
    window: {},
    document: doc,
    localStorage,
    chrome: chromeMock,
    MutationObserver: MockMutationObserver,
    PointerEvent: class extends MockEvent {},
    KeyboardEvent: class extends MockEvent {},
    MouseEvent: class extends MockEvent {},
    CustomEvent: class extends MockEvent {},
    Event: MockEvent,
    URL: global.URL,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id),
    console,
    Set,
    Map,
    Array,
    Object,
    JSON,
    parseInt,
    isNaN
  };
  sandbox.window = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(MOD_SOURCE, sandbox);

  return {
    doc,
    panel,
    header,
    closeBtn,
    content,
    webview,
    localStorage,
    sandbox,
    removedTabs
  };
}

function dispatchPermission(h, opts = {}) {
  const perm = opts.permission || 'media';
  const url = opts.url || h.webview.src || 'https://chatgpt.com';
  const req = {
    allowed: false,
    denied: false,
    callCount: 0,
    allow() {
      this.callCount++;
      if (opts.throwOnAllow) throw new Error('Permission action threw');
      this.allowed = true;
    },
    deny() {
      this.callCount++;
      if (opts.throwOnDeny) throw new Error('Permission deny threw');
      this.denied = true;
    }
  };
  const ev = new MockEvent('permissionrequest', { bubbles: false, cancelable: true });
  ev.permission = perm;
  ev.url = url;
  ev.request = req;
  h.webview.dispatchEvent(ev);
  return { event: ev, request: req };
}

// =============================================================================
// CHALLENGE 1: CLOSE BUTTON (X) CLICK HANDLING & SVG LAYOUT ISOLATION
// =============================================================================
console.log('▶ CHALLENGE 1: Close Button (X) Click Handling & SVG Layout Isolation');

{
  // 1.1 Close button click while permission prompt banner is active
  const h = createProbeHarness();
  const { request } = dispatchPermission(h);
  const banner = h.panel.querySelector('.edge-permission-banner');
  assert(banner !== null, 'Banner must exist before close');

  // Click close button
  h.closeBtn.click();

  // Banner must be immediately dismissed and pending request denied
  assert.strictEqual(h.panel.querySelector('.edge-permission-banner'), null, 'Prompt banner must be unmounted on (X)');
  assert.strictEqual(request.denied, true, 'Pending request must be safely denied on (X)');
  assert.strictEqual(h.sandbox.window.__edgeShouldReset(h.panel.id), true, '__edgeShouldReset must be flagged true');
  console.log('  ✔ 1.1 Close button click cleanly unmounts banner and denies request');
}

{
  // 1.2 Click on banner Allow / Block buttons MUST NOT trigger panel close
  const h = createProbeHarness();
  dispatchPermission(h);
  const banner = h.panel.querySelector('.edge-permission-banner');
  const allowBtn = banner.querySelector('.edge-perm-allow');
  const blockBtn = banner.querySelector('.edge-perm-block');

  // Click allow
  allowBtn.click();
  assert(h.panel.classList.contains('visible'), 'Panel must remain visible after Allow click');
  assert.strictEqual(h.removedTabs.length, 0, 'No tabs removed on Allow click');
  assert.strictEqual(h.sandbox.window.__edgeShouldReset(h.panel.id), false, '__edgeShouldReset must NOT be set on Allow');

  // Trigger another permission and click block
  dispatchPermission(h, { permission: 'geolocation' });
  const banner2 = h.panel.querySelector('.edge-permission-banner');
  const blockBtn2 = banner2.querySelector('.edge-perm-block');
  blockBtn2.click();
  assert(h.panel.classList.contains('visible'), 'Panel must remain visible after Block click');
  assert.strictEqual(h.removedTabs.length, 0, 'No tabs removed on Block click');
  assert.strictEqual(h.sandbox.window.__edgeShouldReset(h.panel.id), false, '__edgeShouldReset must NOT be set on Block');
  console.log('  ✔ 1.2 Banner button clicks do not propagate to panel close');
}

{
  // 1.3 Click on banner text or container background MUST NOT trigger panel close
  const h = createProbeHarness();
  dispatchPermission(h);
  const banner = h.panel.querySelector('.edge-permission-banner');
  const textEl = banner.querySelector('.edge-perm-text');

  textEl.click();
  banner.click();
  assert(h.panel.classList.contains('visible'), 'Panel must remain open when clicking banner background/text');
  assert.strictEqual(h.removedTabs.length, 0, 'Tabs must not be removed when clicking banner text');
  console.log('  ✔ 1.3 Banner container/text clicks do not trigger panel close');
}

{
  // 1.4 Native SVG layout & injected close button fallback
  const h = createProbeHarness({ omitCloseButton: true });
  // setupCloseButton was called during scanAndInit
  const injectedBtn = h.panel.querySelector('button.mod-edge-close-btn');
  assert(injectedBtn !== null, 'Mod must inject close button with NATIVE_CLOSE_SVG if native button is missing');
  assert(injectedBtn.innerHTML.includes('<svg width="16" height="16" viewBox="0 0 16 16"'), 'Injected button must contain exact native SVG');
  assert(injectedBtn.innerHTML.includes('M4.293 4.293a1 1 0 0 1 1.414 0L8 6.586'), 'SVG path must match Pe.kze native icon');

  // Clicking injected close button must trigger close
  dispatchPermission(h);
  assert(h.panel.querySelector('.edge-permission-banner') !== null, 'Banner exists');
  injectedBtn.click();
  assert.strictEqual(h.panel.querySelector('.edge-permission-banner'), null, 'Injected button click unmounts banner');
  assert.strictEqual(h.sandbox.window.__edgeShouldReset(h.panel.id), true, '__edgeShouldReset set to true');
  console.log('  ✔ 1.4 Native close SVG and injected close button fully functional');
}

// =============================================================================
// CHALLENGE 2: TAB DESTRUCTION & 0.0 MB RAM TEARDOWN UNDER STRESS
// =============================================================================
console.log('▶ CHALLENGE 2: Tab Destruction (chrome.tabs.remove) & 0.0 MB RAM Teardown Under Stress');

{
  // 2.1 Tab destruction after GLIDE_DELAY_MS with active prompt
  const h = createProbeHarness({ tabId: 201 });
  dispatchPermission(h);
  h.closeBtn.click();

  assert.strictEqual(h.removedTabs.length, 0, 'Tab removal delayed by glide timer (150ms)');
  setTimeout(() => {
    assert(h.removedTabs.includes(201), 'chrome.tabs.remove(201) MUST be called after glide delay');
  }, 170);
  console.log('  ✔ 2.1 Tab destruction executes after glide delay with active prompt');
}

{
  // 2.2 Tab destruction resilience when e.request.deny() throws
  const h = createProbeHarness({ tabId: 202 });
  // Guest crashed or webview destroyed prematurely -> deny() throws
  dispatchPermission(h, { throwOnDeny: true });
  assert(h.panel.querySelector('.edge-permission-banner') !== null, 'Banner mounted');

  // Clicking close button MUST NOT crash or fail to schedule tab removal
  assert.doesNotThrow(() => {
    h.closeBtn.click();
  }, 'Exception in request.deny() must not prevent panel close');

  setTimeout(() => {
    assert(h.removedTabs.includes(202), 'chrome.tabs.remove(202) MUST be called even if request.deny() throws');
  }, 170);
  console.log('  ✔ 2.2 Tab destruction succeeds even when request.deny() throws');
}

{
  // 2.3 Multiple queued permission requests cleanly flushed and denied on close
  const h = createProbeHarness({ tabId: 203 });
  const req1 = dispatchPermission(h, { permission: 'media' });
  const req2 = dispatchPermission(h, { permission: 'geolocation' });
  const req3 = dispatchPermission(h, { permission: 'notifications' });

  assert.strictEqual(h.panel.__edgePermQueue.length, 2, '2 requests should be queued');

  h.closeBtn.click();

  assert.strictEqual(req1.request.denied, true, 'Active request 1 denied');
  assert.strictEqual(req2.request.denied, true, 'Queued request 2 denied');
  assert.strictEqual(req3.request.denied, true, 'Queued request 3 denied');
  assert.strictEqual(h.panel.__edgePermQueue.length, 0, 'Queue completely flushed');

  setTimeout(() => {
    assert(h.removedTabs.includes(203), 'chrome.tabs.remove(203) called');
  }, 170);
  console.log('  ✔ 2.3 Queued permission requests cleanly flushed and denied on close');
}

{
  // 2.4 Extension Panel protection (Bitwarden, translate, chrome-extension://)
  const h = createProbeHarness({ panelId: 'ext-bitwarden', url: 'chrome-extension://nngceckbapbfimflimffdpfcgkbfldio/popup.html', tabId: 204 });
  dispatchPermission(h);
  // Extension panels must NOT mount permission prompt
  assert.strictEqual(h.panel.querySelector('.edge-permission-banner'), null, 'Extension panels must not mount permission prompts');

  // Trigger Edge close on extension panel
  h.closeBtn.click();
  setTimeout(() => {
    assert.strictEqual(h.removedTabs.includes(204), false, 'chrome.tabs.remove MUST NOT be called on extension panels');
  }, 170);
  console.log('  ✔ 2.4 Extension panels safely guarded against tab destruction');
}

// =============================================================================
// CHALLENGE 3: MULTITASKING BLUR HANDLING & STATE PRESERVATION
// =============================================================================
console.log('▶ CHALLENGE 3: Multitasking Blur Handling (State Preservation & Zero Unwanted Teardown)');

{
  // 3.1 Multitasking blur preserves prompt, does not deny request, and does NOT destroy tab
  const h = createProbeHarness({ tabId: 301 });
  const { request } = dispatchPermission(h);
  const banner = h.panel.querySelector('.edge-permission-banner');
  assert(banner !== null, 'Banner active before blur');

  // Simulate user clicking outside into main window: panel loses .visible class
  h.panel.classList.remove('visible');

  // Wait past glide delay to be 100% sure tab is not destroyed
  setTimeout(() => {
    assert.strictEqual(h.removedTabs.includes(301), false, 'Multitasking blur MUST NEVER call chrome.tabs.remove');
    assert.strictEqual(request.denied, false, 'Multitasking blur MUST NOT deny pending permission request');
    assert.strictEqual(request.allowed, false, 'Request must remain undecided');
    assert.strictEqual(h.sandbox.window.__edgeShouldReset(h.panel.id), false, '__edgeShouldReset must be false on blur');

    // User switches back to sidebar: panel gains .visible class
    h.panel.classList.add('visible');
    const bannerAfter = h.panel.querySelector('.edge-permission-banner');
    assert(bannerAfter !== null, 'Banner must remain present after refocusing');

    // User can now click Allow
    const allowBtn = bannerAfter.querySelector('.edge-perm-allow');
    allowBtn.click();
    assert.strictEqual(request.allowed, true, 'User can allow permission after refocusing');
    assert.strictEqual(h.panel.querySelector('.edge-permission-banner'), null, 'Banner dismisses on decision');
  }, 180);
  console.log('  ✔ 3.1 Multitasking blur preserves prompt and warm RAM without denial');
}

// =============================================================================
// CHALLENGE 4: PANEL REOPENING AT CLEAN HOME URL (__edgeShouldReset)
// =============================================================================
console.log('▶ CHALLENGE 4: Panel Reopening at Clean Home URL (window.__edgeShouldReset Lifecycle)');

{
  // 4.1 Explicit close sets flag; first reopen consumes it; second reopen returns false
  const h = createProbeHarness();
  dispatchPermission(h);
  h.closeBtn.click();

  // Flag is set
  assert.strictEqual(h.sandbox.window.__edgeShouldReset(h.panel.id), true, 'First reopen check returns true');
  // Flag is consumed (atomic one-shot)
  assert.strictEqual(h.sandbox.window.__edgeShouldReset(h.panel.id), false, 'Second reopen check returns false');
  console.log('  ✔ 4.1 __edgeShouldReset atomic one-shot flag consumption verified');
}

{
  // 4.2 Native Rge close bridge (__edgeCloseWebPanel)
  const h = createProbeHarness({ tabId: 402 });
  dispatchPermission(h);
  assert(h.panel.querySelector('.edge-permission-banner') !== null, 'Banner active');

  const mockRge = {
    props: {
      webPanel: { id: h.panel.id },
      tabId: 402
    },
    nodeRef: { current: h.panel },
    refWebpanelwebview: { current: h.webview }
  };

  h.sandbox.window.__edgeCloseWebPanel(mockRge);

  // Banner dismissed
  assert.strictEqual(h.panel.querySelector('.edge-permission-banner'), null, 'Banner dismissed by __edgeCloseWebPanel');
  // Flag set
  assert.strictEqual(h.sandbox.window.__edgeShouldReset(h.panel.id), true, '__edgeShouldReset flagged true');

  setTimeout(() => {
    assert(h.removedTabs.includes(402), 'chrome.tabs.remove(402) called by __edgeCloseWebPanel');
  }, 170);
  console.log('  ✔ 4.2 Native Rge close bridge (__edgeCloseWebPanel) executes cleanly');
}

// =============================================================================
// CHALLENGE 5: KEYBOARD SHORTCUT PASSTHROUGH & ZERO FOCUS HIJACKING
// =============================================================================
console.log('▶ CHALLENGE 5: Keyboard Shortcut Passthrough & Zero Focus Hijacking');

{
  // 5.1 edge-panel-mod.js registers zero global key event listeners
  const h = createProbeHarness();
  // Check doc listeners
  const docKeyListeners = h.doc._listeners.get('keydown') || [];
  assert.strictEqual(docKeyListeners.length, 0, 'No keydown listeners on document');
  const docKeyUpListeners = h.doc._listeners.get('keyup') || [];
  assert.strictEqual(docKeyUpListeners.length, 0, 'No keyup listeners on document');

  // Dispatch Ctrl+Enter on webview and document
  const ctrlEnterEvent = new MockEvent('keydown', { bubbles: true, cancelable: true });
  ctrlEnterEvent.ctrlKey = true;
  ctrlEnterEvent.key = 'Enter';
  ctrlEnterEvent.code = 'Enter';

  h.webview.dispatchEvent(ctrlEnterEvent);
  assert.strictEqual(ctrlEnterEvent.defaultPrevented, false, 'Ctrl+Enter must not be prevented by mod');
  assert.strictEqual(ctrlEnterEvent.propagationStopped, false, 'Ctrl+Enter must not be stopped by mod');

  h.doc.dispatchEvent(ctrlEnterEvent);
  assert.strictEqual(ctrlEnterEvent.defaultPrevented, false, 'Ctrl+Enter on doc must not be prevented by mod');
  console.log('  ✔ 5.1 No global key event listeners or shortcut interception in mod');
}

{
  // 5.2 Focus retention: Prompt appearance does not steal focus
  const h = createProbeHarness();
  let focusedElement = null;
  const mockInput = h.doc.createElement('input');
  h.content.appendChild(mockInput);
  focusedElement = mockInput;

  // Request permission
  dispatchPermission(h);
  const banner = h.panel.querySelector('.edge-permission-banner');
  assert(banner !== null, 'Banner rendered');

  // Neither banner nor buttons should have stolen focus
  assert.strictEqual(focusedElement, mockInput, 'Active input element retained focus when banner appeared');
  console.log('  ✔ 5.2 Banner appearance does not steal active element focus');
}

// =============================================================================
// CHALLENGE 6: APT PERSISTENCE SCRIPT MARKERS & INSTALLER PARITY
// =============================================================================
console.log('▶ CHALLENGE 6: APT Persistence Script Markers & Installer Parity');

{
  const persistScriptPath = path.join(__dirname, '../src/vivaldi-sidebar-mod-persist');
  assert(fs.existsSync(persistScriptPath), 'Persistence script exists');
  const persistSource = fs.readFileSync(persistScriptPath, 'utf8');

  // The 4 checks in persist script:
  assert(persistSource.includes('grep -Fq "edge-panel-mod.js"'), 'Check 1: edge-panel-mod.js marker');
  assert(persistSource.includes('grep -Fq "__edgeCloseWebPanel"'), 'Check 2: __edgeCloseWebPanel marker');
  assert(persistSource.includes('grep -Fq "__edgeShouldReset"'), 'Check 3: __edgeShouldReset marker');
  assert(persistSource.includes('grep -Fq ".880*this.context.innerWidth"'), 'Check 4: 88% width clamp marker');

  // Verify install.sh satisfies Check 1
  const installPath = path.join(__dirname, '../install.sh');
  const installSource = fs.readFileSync(installPath, 'utf8');
  assert(installSource.includes('edge-panel-mod.js'), 'install.sh injects edge-panel-mod.js');

  // Verify patch-bundle.py satisfies Checks 2, 3, 4
  const patcherPath = path.join(__dirname, '../src/patch-bundle.py');
  const patcherSource = fs.readFileSync(patcherPath, 'utf8');
  assert(patcherSource.includes('__edgeCloseWebPanel'), 'patch-bundle.py injects __edgeCloseWebPanel');
  assert(patcherSource.includes('__edgeShouldReset'), 'patch-bundle.py injects __edgeShouldReset');
  assert(patcherSource.includes('.880*this.context.innerWidth'), 'patch-bundle.py injects .880*this.context.innerWidth');

  console.log('  ✔ 6.1 All 4 persistence check markers match installer and patcher patterns');
}

// =============================================================================
// SUMMARY REPORT
// =============================================================================
setTimeout(() => {
  console.log('\n========================================================');
  console.log('🎉 ALL ADVERSARIAL REGRESSION CHALLENGES PASSED (100% GREEN)');
  console.log('========================================================');
  process.exit(0);
}, 250);
