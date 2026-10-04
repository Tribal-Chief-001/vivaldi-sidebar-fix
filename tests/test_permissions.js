/**
 * =============================================================================
 * Vivaldi Web Panel Permission System — Comprehensive 4-Tier E2E Test Suite
 * =============================================================================
 *
 * Architecture:
 * - Pure Node.js built-ins only (assert, events, fs, path, vm). Zero external dependencies.
 * - Realistic DOM, <webview>, and Event simulation harness for evaluating
 *   `src/edge-panel-mod.js` in headless Vivaldi panel environments.
 * - 4-Tier Opaque-Box Testing Methodology:
 *     Tier 1: Feature Coverage (>=5 test cases per feature)
 *     Tier 2: Boundary & Corner Cases (>=5 test cases per feature)
 *     Tier 3: Cross-Feature Combinations (Pairwise lifecycle interactions)
 *     Tier 4: Real-World Application Scenarios (Meet, Maps, Slack, Revocation, Multi-Panel)
 *
 * Target: `src/edge-panel-mod.js`
 * =============================================================================
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ── Path Configuration ───────────────────────────────────────────────────────
const MOD_PATH = path.join(__dirname, '../src/edge-panel-mod.js');
assert(fs.existsSync(MOD_PATH), `Fatal: Source file not found at ${MOD_PATH}`);
const MOD_SOURCE = fs.readFileSync(MOD_PATH, 'utf8');

// =============================================================================
// SECTION 1: REALISTIC DOM & <WEBVIEW> SIMULATION HARNESS
// =============================================================================

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
  get nodeValue() { return this._text; }
  set nodeValue(v) { this._text = String(v); }
}

// ── CSS Selector Parsing & Matching ──────────────────────────────────────────
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

// ── HTML Parser ──────────────────────────────────────────────────────────────
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

// ── DOM Event Target & Hierarchy ─────────────────────────────────────────────
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
      },
      toggle(c) {
        if (this.contains(c)) { this.remove(c); return false; }
        else { this.add(c); return true; }
      }
    };

    this.dataset = new Proxy({}, {
      get: (_, prop) => self.getAttribute(`data-${String(prop).toLowerCase()}`),
      set: (_, prop, val) => {
        self.setAttribute(`data-${String(prop).toLowerCase()}`, String(val));
        return true;
      }
    });
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
  hasAttribute(k) { return this.attributes.has(k); }

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
      if (c.nodeType === 3) {
        out += c.textContent;
      } else if (c.nodeType === 1) {
        const attrs = Array.from(c.attributes.entries())
          .map(([k, v]) => ` ${k}="${v}"`)
          .join('');
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

  removeEventListener(type, fn, opts) {
    if (!this._listeners.has(type)) return;
    const capture = typeof opts === 'boolean' ? opts : Boolean(opts?.capture);
    const list = this._listeners.get(type);
    const idx = list.findIndex(l => l.fn === fn && l.capture === capture);
    if (idx !== -1) list.splice(idx, 1);
  }

  dispatchEvent(event) {
    event.target = this;
    const path = [];
    let curr = this;
    while (curr) {
      path.unshift(curr);
      curr = curr.parentElement;
    }

    // 1. Capture Phase
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

    // 2. Target Phase
    if (!event.immediatePropagationStopped) {
      event.currentTarget = this;
      const list = this._listeners.get(event.type) || [];
      for (const entry of list) {
        if (event.immediatePropagationStopped) break;
        entry.fn.call(this, event);
      }
    }

    // 3. Bubbling Phase
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

// ── Chromium Permission Request Mock ─────────────────────────────────────────
class MockPermissionRequest {
  constructor(url) {
    this.url = url;
    this.actionTaken = false;
    this.allowed = false;
    this.denied = false;
    this.callCount = 0;
  }

  allow() {
    this.callCount++;
    if (this.actionTaken) {
      throw new Error('<webview> Action already taken: permission request has already been handled');
    }
    this.actionTaken = true;
    this.allowed = true;
  }

  deny() {
    this.callCount++;
    if (this.actionTaken) {
      throw new Error('<webview> Action already taken: permission request has already been handled');
    }
    this.actionTaken = true;
    this.denied = true;
  }
}

class MockPermissionRequestEvent extends MockEvent {
  constructor(permission, url, request, opts = {}) {
    super('permissionrequest', { bubbles: false, cancelable: true });
    this.permission = permission;
    this.url = url;
    this.request = request;
    this.userGesture = opts.userGesture ?? true;
  }
}

// ── Dedicated <webview> Element Mock ─────────────────────────────────────────
class MockWebview extends MockElement {
  constructor(doc = null) {
    super('WEBVIEW', doc);
  }

  get src() { return this.getAttribute('src') || ''; }
  set src(v) { this.setAttribute('src', v); }

  get tab_id() { return this.getAttribute('tab_id') || ''; }
  set tab_id(v) { this.setAttribute('tab_id', v); }

  dispatchPermissionRequest(options = {}) {
    const permission = options.permission || 'media';
    const url = options.url || this.src || 'https://gemini.google.com/app';
    const req = new MockPermissionRequest(url);
    const event = new MockPermissionRequestEvent(permission, url, req, options);
    this.dispatchEvent(event);
    return { event, request: req };
  }
}

// ── MutationObserver Mock ───────────────────────────────────────────────────
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
        if (observedTarget === target) {
          isMatch = true;
        } else if (opts.subtree) {
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

// ── LocalStorage Mock with Fault Injection ──────────────────────────────────
class MockLocalStorage {
  constructor() {
    this._store = new Map();
    this.throwOnSet = null;
    this.throwOnGet = null;
  }

  getItem(key) {
    if (this.throwOnGet) throw this.throwOnGet;
    return this._store.has(String(key)) ? this._store.get(String(key)) : null;
  }

  setItem(key, value) {
    if (this.throwOnSet) throw this.throwOnSet;
    this._store.set(String(key), String(value));
  }

  removeItem(key) {
    this._store.delete(String(key));
  }

  clear() {
    this._store.clear();
  }

  get length() {
    return this._store.size;
  }

  key(index) {
    return Array.from(this._store.keys())[index] || null;
  }
}

// ── Document Mock ────────────────────────────────────────────────────────────
class MockDocument extends MockElement {
  constructor() {
    super('#document');
    this.readyState = 'complete';
    this.body = new MockElement('BODY', this);
    this.appendChild(this.body);
  }

  createElement(tag) {
    const t = tag.toUpperCase();
    if (t === 'WEBVIEW') return new MockWebview(this);
    return new MockElement(t, this);
  }

  querySelector(sel) {
    return this.body.querySelector(sel);
  }

  querySelectorAll(sel) {
    return this.body.querySelectorAll(sel);
  }
}

// ── Vivaldi Test Harness Factory ─────────────────────────────────────────────
function createVivaldiHarness(options = {}) {
  const doc = new MockDocument();

  // Root container hierarchy
  const panelsContainer = doc.createElement('div');
  panelsContainer.id = 'panels-container';
  doc.body.appendChild(panelsContainer);

  const panelsSwitcher = doc.createElement('div');
  panelsSwitcher.id = 'panels';
  panelsSwitcher.classList.add('switcher');
  panelsContainer.appendChild(panelsSwitcher);

  // Panel 1 (Default: Gemini)
  const panel = doc.createElement('div');
  panel.className = 'panel webpanel visible';
  panel.id = options.panelId || 'panel-gemini';
  panel.setAttribute('data-id', options.panelId || 'panel-gemini');
  panelsSwitcher.appendChild(panel);

  const header = doc.createElement('header');
  header.className = 'webpanel-header toolbar toolbar-default';
  panel.appendChild(header);

  const toolbarGroup = doc.createElement('div');
  toolbarGroup.className = 'toolbar-group';
  header.appendChild(toolbarGroup);

  const closeBtn = doc.createElement('button');
  closeBtn.className = 'close transparent';
  closeBtn.setAttribute('title', 'Close Panel');
  closeBtn.setAttribute('aria-label', 'Close Panel');
  header.appendChild(closeBtn);

  const contentSection = doc.createElement('section');
  contentSection.className = 'webpanel-content';
  contentSection.style.position = 'relative';
  panel.appendChild(contentSection);

  const webview = doc.createElement('webview');
  webview.tab_id = options.tabId || 101;
  webview.src = options.url || 'https://gemini.google.com/app';
  webview.setAttribute('name', 'vivaldi-webpanel');
  contentSection.appendChild(webview);

  // Optional Second Panel (for Multi-Panel testing)
  let panel2 = null;
  let webview2 = null;
  if (options.createSecondPanel) {
    panel2 = doc.createElement('div');
    panel2.className = 'panel webpanel';
    panel2.id = 'panel-maps';
    panel2.setAttribute('data-id', 'panel-maps');
    panelsSwitcher.appendChild(panel2);

    const header2 = doc.createElement('header');
    header2.className = 'webpanel-header toolbar toolbar-default';
    panel2.appendChild(header2);

    const closeBtn2 = doc.createElement('button');
    closeBtn2.className = 'close transparent';
    header2.appendChild(closeBtn2);

    const content2 = doc.createElement('section');
    content2.className = 'webpanel-content';
    panel2.appendChild(content2);

    webview2 = doc.createElement('webview');
    webview2.tab_id = 102;
    webview2.src = 'https://maps.google.com';
    content2.appendChild(webview2);
  }

  const localStorage = new MockLocalStorage();
  if (options.initialStorage) {
    for (const [k, v] of Object.entries(options.initialStorage)) {
      localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
  }

  const removedTabs = [];
  const contentSettingsCalls = {
    microphone: [],
    camera: [],
    location: [],
    notifications: [],
    clipboard: []
  };

  const createSettingHandler = (name) => ({
    set: (details) => {
      contentSettingsCalls[name].push({ action: 'set', ...details });
    },
    clear: (details) => {
      contentSettingsCalls[name].push({ action: 'clear', ...details });
    },
    get: (details, cb) => {
      const match = [...contentSettingsCalls[name]].reverse().find(c => c.action === 'set');
      if (cb) cb({ setting: match ? match.setting : 'ask' });
    }
  });

  const sitePermissionsCalls = [];
  const vivaldiMock = {
    sitePermissions: {
      setSitePermission: (origin, secondaryOrigin, permission, setting) => {
        sitePermissionsCalls.push({ action: 'set', origin, secondaryOrigin, permission, setting });
      },
      resetSitePermissions: (origin) => {
        sitePermissionsCalls.push({ action: 'reset', origin });
      },
      respondToPermissionRequest: (requestId, response, devices) => {
        sitePermissionsCalls.push({ action: 'respond', requestId, response, devices });
      },
      onPermissionRequest: {
        _listeners: [],
        addListener: function(fn) { this._listeners.push(fn); },
        _trigger: function(req) { this._listeners.forEach(fn => fn(req)); }
      }
    }
  };

  const chromeMock = {
    tabs: {
      remove: (tabId, cb) => {
        removedTabs.push(tabId);
        if (cb) setTimeout(cb, 0);
      }
    },
    contentSettings: {
      microphone: createSettingHandler('microphone'),
      camera: createSettingHandler('camera'),
      location: createSettingHandler('location'),
      notifications: createSettingHandler('notifications'),
      clipboard: createSettingHandler('clipboard')
    },
    runtime: { lastError: null }
  };

  const sandbox = {
    window: {},
    document: doc,
    localStorage,
    chrome: chromeMock,
    vivaldi: vivaldiMock,
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

  // Execute mod inside isolated sandbox
  vm.createContext(sandbox);
  try {
    vm.runInContext(MOD_SOURCE, sandbox);
  } catch (err) {
    throw new Error(`Failed to evaluate src/edge-panel-mod.js: ${err.message}`);
  }

  return {
    doc,
    panel,
    panel2,
    webview,
    webview2,
    header,
    closeBtn,
    contentSection,
    localStorage,
    sandbox,
    removedTabs,
    contentSettingsCalls,
    sitePermissionsCalls,
    vivaldiMock
  };
}

// ── Opaque Banner Query Helpers ──────────────────────────────────────────────
function findPermissionBanner(panel) {
  if (!panel) return null;
  return panel.querySelector(
    '.edge-permission-banner, .mod-permission-prompt, .vivaldi-mod-permission-banner, [class*="permission-banner"], [class*="permission-prompt"]'
  );
}

function findAllowButton(banner) {
  if (!banner) return null;
  return banner.querySelector(
    '.edge-perm-allow, .mod-perm-allow, .permission-allow, button[data-action="allow"], button.allow'
  ) || Array.from(banner.querySelectorAll('button')).find(b => /allow/i.test(b.textContent));
}

function findBlockButton(banner) {
  if (!banner) return null;
  return banner.querySelector(
    '.edge-perm-block, .mod-perm-block, .permission-deny, .permission-block, button[data-action="block"], button.block'
  ) || Array.from(banner.querySelectorAll('button')).find(b => /block|deny/i.test(b.textContent));
}

function getStoredPermission(localStorage, origin, permission) {
  const raw = localStorage.getItem('vivaldi_sidebar_permissions');
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return null;
    const originEntry = data[origin];
    if (!originEntry) return null;
    const permVal = originEntry[permission];
    if (!permVal) return null;
    if (typeof permVal === 'string') return permVal.toLowerCase();
    if (typeof permVal === 'object') return (permVal.decision || permVal.state || '').toLowerCase();
  } catch (_) {
    return null;
  }
  return null;
}

// =============================================================================
// SECTION 2: TEST RUNNER ENGINE
// =============================================================================

const testResults = [];

function runTest(tier, category, testName, fn) {
  const record = { tier, category, name: testName, passed: false, error: null };
  try {
    fn();
    record.passed = true;
  } catch (err) {
    record.passed = false;
    record.error = err.message || String(err);
  }
  testResults.push(record);
}

// =============================================================================
// SECTION 3: TIER 1 — FEATURE COVERAGE (>=5 Test Cases per Feature)
// =============================================================================

// ── Feature 1: Event Interception on <webview> ──────────────────────────────
runTest('Tier 1', 'Feature 1: Event Interception', '1.1 Intercepts media permission request and calls preventDefault', () => {
  const h = createVivaldiHarness({ url: 'https://gemini.google.com/app' });
  const { event } = h.webview.dispatchPermissionRequest({ permission: 'media', url: 'https://gemini.google.com/app' });
  assert.strictEqual(event.defaultPrevented, true, 'Event must call preventDefault() to prevent Chromium auto-denial');
});

runTest('Tier 1', 'Feature 1: Event Interception', '1.2 Intercepts geolocation permission request and calls preventDefault', () => {
  const h = createVivaldiHarness({ url: 'https://maps.google.com' });
  const { event } = h.webview.dispatchPermissionRequest({ permission: 'geolocation', url: 'https://maps.google.com' });
  assert.strictEqual(event.defaultPrevented, true, 'Geolocation request must be intercepted with preventDefault()');
});

runTest('Tier 1', 'Feature 1: Event Interception', '1.3 Intercepts notifications permission request and calls preventDefault', () => {
  const h = createVivaldiHarness({ url: 'https://app.slack.com' });
  const { event } = h.webview.dispatchPermissionRequest({ permission: 'notifications', url: 'https://app.slack.com' });
  assert.strictEqual(event.defaultPrevented, true, 'Notifications request must be intercepted with preventDefault()');
});

runTest('Tier 1', 'Feature 1: Event Interception', '1.4 Download permission passes through untouched to Vivaldi handler', () => {
  const h = createVivaldiHarness();
  const { event } = h.webview.dispatchPermissionRequest({ permission: 'download', url: 'https://example.com/file.zip' });
  assert.strictEqual(event.defaultPrevented, false, 'Download permission must NOT be prevented by mod');
  const banner = findPermissionBanner(h.panel);
  assert.strictEqual(banner, null, 'Download permission must not generate an in-panel prompt banner');
});

runTest('Tier 1', 'Feature 1: Event Interception', '1.5 Interception occurs in capture phase before bubbling', () => {
  const h = createVivaldiHarness();
  let bubbleFired = false;
  h.webview.addEventListener('permissionrequest', () => { bubbleFired = true; }, false);
  h.webview.dispatchPermissionRequest({ permission: 'media' });
  const banner = findPermissionBanner(h.panel);
  assert(banner !== null, 'Mod capture listener must execute and mount prompt before bubbling');
});

runTest('Tier 1', 'Feature 1: Event Interception', '1.6 Non-sensitive permissions pass through without generating prompt', () => {
  const h = createVivaldiHarness();
  h.webview.dispatchPermissionRequest({ permission: 'pointerLock' });
  const banner = findPermissionBanner(h.panel);
  assert.strictEqual(banner, null, 'Non-sensitive permissions must not render prompt banners');
});

// ── Feature 2: In-Panel Prompt Banner UI Creation and Structure ─────────────
runTest('Tier 1', 'Feature 2: Prompt UI Structure', '2.1 Creates in-panel prompt banner in DOM upon undecided request', () => {
  const h = createVivaldiHarness();
  h.webview.dispatchPermissionRequest({ permission: 'media' });
  const banner = findPermissionBanner(h.panel);
  assert(banner !== null, 'Banner DOM element must exist in panel');
});

runTest('Tier 1', 'Feature 2: Prompt UI Structure', '2.2 Banner displays requesting origin hostname', () => {
  const h = createVivaldiHarness();
  h.webview.dispatchPermissionRequest({ permission: 'media', url: 'https://gemini.google.com/app' });
  const banner = findPermissionBanner(h.panel);
  assert(banner !== null, 'Banner must exist');
  assert(banner.textContent.includes('gemini.google.com'), `Banner text must mention origin, got: ${banner.textContent}`);
});

runTest('Tier 1', 'Feature 2: Prompt UI Structure', '2.3 Banner displays descriptive requested resource label', () => {
  const h = createVivaldiHarness();
  h.webview.dispatchPermissionRequest({ permission: 'media' });
  const banner = findPermissionBanner(h.panel);
  assert(banner !== null, 'Banner must exist');
  const hasDesc = /mic|camera|media/i.test(banner.textContent);
  assert(hasDesc, `Banner text must describe requested media resource, got: ${banner.textContent}`);
});

runTest('Tier 1', 'Feature 2: Prompt UI Structure', '2.4 Banner provides an explicit Allow button', () => {
  const h = createVivaldiHarness();
  h.webview.dispatchPermissionRequest({ permission: 'media' });
  const banner = findPermissionBanner(h.panel);
  assert(banner !== null, 'Banner must exist');
  const allowBtn = findAllowButton(banner);
  assert(allowBtn !== null, 'Banner must contain an Allow button');
});

runTest('Tier 1', 'Feature 2: Prompt UI Structure', '2.5 Banner provides an explicit Block button distinct from panel close', () => {
  const h = createVivaldiHarness();
  h.webview.dispatchPermissionRequest({ permission: 'media' });
  const banner = findPermissionBanner(h.panel);
  assert(banner !== null, 'Banner must exist');
  const blockBtn = findBlockButton(banner);
  assert(blockBtn !== null, 'Banner must contain a Block button');
  assert(!blockBtn.classList.contains('close'), 'Block button must not share panel .close class');
});

runTest('Tier 1', 'Feature 2: Prompt UI Structure', '2.6 Banner uses scoped CSS classes avoiding collision with panel controls', () => {
  const h = createVivaldiHarness();
  h.webview.dispatchPermissionRequest({ permission: 'media' });
  const banner = findPermissionBanner(h.panel);
  assert(banner !== null, 'Banner must exist');
  assert(!banner.classList.contains('webpanel-header'), 'Banner must not collide with header class');
  assert(!banner.classList.contains('mod-edge-close-btn'), 'Banner must not collide with close button');
});

// ── Feature 3: Allow Button Action ──────────────────────────────────────────
runTest('Tier 1', 'Feature 3: Allow Action', '3.1 Clicking Allow triggers e.request.allow()', () => {
  const h = createVivaldiHarness();
  const { request } = h.webview.dispatchPermissionRequest({ permission: 'media' });
  const banner = findPermissionBanner(h.panel);
  assert(banner !== null, 'Banner must exist');
  const allowBtn = findAllowButton(banner);
  assert(allowBtn !== null, 'Allow button must exist');
  allowBtn.click();
  assert.strictEqual(request.allowed, true, 'request.allow() must be invoked');
});

runTest('Tier 1', 'Feature 3: Allow Action', '3.2 Clicking Allow does NOT trigger e.request.deny()', () => {
  const h = createVivaldiHarness();
  const { request } = h.webview.dispatchPermissionRequest({ permission: 'media' });
  const banner = findPermissionBanner(h.panel);
  findAllowButton(banner).click();
  assert.strictEqual(request.denied, false, 'request.deny() must NOT be invoked on Allow');
});

runTest('Tier 1', 'Feature 3: Allow Action', '3.3 Clicking Allow updates origin persistence storage to allow', () => {
  const h = createVivaldiHarness();
  h.webview.dispatchPermissionRequest({ permission: 'media', url: 'https://gemini.google.com/app' });
  const banner = findPermissionBanner(h.panel);
  findAllowButton(banner).click();
  const stored = getStoredPermission(h.localStorage, 'https://gemini.google.com', 'media');
  assert.strictEqual(stored, 'allow', `Persistence must store "allow", got ${stored}`);
});

runTest('Tier 1', 'Feature 3: Allow Action', '3.4 Clicking Allow dismisses banner from DOM', () => {
  const h = createVivaldiHarness();
  h.webview.dispatchPermissionRequest({ permission: 'media' });
  const banner = findPermissionBanner(h.panel);
  findAllowButton(banner).click();
  const bannerAfter = findPermissionBanner(h.panel);
  assert.strictEqual(bannerAfter, null, 'Banner must be unmounted from DOM upon Allow click');
});

runTest('Tier 1', 'Feature 3: Allow Action', '3.5 Clicking Allow does not trigger panel close or RAM teardown', () => {
  const h = createVivaldiHarness();
  h.webview.dispatchPermissionRequest({ permission: 'media' });
  const banner = findPermissionBanner(h.panel);
  findAllowButton(banner).click();
  assert(h.panel.classList.contains('visible'), 'Panel must remain visible after granting permission');
  assert.strictEqual(h.removedTabs.length, 0, 'Tab must not be destroyed when granting permission');
});

// ── Feature 4: Block Button Action ──────────────────────────────────────────
runTest('Tier 1', 'Feature 4: Block Action', '4.1 Clicking Block triggers e.request.deny()', () => {
  const h = createVivaldiHarness();
  const { request } = h.webview.dispatchPermissionRequest({ permission: 'media' });
  const banner = findPermissionBanner(h.panel);
  assert(banner !== null, 'Banner must exist');
  const blockBtn = findBlockButton(banner);
  assert(blockBtn !== null, 'Block button must exist');
  blockBtn.click();
  assert.strictEqual(request.denied, true, 'request.deny() must be invoked on Block');
});

runTest('Tier 1', 'Feature 4: Block Action', '4.2 Clicking Block does NOT trigger e.request.allow()', () => {
  const h = createVivaldiHarness();
  const { request } = h.webview.dispatchPermissionRequest({ permission: 'media' });
  const banner = findPermissionBanner(h.panel);
  findBlockButton(banner).click();
  assert.strictEqual(request.allowed, false, 'request.allow() must NOT be invoked on Block');
});

runTest('Tier 1', 'Feature 4: Block Action', '4.3 Clicking Block updates origin persistence storage to block/deny', () => {
  const h = createVivaldiHarness();
  h.webview.dispatchPermissionRequest({ permission: 'media', url: 'https://gemini.google.com/app' });
  const banner = findPermissionBanner(h.panel);
  findBlockButton(banner).click();
  const stored = getStoredPermission(h.localStorage, 'https://gemini.google.com', 'media');
  assert(['block', 'deny'].includes(stored), `Persistence must store "block" or "deny", got ${stored}`);
});

runTest('Tier 1', 'Feature 4: Block Action', '4.4 Clicking Block dismisses banner from DOM', () => {
  const h = createVivaldiHarness();
  h.webview.dispatchPermissionRequest({ permission: 'media' });
  const banner = findPermissionBanner(h.panel);
  findBlockButton(banner).click();
  const bannerAfter = findPermissionBanner(h.panel);
  assert.strictEqual(bannerAfter, null, 'Banner must be unmounted from DOM upon Block click');
});

runTest('Tier 1', 'Feature 4: Block Action', '4.5 Clicking Block does not bubble to panel header close handler', () => {
  const h = createVivaldiHarness();
  h.webview.dispatchPermissionRequest({ permission: 'media' });
  const banner = findPermissionBanner(h.panel);
  findBlockButton(banner).click();
  assert(h.panel.classList.contains('visible'), 'Panel must remain open when user blocks permission');
});

// ── Feature 5: Origin Persistence Recall ────────────────────────────────────
runTest('Tier 1', 'Feature 5: Persistence Recall', '5.1 Cached Allow decision immediately calls e.request.allow() without prompting', () => {
  const initialStorage = {
    vivaldi_sidebar_permissions: {
      'https://gemini.google.com': { media: 'allow' }
    }
  };
  const h = createVivaldiHarness({ initialStorage });
  const { request } = h.webview.dispatchPermissionRequest({ permission: 'media', url: 'https://gemini.google.com/app' });
  assert.strictEqual(request.allowed, true, 'Cached Allow must automatically grant access');
  const banner = findPermissionBanner(h.panel);
  assert.strictEqual(banner, null, 'Cached Allow must not display prompt banner');
});

runTest('Tier 1', 'Feature 5: Persistence Recall', '5.2 Cached Block decision immediately calls e.request.deny() without prompting', () => {
  const initialStorage = {
    vivaldi_sidebar_permissions: {
      'https://gemini.google.com': { geolocation: 'block' }
    }
  };
  const h = createVivaldiHarness({ initialStorage });
  const { request } = h.webview.dispatchPermissionRequest({ permission: 'geolocation', url: 'https://gemini.google.com/app' });
  assert.strictEqual(request.denied, true, 'Cached Block must automatically deny access');
  const banner = findPermissionBanner(h.panel);
  assert.strictEqual(banner, null, 'Cached Block must not display prompt banner');
});

runTest('Tier 1', 'Feature 5: Persistence Recall', '5.3 Origin isolation: Cached decision on site A does not affect site B', () => {
  const initialStorage = {
    vivaldi_sidebar_permissions: {
      'https://gemini.google.com': { media: 'allow' }
    }
  };
  const h = createVivaldiHarness({ initialStorage });
  const { request } = h.webview.dispatchPermissionRequest({ permission: 'media', url: 'https://claude.ai/chat' });
  assert.strictEqual(request.allowed, false, 'Decision on gemini.google.com must not auto-allow claude.ai');
  const banner = findPermissionBanner(h.panel);
  assert(banner !== null, 'Undecided origin claude.ai must present permission prompt');
});

runTest('Tier 1', 'Feature 5: Persistence Recall', '5.4 Permission isolation: Stored media decision does not auto-resolve geolocation', () => {
  const initialStorage = {
    vivaldi_sidebar_permissions: {
      'https://gemini.google.com': { media: 'allow' }
    }
  };
  const h = createVivaldiHarness({ initialStorage });
  const { request } = h.webview.dispatchPermissionRequest({ permission: 'geolocation', url: 'https://gemini.google.com/app' });
  assert.strictEqual(request.allowed, false, 'Media decision must not grant geolocation');
  const banner = findPermissionBanner(h.panel);
  assert(banner !== null, 'Undecided permission type must present prompt banner');
});

runTest('Tier 1', 'Feature 5: Persistence Recall', '5.5 Protocol and port isolation: http vs https vs port variants are segregated', () => {
  const initialStorage = {
    vivaldi_sidebar_permissions: {
      'http://localhost:3000': { media: 'allow' }
    }
  };
  const h = createVivaldiHarness({ initialStorage });
  const { request } = h.webview.dispatchPermissionRequest({ permission: 'media', url: 'https://localhost:3000/app' });
  assert.strictEqual(request.allowed, false, 'HTTPS origin must not inherit HTTP decision');
  const banner = findPermissionBanner(h.panel);
  assert(banner !== null, 'Different protocol must prompt user');
});

// =============================================================================
// SECTION 4: TIER 2 — BOUNDARY & CORNER CASES (>=5 Test Cases per Feature)
// =============================================================================

// ── Feature 6: Single-Decision Enforcement ──────────────────────────────────
runTest('Tier 2', 'Feature 6: Single-Decision Guard', '6.1 Rapid double-clicking Allow invokes request.allow() exactly once', () => {
  const h = createVivaldiHarness();
  const { request } = h.webview.dispatchPermissionRequest({ permission: 'media' });
  const banner = findPermissionBanner(h.panel);
  const allowBtn = findAllowButton(banner);
  allowBtn.click();
  // Second click immediately
  try { allowBtn.click(); } catch (_) {}
  assert.strictEqual(request.callCount, 1, 'request.allow() must be invoked exactly once');
});

runTest('Tier 2', 'Feature 6: Single-Decision Guard', '6.2 Rapid double-clicking Block invokes request.deny() exactly once', () => {
  const h = createVivaldiHarness();
  const { request } = h.webview.dispatchPermissionRequest({ permission: 'media' });
  const banner = findPermissionBanner(h.panel);
  const blockBtn = findBlockButton(banner);
  blockBtn.click();
  try { blockBtn.click(); } catch (_) {}
  assert.strictEqual(request.callCount, 1, 'request.deny() must be invoked exactly once');
});

runTest('Tier 2', 'Feature 6: Single-Decision Guard', '6.3 Conflicting clicks (Allow then Block) only applies the first decision', () => {
  const h = createVivaldiHarness();
  const { request } = h.webview.dispatchPermissionRequest({ permission: 'media' });
  const banner = findPermissionBanner(h.panel);
  const allowBtn = findAllowButton(banner);
  const blockBtn = findBlockButton(banner);
  allowBtn.click();
  try { blockBtn.click(); } catch (_) {}
  assert.strictEqual(request.allowed, true, 'First decision (Allow) must hold');
  assert.strictEqual(request.denied, false, 'Second conflicting decision must be discarded');
});

runTest('Tier 2', 'Feature 6: Single-Decision Guard', '6.4 Single-action guard prevents Error: Action already taken from bubbling', () => {
  const h = createVivaldiHarness();
  h.webview.dispatchPermissionRequest({ permission: 'media' });
  const banner = findPermissionBanner(h.panel);
  const allowBtn = findAllowButton(banner);
  assert.doesNotThrow(() => {
    allowBtn.click();
    allowBtn.click();
  }, 'Double-action must be safely guarded against re-entrant exceptions');
});

runTest('Tier 2', 'Feature 6: Single-Decision Guard', '6.5 Buttons are disabled or banner is immediately removed on action', () => {
  const h = createVivaldiHarness();
  h.webview.dispatchPermissionRequest({ permission: 'media' });
  const banner = findPermissionBanner(h.panel);
  const allowBtn = findAllowButton(banner);
  allowBtn.click();
  const bannerAfter = findPermissionBanner(h.panel);
  assert.strictEqual(bannerAfter, null, 'Banner must be unmounted immediately after click');
});

// ── Feature 7: Missing or Malformed Origin / URL in Event ───────────────────
runTest('Tier 2', 'Feature 7: URL Handling', '7.1 Undefined or null event URL handled safely without crash', () => {
  const h = createVivaldiHarness();
  assert.doesNotThrow(() => {
    h.webview.dispatchPermissionRequest({ permission: 'media', url: null });
  }, 'Null URL must not throw unhandled exception');
});

runTest('Tier 2', 'Feature 7: URL Handling', '7.2 Empty string URL handled safely without crash', () => {
  const h = createVivaldiHarness();
  assert.doesNotThrow(() => {
    h.webview.dispatchPermissionRequest({ permission: 'media', url: '' });
  }, 'Empty URL must not crash');
});

runTest('Tier 2', 'Feature 7: URL Handling', '7.3 Malformed non-URL string safely parsed without fatal error', () => {
  const h = createVivaldiHarness();
  assert.doesNotThrow(() => {
    h.webview.dispatchPermissionRequest({ permission: 'media', url: 'not-a-valid://url-string:::' });
  }, 'Malformed URL string must be handled gracefully');
});

runTest('Tier 2', 'Feature 7: URL Handling', '7.4 Opaque schemes (about:blank, data:) do not corrupt localStorage', () => {
  const h = createVivaldiHarness();
  h.webview.dispatchPermissionRequest({ permission: 'media', url: 'about:blank' });
  const banner = findPermissionBanner(h.panel);
  if (banner) {
    const allowBtn = findAllowButton(banner);
    if (allowBtn) allowBtn.click();
  }
  const raw = h.localStorage.getItem('vivaldi_sidebar_permissions');
  if (raw) {
    const data = JSON.parse(raw);
    assert.strictEqual(data['about:blank'], undefined, 'Opaque schemes must not create bad storage keys');
  }
});

runTest('Tier 2', 'Feature 7: URL Handling', '7.5 Falls back to webview src when event url property is missing', () => {
  const h = createVivaldiHarness({ url: 'https://gemini.google.com/app' });
  h.webview.dispatchPermissionRequest({ permission: 'media', url: '' });
  const banner = findPermissionBanner(h.panel);
  assert(banner !== null, 'Banner should be shown using webview src fallback');
  assert(banner.textContent.includes('gemini.google.com'), 'Should display origin derived from webview src');
});

// ── Feature 8: Multiple Simultaneous / Queued Permission Requests ──────────
runTest('Tier 2', 'Feature 8: Concurrency & Queues', '8.1 Multiple requests on same panel do not create duplicated or corrupted DOM', () => {
  const h = createVivaldiHarness();
  h.webview.dispatchPermissionRequest({ permission: 'media' });
  h.webview.dispatchPermissionRequest({ permission: 'geolocation' });
  const banners = h.panel.querySelectorAll('.edge-permission-banner, .mod-permission-prompt');
  assert(banners.length <= 1, 'Only one prompt banner should be rendered at a time per panel');
});

runTest('Tier 2', 'Feature 8: Concurrency & Queues', '8.2 Resolving first request allows processing of next queued request', () => {
  const h = createVivaldiHarness();
  const req1 = h.webview.dispatchPermissionRequest({ permission: 'media' });
  const req2 = h.webview.dispatchPermissionRequest({ permission: 'geolocation' });
  let banner = findPermissionBanner(h.panel);
  assert(banner !== null, 'Banner for first request must exist');
  findAllowButton(banner).click();
  assert.strictEqual(req1.request.allowed, true, 'First request must be allowed');
  // Check if second request is presented
  banner = findPermissionBanner(h.panel);
  if (banner) {
    findBlockButton(banner).click();
    assert.strictEqual(req2.request.denied, true, 'Second request must be blockable');
  }
});

runTest('Tier 2', 'Feature 8: Concurrency & Queues', '8.3 Concurrent requests on independent panels operate in total isolation', () => {
  const h = createVivaldiHarness({ createSecondPanel: true });
  const req1 = h.webview.dispatchPermissionRequest({ permission: 'media', url: 'https://gemini.google.com' });
  const req2 = h.webview2.dispatchPermissionRequest({ permission: 'geolocation', url: 'https://maps.google.com' });
  const banner1 = findPermissionBanner(h.panel);
  const banner2 = findPermissionBanner(h.panel2);
  assert(banner1 !== null, 'Panel 1 must have banner');
  assert(banner2 !== null, 'Panel 2 must have banner');
  findAllowButton(banner1).click();
  assert.strictEqual(req1.request.allowed, true, 'Panel 1 request granted');
  assert.strictEqual(req2.request.actionTaken, false, 'Panel 2 request must remain undecided');
});

runTest('Tier 2', 'Feature 8: Concurrency & Queues', '8.4 Closing Panel 1 does not affect active prompt on Panel 2', () => {
  const h = createVivaldiHarness({ createSecondPanel: true });
  h.webview.dispatchPermissionRequest({ permission: 'media' });
  h.webview2.dispatchPermissionRequest({ permission: 'geolocation' });
  h.closeBtn.click();
  const banner2 = findPermissionBanner(h.panel2);
  assert(banner2 !== null, 'Panel 2 prompt must remain intact after closing Panel 1');
});

runTest('Tier 2', 'Feature 8: Concurrency & Queues', '8.5 Granting permission on Panel 1 does not dismiss prompt on Panel 2', () => {
  const h = createVivaldiHarness({ createSecondPanel: true });
  h.webview.dispatchPermissionRequest({ permission: 'media' });
  h.webview2.dispatchPermissionRequest({ permission: 'geolocation' });
  const banner1 = findPermissionBanner(h.panel);
  findAllowButton(banner1).click();
  const banner2 = findPermissionBanner(h.panel2);
  assert(banner2 !== null, 'Panel 2 prompt must still be present');
});

// ── Feature 9: Corrupted or Full localStorage Handling ──────────────────────
runTest('Tier 2', 'Feature 9: Storage Resilience', '9.1 Corrupted non-JSON string in localStorage does not crash mod', () => {
  const initialStorage = { vivaldi_sidebar_permissions: '{ INVALID_JSON_DATA...' };
  const h = createVivaldiHarness({ initialStorage });
  assert.doesNotThrow(() => {
    h.webview.dispatchPermissionRequest({ permission: 'media' });
  }, 'Corrupted storage string must not throw unhandled JSON parse error');
  const banner = findPermissionBanner(h.panel);
  assert(banner !== null, 'Should gracefully fallback and display prompt banner');
});

runTest('Tier 2', 'Feature 9: Storage Resilience', '9.2 QuotaExceededError on localStorage.setItem is safely handled', () => {
  const h = createVivaldiHarness();
  h.localStorage.throwOnSet = new Error('QuotaExceededError');
  h.webview.dispatchPermissionRequest({ permission: 'media' });
  const banner = findPermissionBanner(h.panel);
  assert.doesNotThrow(() => {
    findAllowButton(banner).click();
  }, 'Quota error must not crash the permission grant flow');
});

runTest('Tier 2', 'Feature 9: Storage Resilience', '9.3 SecurityError on localStorage.getItem (Private Window) safely handled', () => {
  const h = createVivaldiHarness();
  h.localStorage.throwOnGet = new Error('SecurityError: Access denied');
  assert.doesNotThrow(() => {
    h.webview.dispatchPermissionRequest({ permission: 'media' });
  }, 'SecurityError must not crash prompt interception');
  const banner = findPermissionBanner(h.panel);
  assert(banner !== null, 'Prompt should still be shown when storage read is blocked');
});

runTest('Tier 2', 'Feature 9: Storage Resilience', '9.4 Null localStorage reference falls back to in-memory store', () => {
  const h = createVivaldiHarness();
  h.sandbox.window.localStorage = null;
  assert.doesNotThrow(() => {
    h.webview.dispatchPermissionRequest({ permission: 'media' });
  }, 'Null localStorage must not throw TypeError');
});

runTest('Tier 2', 'Feature 9: Storage Resilience', '9.5 Primitive JSON value (number or boolean) in storage handled safely', () => {
  const initialStorage = { vivaldi_sidebar_permissions: '12345' };
  const h = createVivaldiHarness({ initialStorage });
  assert.doesNotThrow(() => {
    h.webview.dispatchPermissionRequest({ permission: 'media' });
  }, 'Primitive JSON in storage key must not cause TypeError');
});

// ── Feature 10: Clean Dismissal on Panel Close or Navigation ────────────────
runTest('Tier 2', 'Feature 10: Dismissal Lifecycle', '10.1 Panel Close (X) button dismisses active prompt banner from DOM', () => {
  const h = createVivaldiHarness();
  h.webview.dispatchPermissionRequest({ permission: 'media' });
  assert(findPermissionBanner(h.panel) !== null, 'Banner must exist before close');
  h.closeBtn.click();
  assert.strictEqual(findPermissionBanner(h.panel), null, 'Banner must be unmounted when panel is closed');
});

runTest('Tier 2', 'Feature 10: Dismissal Lifecycle', '10.2 Panel Close (X) calls deny() on pending request to release native handle', () => {
  const h = createVivaldiHarness();
  const { request } = h.webview.dispatchPermissionRequest({ permission: 'media' });
  h.closeBtn.click();
  assert.strictEqual(request.denied, true, 'Pending request must be denied upon panel close');
});

runTest('Tier 2', 'Feature 10: Dismissal Lifecycle', '10.3 Webview navigation changes dismiss active prompt banner', () => {
  const h = createVivaldiHarness();
  h.webview.dispatchPermissionRequest({ permission: 'media', url: 'https://gemini.google.com' });
  assert(findPermissionBanner(h.panel) !== null, 'Banner must exist before navigation');
  h.webview.src = 'https://wikipedia.org';
  MockMutationObserver.notify('attributes', h.webview, { attributeName: 'src' });
  assert.strictEqual(findPermissionBanner(h.panel), null, 'Banner must dismiss when webview navigates');
});

runTest('Tier 2', 'Feature 10: Dismissal Lifecycle', '10.4 Webview detachment from DOM tears down associated prompt banner', () => {
  const h = createVivaldiHarness();
  h.webview.dispatchPermissionRequest({ permission: 'media' });
  assert(findPermissionBanner(h.panel) !== null, 'Banner must exist');
  h.webview.remove();
  assert.strictEqual(findPermissionBanner(h.panel), null, 'Detaching webview must clean up prompt banner');
});

runTest('Tier 2', 'Feature 10: Dismissal Lifecycle', '10.5 Reopening closed panel does not show stale undecided prompt banner', () => {
  const h = createVivaldiHarness();
  h.webview.dispatchPermissionRequest({ permission: 'media' });
  h.closeBtn.click();
  h.panel.classList.add('visible');
  assert.strictEqual(findPermissionBanner(h.panel), null, 'Reopened panel must not display stale prompt');
});

// =============================================================================
// SECTION 5: TIER 3 — CROSS-FEATURE COMBINATIONS (Pairwise)
// =============================================================================

runTest('Tier 3', 'Cross-Feature Interactions', '11.1 Permission decision followed by 1-click close executes RAM teardown while saving decision', (done) => {
  const h = createVivaldiHarness();
  h.webview.dispatchPermissionRequest({ permission: 'media', url: 'https://gemini.google.com' });
  const banner = findPermissionBanner(h.panel);
  findAllowButton(banner).click();

  // Explicit close
  h.closeBtn.click();
  // Wait for GLIDE_DELAY_MS (150ms)
  setTimeout(() => {
    assert(h.removedTabs.includes(101), 'chrome.tabs.remove(101) must be called after glide delay');
    const stored = getStoredPermission(h.localStorage, 'https://gemini.google.com', 'media');
    assert.strictEqual(stored, 'allow', 'Permission decision must survive tab destruction');
  }, 160);
});

runTest('Tier 3', 'Cross-Feature Interactions', '11.2 Permission prompt active during multitasking blur preserves prompt and warm RAM', () => {
  const h = createVivaldiHarness();
  h.webview.dispatchPermissionRequest({ permission: 'media' });
  assert(findPermissionBanner(h.panel) !== null, 'Banner must exist');

  // User clicks outside -> blur -> panel loses .visible class
  h.panel.classList.remove('visible');
  assert.strictEqual(h.removedTabs.length, 0, 'Multitask blur must NOT trigger chrome.tabs.remove');

  // User clicks back -> panel gains .visible class
  h.panel.classList.add('visible');
  const bannerAfter = findPermissionBanner(h.panel);
  assert(bannerAfter !== null, 'Banner must remain intact and interactive after multitasking blur');
});

runTest('Tier 3', 'Cross-Feature Interactions', '11.3 Download event occurring while permission prompt is displayed passes through cleanly', () => {
  const h = createVivaldiHarness();
  h.webview.dispatchPermissionRequest({ permission: 'media' });
  assert(findPermissionBanner(h.panel) !== null, 'Media prompt banner must exist');

  // Guest triggers download link
  const dlRes = h.webview.dispatchPermissionRequest({ permission: 'download', url: 'https://gemini.google.com/export.pdf' });
  assert.strictEqual(dlRes.event.defaultPrevented, false, 'Download must pass through without hindrance');
  const bannerAfter = findPermissionBanner(h.panel);
  assert(bannerAfter !== null, 'Media prompt banner must remain intact while download proceeds');
});

runTest('Tier 3', 'Cross-Feature Interactions', '11.4 Reopening closed panel preserves stored origin permissions', () => {
  const h = createVivaldiHarness();
  h.webview.dispatchPermissionRequest({ permission: 'media', url: 'https://gemini.google.com' });
  findAllowButton(findPermissionBanner(h.panel)).click();

  // Close panel
  h.closeBtn.click();
  assert(h.sandbox.window.__edgeShouldReset(h.panel.id), '__edgeShouldReset flag must be set');

  // Reopen panel
  h.panel.classList.add('visible');
  // New request from site
  const { request } = h.webview.dispatchPermissionRequest({ permission: 'media', url: 'https://gemini.google.com' });
  assert.strictEqual(request.allowed, true, 'Previously granted permission must immediately auto-allow on reopen');
  assert.strictEqual(findPermissionBanner(h.panel), null, 'No prompt should be shown on reopen');
});

// =============================================================================
// SECTION 6: TIER 4 — REAL-WORLD APPLICATION SCENARIOS
// =============================================================================

runTest('Tier 4', 'Real-World Scenarios', '12.1 Google Meet / Zoom guest asking for camera & microphone', () => {
  const h = createVivaldiHarness({ url: 'https://meet.google.com/abc-defg-hij' });
  const { request } = h.webview.dispatchPermissionRequest({ permission: 'media', url: 'https://meet.google.com/abc-defg-hij' });
  const banner = findPermissionBanner(h.panel);
  assert(banner !== null, 'Google Meet must trigger permission prompt banner');
  assert(banner.textContent.includes('meet.google.com'), 'Must identify meet.google.com');

  findAllowButton(banner).click();
  assert.strictEqual(request.allowed, true, 'User granting allows WebRTC stream access');

  // Next session on Meet
  const secondReq = h.webview.dispatchPermissionRequest({ permission: 'media', url: 'https://meet.google.com/xyz-uvwx-rst' });
  assert.strictEqual(secondReq.request.allowed, true, 'Next Meet meeting must be granted immediately');
});

runTest('Tier 4', 'Real-World Scenarios', '12.2 Google Maps / delivery app guest asking for Geolocation', () => {
  const h = createVivaldiHarness({ url: 'https://maps.google.com' });
  const { request } = h.webview.dispatchPermissionRequest({ permission: 'geolocation', url: 'https://maps.google.com' });
  const banner = findPermissionBanner(h.panel);
  assert(banner !== null, 'Google Maps must trigger permission prompt');
  assert(/location|geo/i.test(banner.textContent), 'Prompt must indicate location request');

  findBlockButton(banner).click();
  assert.strictEqual(request.denied, true, 'User blocking rejects geolocation');

  // Subsequent visit auto-denied
  const secondReq = h.webview.dispatchPermissionRequest({ permission: 'geolocation', url: 'https://maps.google.com/dir' });
  assert.strictEqual(secondReq.request.denied, true, 'Subsequent geolocation request must be auto-denied');
});

runTest('Tier 4', 'Real-World Scenarios', '12.3 Slack / Discord web app asking for Notifications', () => {
  const h = createVivaldiHarness({ url: 'https://app.slack.com/client/T1/C1' });
  const { request } = h.webview.dispatchPermissionRequest({ permission: 'notifications', url: 'https://app.slack.com/client/T1/C1' });
  const banner = findPermissionBanner(h.panel);
  assert(banner !== null, 'Slack notifications request must show prompt');
  findAllowButton(banner).click();
  assert.strictEqual(request.allowed, true, 'Notifications allowed');
});

runTest('Tier 4', 'Real-World Scenarios', '12.4 Permission Revocation via __edgeRevokePermission & __edgeClearAllPermissions', () => {
  const initialStorage = {
    vivaldi_sidebar_permissions: {
      'https://gemini.google.com': { media: 'allow' },
      'https://maps.google.com': { geolocation: 'block' }
    }
  };
  const h = createVivaldiHarness({ initialStorage });

  const revokeFn = h.sandbox.window.__edgeRevokePermission || h.sandbox.window.__edgePanelPermissions?.revoke;
  const clearFn = h.sandbox.window.__edgeClearAllPermissions || h.sandbox.window.__edgePanelPermissions?.clear;

  assert.strictEqual(typeof revokeFn, 'function', 'window.__edgeRevokePermission must be exposed');
  assert.strictEqual(typeof clearFn, 'function', 'window.__edgeClearAllPermissions must be exposed');

  // Revoke Gemini media
  revokeFn('https://gemini.google.com', 'media');
  const geminiReq = h.webview.dispatchPermissionRequest({ permission: 'media', url: 'https://gemini.google.com/app' });
  assert.strictEqual(geminiReq.request.actionTaken, false, 'Revoked origin must no longer auto-grant');
  assert(findPermissionBanner(h.panel) !== null, 'Revoked origin must show prompt again');

  // Clear all
  clearFn();
  const mapsReq = h.webview.dispatchPermissionRequest({ permission: 'geolocation', url: 'https://maps.google.com' });
  assert.strictEqual(mapsReq.request.actionTaken, false, 'Cleared permissions must no longer auto-block');
});

runTest('Tier 4', 'Real-World Scenarios', '12.5 Multi-panel switching with independent permission prompts', () => {
  const h = createVivaldiHarness({ createSecondPanel: true });
  h.webview.dispatchPermissionRequest({ permission: 'media', url: 'https://gemini.google.com' });
  h.webview2.dispatchPermissionRequest({ permission: 'notifications', url: 'https://discord.com/channels' });

  // Switch active panel: Panel 1 hidden, Panel 2 visible
  h.panel.classList.remove('visible');
  h.panel2.classList.add('visible');

  const banner2 = findPermissionBanner(h.panel2);
  assert(banner2 !== null, 'Discord panel prompt must be visible');
  assert(banner2.textContent.includes('discord.com'), 'Discord prompt belongs to Panel 2');

  findAllowButton(banner2).click();

  // Switch back to Panel 1
  h.panel2.classList.remove('visible');
  h.panel.classList.add('visible');

  const banner1 = findPermissionBanner(h.panel);
  assert(banner1 !== null, 'Gemini panel prompt must still be present and pending');
  assert(banner1.textContent.includes('gemini.google.com'), 'Gemini prompt belongs to Panel 1');
});

// =============================================================================
// SECTION 6B: TIER 5 - CONTENT SETTINGS & SITE PERMISSIONS BRIDGE TESTS
// =============================================================================

runTest('Tier 5', 'ContentSettings & SitePermissions Bridge', '13.1 User clicks Allow: chrome.contentSettings.microphone & camera updated to allow', () => {
  const h = createVivaldiHarness();
  const { request } = h.webview.dispatchPermissionRequest({ permission: 'media', url: 'https://gemini.google.com/app' });

  const banner = findPermissionBanner(h.panel);
  assert(banner !== null, 'Banner must be visible');
  findAllowButton(banner).click();

  assert.strictEqual(request.allowed, true, 'request.allow() called');
  const micSets = h.contentSettingsCalls.microphone.filter(c => c.action === 'set');
  assert(micSets.length > 0, 'chrome.contentSettings.microphone.set must be called');
  assert.strictEqual(micSets[0].setting, 'allow');
  assert.strictEqual(micSets[0].primaryPattern, 'https://gemini.google.com/*');
});

runTest('Tier 5', 'ContentSettings & SitePermissions Bridge', '13.2 User clicks Block: chrome.contentSettings.microphone & camera updated to block', () => {
  const h = createVivaldiHarness();
  const { request } = h.webview.dispatchPermissionRequest({ permission: 'media', url: 'https://gemini.google.com/app' });

  const banner = findPermissionBanner(h.panel);
  findBlockButton(banner).click();

  assert.strictEqual(request.denied, true, 'request.deny() called');
  const micSets = h.contentSettingsCalls.microphone.filter(c => c.action === 'set');
  assert(micSets.length > 0, 'chrome.contentSettings.microphone.set must be called');
  assert.strictEqual(micSets[0].setting, 'block');
});

runTest('Tier 5', 'ContentSettings & SitePermissions Bridge', '13.3 vivaldi.sitePermissions.setSitePermission called for media-stream-mic and media-stream-camera', () => {
  const h = createVivaldiHarness();
  h.webview.dispatchPermissionRequest({ permission: 'media', url: 'https://gemini.google.com/app' });

  const banner = findPermissionBanner(h.panel);
  findAllowButton(banner).click();

  const siteSets = h.sitePermissionsCalls.filter(c => c.action === 'set');
  assert(siteSets.some(c => c.permission === 'media-stream-mic' && c.setting === 'allow'), 'media-stream-mic must be set');
  assert(siteSets.some(c => c.permission === 'media-stream-camera' && c.setting === 'allow'), 'media-stream-camera must be set');
});

runTest('Tier 5', 'ContentSettings & SitePermissions Bridge', '13.4 vivaldi.sitePermissions.onPermissionRequest listener responds with allow and syncs settings', () => {
  const h = createVivaldiHarness();
  assert(h.vivaldiMock.sitePermissions.onPermissionRequest._listeners.length > 0, 'Listener registered');

  h.vivaldiMock.sitePermissions.onPermissionRequest._trigger({
    requestId: 42,
    origin: 'https://gemini.google.com',
    permission: 'media-stream-mic',
    devices: ['mic1']
  });

  const banner = findPermissionBanner(h.panel);
  assert(banner !== null, 'Banner must display for sitePermissions request');
  findAllowButton(banner).click();

  const responds = h.sitePermissionsCalls.filter(c => c.action === 'respond');
  assert(responds.some(c => c.requestId === 42 && c.response === 'allow'), 'respondToPermissionRequest must be called with allow');
});

runTest('Tier 5', 'ContentSettings & SitePermissions Bridge', '13.5 Permissions sync on panel reopen and initialization', () => {
  const initialStorage = {
    vivaldi_sidebar_permissions: {
      'https://gemini.google.com': { media: 'allow' }
    }
  };
  const h = createVivaldiHarness({ initialStorage });

  const micSets = h.contentSettingsCalls.microphone.filter(c => c.action === 'set');
  assert(micSets.length > 0, 'Bootstrap must auto-sync stored permissions to chrome.contentSettings');
  assert.strictEqual(micSets[0].setting, 'allow');
});

runTest('Tier 5', 'ContentSettings & SitePermissions Bridge', '13.6 Revocation clears both chrome.contentSettings and vivaldi.sitePermissions', () => {
  const initialStorage = {
    vivaldi_sidebar_permissions: {
      'https://gemini.google.com': { media: 'allow' }
    }
  };
  const h = createVivaldiHarness({ initialStorage });

  h.sandbox.__edgeRevokePermission('https://gemini.google.com', 'media');

  const micClears = h.contentSettingsCalls.microphone.filter(c => c.action === 'clear');
  assert(micClears.length > 0, 'chrome.contentSettings.microphone.clear must be called on revocation');
  const siteResets = h.sitePermissionsCalls.filter(c => c.action === 'reset');
  assert(siteResets.some(c => c.origin === 'https://gemini.google.com'), 'resetSitePermissions must be called on revocation');
});

// =============================================================================
// SECTION 7: TEST RESULTS AGGREGATION & REPORTING
// =============================================================================

function printResults() {
  console.log('\n======================================================================');
  console.log('🧪 Vivaldi Web Panel Permission System — E2E Test Suite (v1.3.0)');
  console.log('======================================================================\n');

  let currentTier = '';
  let currentCategory = '';
  let passedCount = 0;
  let failedCount = 0;

  for (const r of testResults) {
    if (r.tier !== currentTier) {
      currentTier = r.tier;
      console.log(`\n──────────────────────────────────────────────────────────────────────`);
      console.log(`🔷 ${currentTier}`);
      console.log(`──────────────────────────────────────────────────────────────────────`);
    }
    if (r.category !== currentCategory) {
      currentCategory = r.category;
      console.log(`\n  ▶ ${currentCategory}`);
    }

    if (r.passed) {
      passedCount++;
      console.log(`    ✔ [PASS] ${r.name}`);
    } else {
      failedCount++;
      console.log(`    ✖ [FAIL] ${r.name}`);
      console.log(`      → Reason: ${r.error}`);
    }
  }

  const total = testResults.length;
  console.log('\n======================================================================');
  console.log('📊 TEST EXECUTION SUMMARY:');
  console.log(`   Total Tests : ${total}`);
  console.log(`   Passed      : ${passedCount}`);
  console.log(`   Failed      : ${failedCount}`);
  console.log(`   Pass Rate   : ${((passedCount / total) * 100).toFixed(1)}%`);
  console.log('======================================================================\n');

  if (failedCount > 0) {
    console.log(`⚠️  ${failedCount} test(s) failed against the current source code.`);
    console.log('   Expected during initial test suite creation prior to feature implementation.');
    process.exit(1);
  } else {
    console.log('🎉 ALL 5 TIERS PASSED (100% GREEN)! Permission system verified.');
    process.exit(0);
  }
}

// Allow asynchronous tests (e.g. 11.1 timers) to settle before printing summary
setTimeout(printResults, 250);
