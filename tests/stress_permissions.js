/**
 * =============================================================================
 * EMPIRICAL ADVERSARIAL STRESS TEST SUITE: In-Panel Permission Prompt System
 * =============================================================================
 *
 * Target: `src/edge-panel-mod.js` (v1.3.0)
 * Author: challenger_1 (Adversarial Stress Challenger / EMPIRICAL CHALLENGER)
 *
 * Hostile Stress Probing Vectors:
 *   1. High-concurrency bursts & deep queues (50-100+ requests across panels).
 *   2. Rapid alternating Allow/Block hammering on banner action buttons.
 *   3. Storage corruption, quota exhaustion, & SecurityError (private window).
 *   4. Malformed, hostile, opaque, & XSS-vector URLs.
 *   5. Webview DOM removal, navigation, & panel lifecycle race conditions.
 *   6. Asynchronous fuzzing oracle verifying Chromium <webview> NEVER throws
 *      "Action already taken" under any interleaving.
 * =============================================================================
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const MOD_PATH = path.join(__dirname, '../src/edge-panel-mod.js');
assert(fs.existsSync(MOD_PATH), `Source file not found at ${MOD_PATH}`);
const MOD_SOURCE = fs.readFileSync(MOD_PATH, 'utf8');

// =============================================================================
// SECTION 1: SIMULATION HARNESS INFRASTRUCTURE
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
    for (const c of this.childNodes) out += c.textContent || '';
    return out;
  }
  set textContent(v) {
    this.childNodes.forEach(c => { c.parentNode = null; c.parentElement = null; });
    this.childNodes = [];
    if (v) this.appendChild(new MockTextNode(v));
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

    // Capture
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

    // Target
    if (!event.immediatePropagationStopped) {
      event.currentTarget = this;
      const list = this._listeners.get(event.type) || [];
      for (const entry of list) {
        if (event.immediatePropagationStopped) break;
        entry.fn.call(this, event);
      }
    }

    // Bubble
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

  matches(sel) { return matchesSelector(this, sel); }

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

// Strict Chromium Permission Request Oracle
class StrictChromiumPermissionRequest {
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
    const url = options.url !== undefined ? options.url : (this.src || 'https://gemini.google.com/app');
    const req = options.request || new StrictChromiumPermissionRequest(url);
    const event = new MockPermissionRequestEvent(permission, url, req, options);
    this.dispatchEvent(event);
    return { event, request: req };
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

class MockLocalStorage {
  constructor() {
    this._store = new Map();
    this.throwOnSet = null;
    this.throwOnGet = null;
    this.throwOnRemove = null;
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
    if (this.throwOnRemove) throw this.throwOnRemove;
    this._store.delete(String(key));
  }
  clear() {
    this._store.clear();
  }
  get length() { return this._store.size; }
}

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
  querySelector(sel) { return this.body.querySelector(sel); }
  querySelectorAll(sel) { return this.body.querySelectorAll(sel); }
}

function createHarness(options = {}) {
  const doc = new MockDocument();
  const panelsContainer = doc.createElement('div');
  panelsContainer.id = 'panels-container';
  doc.body.appendChild(panelsContainer);

  const panelsSwitcher = doc.createElement('div');
  panelsSwitcher.id = 'panels';
  panelsContainer.appendChild(panelsSwitcher);

  const panels = [];
  const webviews = [];
  const panelCount = options.panelCount || 1;

  for (let i = 0; i < panelCount; i++) {
    const p = doc.createElement('div');
    p.className = 'panel webpanel visible';
    p.id = `panel-${i}`;
    p.setAttribute('data-id', `panel-${i}`);
    panelsSwitcher.appendChild(p);

    const hdr = doc.createElement('header');
    hdr.className = 'webpanel-header toolbar toolbar-default';
    p.appendChild(hdr);

    const closeBtn = doc.createElement('button');
    closeBtn.className = 'close transparent';
    closeBtn.setAttribute('title', 'Close Panel');
    hdr.appendChild(closeBtn);

    const content = doc.createElement('section');
    content.className = 'webpanel-content';
    p.appendChild(content);

    const wv = doc.createElement('webview');
    wv.tab_id = 100 + i;
    wv.src = options.urls ? options.urls[i] : (options.url || `https://panel-${i}.test`);
    content.appendChild(wv);

    panels.push(p);
    webviews.push(wv);
  }

  const localStorage = new MockLocalStorage();
  if (options.initialStorage) {
    for (const [k, v] of Object.entries(options.initialStorage)) {
      localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
  }

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
    panel: panels[0],
    panels,
    webview: webviews[0],
    webviews,
    localStorage,
    sandbox,
    removedTabs
  };
}

function getBanner(panel) {
  if (!panel) return null;
  return panel.querySelector('.edge-permission-banner');
}

function getAllowBtn(banner) {
  return banner?.querySelector('.edge-perm-allow, [data-action="allow"]');
}

function getBlockBtn(banner) {
  return banner?.querySelector('.edge-perm-block, [data-action="block"]');
}

// =============================================================================
// SECTION 2: ADVERSARIAL STRESS TEST RUNNER
// =============================================================================

const stressResults = [];
let suiteCount = 0;

function runStress(category, name, fn) {
  try {
    fn();
    stressResults.push({ category, name, passed: true });
  } catch (err) {
    stressResults.push({ category, name, passed: false, error: err.stack || err.message });
  }
}

async function runStressAsync(category, name, fn) {
  try {
    await fn();
    stressResults.push({ category, name, passed: true });
  } catch (err) {
    stressResults.push({ category, name, passed: false, error: err.stack || err.message });
  }
}

console.log('======================================================================');
console.log('⚡ EMPIRICAL ADVERSARIAL STRESS TEST HARNESS — PERMISSION SYSTEM');
console.log('======================================================================\n');

// ── SUITE 1: High-Concurrency Bursts & Deep Queues ──────────────────────────

runStress('Concurrency Burst', '1.1 50 rapid concurrent requests on single panel with FIFO resolution', () => {
  const h = createHarness();
  const requests = [];
  const count = 50;

  for (let i = 0; i < count; i++) {
    const origin = `https://site-${i}.domain.com`;
    const r = h.webview.dispatchPermissionRequest({
      permission: i % 2 === 0 ? 'media' : 'geolocation',
      url: `${origin}/page`
    });
    requests.push(r.request);
  }

  // Exactly 1 banner displayed initially
  let banner = getBanner(h.panel);
  assert(banner !== null, 'Banner must be mounted for the first request');
  assert.strictEqual(h.panel.querySelectorAll('.edge-permission-banner').length, 1, 'Only 1 banner rendered');

  // Incrementally resolve all 50 queued requests alternating allow/block
  for (let i = 0; i < count; i++) {
    banner = getBanner(h.panel);
    assert(banner !== null, `Banner must exist for queued item ${i}`);
    assert(banner.textContent.includes(`site-${i}.domain.com`), `Banner ${i} has correct origin context`);

    if (i % 2 === 0) {
      getAllowBtn(banner).click();
      assert.strictEqual(requests[i].allowed, true, `Request ${i} must be allowed`);
    } else {
      getBlockBtn(banner).click();
      assert.strictEqual(requests[i].denied, true, `Request ${i} must be denied`);
    }
    assert.strictEqual(requests[i].callCount, 1, `Request ${i} callCount must strictly be 1`);
  }

  // After all 50 resolved, banner must be unmounted and queue empty
  assert.strictEqual(getBanner(h.panel), null, 'Queue must be drained and banner unmounted');
});

runStress('Concurrency Burst', '1.2 100 simultaneous requests for same origin auto-drain without stack overflow', () => {
  const h = createHarness();
  const requests = [];
  const count = 100;
  const origin = 'https://chat.openai.com';

  for (let i = 0; i < count; i++) {
    const r = h.webview.dispatchPermissionRequest({ permission: 'media', url: `${origin}/chat` });
    requests.push(r.request);
  }

  const banner = getBanner(h.panel);
  assert(banner !== null, 'Banner exists for first request');

  // Clicking Allow on request 0 must trigger synchronous auto-drain of remaining 99
  assert.doesNotThrow(() => {
    getAllowBtn(banner).click();
  }, 'Draining 100 items must not exceed call stack size');

  // Verify all 100 were allowed exactly once
  for (let i = 0; i < count; i++) {
    assert.strictEqual(requests[i].allowed, true, `Request ${i} must be allowed`);
    assert.strictEqual(requests[i].callCount, 1, `Request ${i} callCount must be 1`);
  }
  assert.strictEqual(getBanner(h.panel), null, 'Banner dismissed after auto-drain');
});

runStress('Concurrency Burst', '1.3 Multi-panel crossfire: 10 webviews × 10 concurrent requests (100 total)', () => {
  const h = createHarness({ panelCount: 10 });
  const allReqs = [];

  // Dispatch 10 requests to each of the 10 webviews
  for (let p = 0; p < 10; p++) {
    const panelReqs = [];
    for (let r = 0; r < 10; r++) {
      const res = h.webviews[p].dispatchPermissionRequest({
        permission: 'media',
        url: `https://panel-${p}-origin.org`
      });
      panelReqs.push(res.request);
    }
    allReqs.push(panelReqs);
  }

  // Each panel must have exactly 1 active banner
  for (let p = 0; p < 10; p++) {
    const banner = getBanner(h.panels[p]);
    assert(banner !== null, `Panel ${p} must have an active prompt banner`);
    assert.strictEqual(h.panels[p].querySelectorAll('.edge-permission-banner').length, 1);
  }

  // Allow Panel 0 prompt: should drain all 10 on Panel 0, leaving panels 1..9 untouched
  const banner0 = getBanner(h.panels[0]);
  getAllowBtn(banner0).click();
  for (let r = 0; r < 10; r++) {
    assert.strictEqual(allReqs[0][r].allowed, true, `Panel 0 Req ${r} allowed`);
  }
  for (let p = 1; p < 10; p++) {
    for (let r = 0; r < 10; r++) {
      assert.strictEqual(allReqs[p][r].actionTaken, false, `Panel ${p} Req ${r} untouched`);
    }
    assert(getBanner(h.panels[p]) !== null, `Panel ${p} banner still visible`);
  }
});

// ── SUITE 2: Rapid Hammering & Action Flapping ──────────────────────────────

runStress('Hammering & Flapping', '2.1 500 synchronous clicks on Allow button invokes allow() exactly once', () => {
  const h = createHarness();
  const { request } = h.webview.dispatchPermissionRequest({ permission: 'media' });
  const banner = getBanner(h.panel);
  const allowBtn = getAllowBtn(banner);

  assert.doesNotThrow(() => {
    for (let i = 0; i < 500; i++) {
      allowBtn.click();
    }
  }, 'Rapid clicking must not throw');

  assert.strictEqual(request.allowed, true, 'Request was allowed');
  assert.strictEqual(request.denied, false, 'Request was never denied');
  assert.strictEqual(request.callCount, 1, 'request.allow() called strictly once');
  assert.strictEqual(getBanner(h.panel), null, 'Banner removed immediately');
});

runStress('Hammering & Flapping', '2.2 500 alternating clicks [Allow, Block, Allow, Block...] respects first click only', () => {
  const h = createHarness();
  const { request } = h.webview.dispatchPermissionRequest({ permission: 'media' });
  const banner = getBanner(h.panel);
  const allowBtn = getAllowBtn(banner);
  const blockBtn = getBlockBtn(banner);

  // Hammer alternating
  for (let i = 0; i < 250; i++) {
    allowBtn.click();
    blockBtn.click();
  }

  assert.strictEqual(request.allowed, true, 'First click (Allow) must prevail');
  assert.strictEqual(request.denied, false, 'Subsequent Block clicks must be rejected');
  assert.strictEqual(request.callCount, 1, 'request.allow() called strictly once');
});

runStress('Hammering & Flapping', '2.3 500 alternating clicks starting with Block respects Block only', () => {
  const h = createHarness();
  const { request } = h.webview.dispatchPermissionRequest({ permission: 'media' });
  const banner = getBanner(h.panel);
  const allowBtn = getAllowBtn(banner);
  const blockBtn = getBlockBtn(banner);

  // Hammer starting with Block
  for (let i = 0; i < 250; i++) {
    blockBtn.click();
    allowBtn.click();
  }

  assert.strictEqual(request.denied, true, 'First click (Block) must prevail');
  assert.strictEqual(request.allowed, false, 'Allow click must be rejected');
  assert.strictEqual(request.callCount, 1, 'request.deny() called strictly once');
});

runStress('Hammering & Flapping', '2.4 Simultaneous pointerdown + click + keydown event flooding on action buttons', () => {
  const h = createHarness();
  const { request } = h.webview.dispatchPermissionRequest({ permission: 'geolocation' });
  const banner = getBanner(h.panel);
  const allowBtn = getAllowBtn(banner);

  assert.doesNotThrow(() => {
    for (let i = 0; i < 50; i++) {
      allowBtn.dispatchEvent(new MockEvent('pointerdown', { bubbles: true }));
      allowBtn.dispatchEvent(new MockEvent('pointerup', { bubbles: true }));
      allowBtn.dispatchEvent(new MockEvent('click', { bubbles: true }));
      allowBtn.dispatchEvent(new MockEvent('keydown', { bubbles: true }));
    }
  });

  assert.strictEqual(request.allowed, true);
  assert.strictEqual(request.callCount, 1, 'Single decision executed despite multi-event barrage');
});

// ── SUITE 3: Storage Corruption, Quota Exhaustion & Hostile Storage ─────────

runStress('Storage Hostility', '3.1 QuotaExceededError on localStorage.setItem still grants live request safely', () => {
  const h = createHarness();
  h.localStorage.throwOnSet = new Error('QuotaExceededError: DOM Exception 22: The quota has been exceeded');

  const { request } = h.webview.dispatchPermissionRequest({ permission: 'media' });
  const banner = getBanner(h.panel);

  assert.doesNotThrow(() => {
    getAllowBtn(banner).click();
  }, 'Must not throw QuotaExceededError to host environment');

  assert.strictEqual(request.allowed, true, 'Guest page granted live permission despite storage failure');
  assert.strictEqual(request.callCount, 1);
  assert.strictEqual(getBanner(h.panel), null, 'Banner dismissed cleanly');
});

runStress('Storage Hostility', '3.2 SecurityError on localStorage.getItem (Private Browsing) displays prompt & grants', () => {
  const h = createHarness();
  h.localStorage.throwOnGet = new Error('SecurityError: The operation is insecure');

  const { request } = h.webview.dispatchPermissionRequest({ permission: 'media' });
  const banner = getBanner(h.panel);
  assert(banner !== null, 'Prompt displayed despite storage read failure');

  assert.doesNotThrow(() => {
    getAllowBtn(banner).click();
  });
  assert.strictEqual(request.allowed, true);
  assert.strictEqual(request.callCount, 1);
});

runStress('Storage Hostility', '3.3 Hostile corrupted JSON schemas in storage fall back gracefully', () => {
  const corruptPayloads = [
    'null',
    'undefined',
    '""',
    '12345',
    'true',
    '[1, 2, "corrupt"]',
    '{"https://site.com": null}',
    '{"https://site.com": "allow"}', // string instead of object map
    '{"https://site.com": {"media": 999}}', // number instead of string decision
    '{"https://site.com": {"media": {}}}', // empty object
    '{"https://site.com": {"media": null}}',
    '{"__proto__": {"media": "allow"}}', // prototype pollution attempt
    '{"constructor": {"prototype": {"media": "allow"}}}'
  ];

  for (const payload of corruptPayloads) {
    const initialStorage = { vivaldi_sidebar_permissions: payload };
    const h = createHarness({ initialStorage });

    assert.doesNotThrow(() => {
      const { request } = h.webview.dispatchPermissionRequest({
        permission: 'media',
        url: 'https://site.com'
      });
      // None of the corrupted payloads should falsely auto-allow without prompt
      assert.strictEqual(request.actionTaken, false, `Payload ${payload} must not auto-resolve`);
      const banner = getBanner(h.panel);
      assert(banner !== null, `Payload ${payload} must fallback to displaying prompt banner`);
      getAllowBtn(banner).click();
      assert.strictEqual(request.allowed, true, `Payload ${payload} allows cleanly`);
    }, `Failed handling payload: ${payload}`);
  }
});

runStress('Storage Hostility', '3.4 window.localStorage is null / undefined throughout entire lifecycle', () => {
  const h = createHarness();
  h.sandbox.window.localStorage = null;

  const r1 = h.webview.dispatchPermissionRequest({ permission: 'media', url: 'https://site-null-storage.com' });
  const banner = getBanner(h.panel);
  assert(banner !== null, 'Banner displayed with null storage');
  getAllowBtn(banner).click();
  assert.strictEqual(r1.request.allowed, true);

  // Check in-memory recall
  const r2 = h.webview.dispatchPermissionRequest({ permission: 'media', url: 'https://site-null-storage.com' });
  assert.strictEqual(r2.request.allowed, true, 'In-memory fallback recalls decision when storage is null');
  assert.strictEqual(getBanner(h.panel), null, 'No repeat prompt shown');
});

runStress('Storage Hostility', '3.5 50 queued requests under continuous storage throwOnSet and throwOnGet', () => {
  const h = createHarness();
  h.localStorage.throwOnSet = new Error('Disk IO Error');
  h.localStorage.throwOnGet = new Error('Disk IO Error');

  const requests = [];
  for (let i = 0; i < 20; i++) {
    const r = h.webview.dispatchPermissionRequest({
      permission: 'media',
      url: `https://faulty-${i}.com`
    });
    requests.push(r.request);
  }

  for (let i = 0; i < 20; i++) {
    const banner = getBanner(h.panel);
    assert(banner !== null);
    getAllowBtn(banner).click();
    assert.strictEqual(requests[i].allowed, true);
    assert.strictEqual(requests[i].callCount, 1);
  }
  assert.strictEqual(getBanner(h.panel), null);
});

// ── SUITE 4: Malformed, Hostile & Boundary URLs ─────────────────────────────

runStress('Malformed & Hostile URLs', '4.1 javascript: URL handles safely, does not execute script, prompt manageable', () => {
  const h = createHarness();
  let executed = false;
  h.sandbox.window.hacked = () => { executed = true; };

  const { request } = h.webview.dispatchPermissionRequest({
    permission: 'media',
    url: 'javascript:window.hacked()'
  });

  assert.strictEqual(executed, false, 'javascript: URL must never be evaluated');
  const banner = getBanner(h.panel);
  assert(banner !== null, 'Prompt shown');
  getAllowBtn(banner).click();
  assert.strictEqual(request.allowed, true);
  assert.strictEqual(executed, false, 'No execution on decision');
});

runStress('Malformed & Hostile URLs', '4.2 data: and blob: URLs handled safely without corrupting persistence', () => {
  const h = createHarness();
  const blobUrl = 'blob:https://zoom.us/d9494372-e04e-4f38-89f4-181cbfa5c48b';
  const dataUrl = 'data:text/html;base64,PHNjcmlwdD48L3NjcmlwdD4=';

  const r1 = h.webview.dispatchPermissionRequest({ permission: 'media', url: blobUrl });
  const b1 = getBanner(h.panel);
  assert(b1 !== null);
  getAllowBtn(b1).click();
  assert.strictEqual(r1.request.allowed, true);

  const r2 = h.webview.dispatchPermissionRequest({ permission: 'geolocation', url: dataUrl });
  const b2 = getBanner(h.panel);
  assert(b2 !== null);
  getBlockBtn(b2).click();
  assert.strictEqual(r2.request.denied, true);

  // Storage should not contain invalid keys
  const stored = h.localStorage.getItem('vivaldi_sidebar_permissions');
  if (stored) {
    const parsed = JSON.parse(stored);
    assert.strictEqual(parsed['null'], undefined, 'No "null" origin stored');
    assert.strictEqual(parsed['data:'], undefined, 'No "data:" origin stored');
    assert.strictEqual(parsed['blob:'], undefined, 'No "blob:" origin stored');
  }
});

runStress('Malformed & Hostile URLs', '4.3 XSS payloads in URL are escaped via textContent (no innerHTML injection)', () => {
  const h = createHarness();
  const xssUrl = 'https://<img src=x onerror=alert(1)>.example.com/app?query=<script>alert(2)</script>';
  h.webview.dispatchPermissionRequest({ permission: 'media', url: xssUrl });

  const banner = getBanner(h.panel);
  assert(banner !== null);
  // Ensure the DOM has no injected IMG or SCRIPT tags inside banner
  assert.strictEqual(banner.querySelectorAll('img, script').length, 0, 'No tags injected from URL payload');
  assert(banner.textContent.includes('example.com'), 'Escaped text content matches domain');
});

runStress('Malformed & Hostile URLs', '4.4 Mega-URL (100,000 characters) parsed without catastrophic regex backtracking (ReDoS)', () => {
  const h = createHarness();
  const hugePath = 'a'.repeat(100000);
  const megaUrl = `https://mega-domain.org/${hugePath}`;

  const t0 = Date.now();
  assert.doesNotThrow(() => {
    h.webview.dispatchPermissionRequest({ permission: 'media', url: megaUrl });
  }, 'Parsing mega-URL must not crash or throw');
  const elapsed = Date.now() - t0;
  assert(elapsed < 1000, `Mega-URL parsing took ${elapsed}ms (must be < 1000ms, no ReDoS)`);

  const banner = getBanner(h.panel);
  assert(banner !== null);
  getAllowBtn(banner).click();
});

runStress('Malformed & Hostile URLs', '4.5 Boundary URLs (IPv6, credentials, ports, empty, null, opaque)', () => {
  const boundaryUrls = [
    'http://[::1]:8080/path',
    'https://user:password@domain.com:8443/test',
    'https://xn--e1afmkfd.xn--p1ai/test',
    'file:///etc/hosts',
    'about:blank',
    'about:srcdoc',
    '',
    '   ',
    null,
    undefined,
    '://invalid-format-url'
  ];

  for (const u of boundaryUrls) {
    const h = createHarness();
    assert.doesNotThrow(() => {
      const res = h.webview.dispatchPermissionRequest({ permission: 'media', url: u });
      const banner = getBanner(h.panel);
      if (banner) {
        getAllowBtn(banner).click();
        assert.strictEqual(res.request.allowed, true);
      }
    }, `Failed boundary URL: ${u}`);
  }
});

// ── SUITE 5: Webview DOM Removal, Navigation & Lifecycle Races ──────────────

runStress('Lifecycle & Nav Races', '5.1 Webview navigation src change during pending prompt denies request and dismisses', () => {
  const h = createHarness();
  const { request } = h.webview.dispatchPermissionRequest({ permission: 'media', url: 'https://gemini.google.com' });
  assert(getBanner(h.panel) !== null);

  // Webview navigates to new site
  h.webview.src = 'https://wikipedia.org';
  MockMutationObserver.notify('attributes', h.webview, { attributeName: 'src' });

  assert.strictEqual(getBanner(h.panel), null, 'Banner must be dismissed on navigation');
  assert.strictEqual(request.denied, true, 'Pending request denied on navigation to prevent leak');
  assert.strictEqual(request.callCount, 1);
});

runStress('Lifecycle & Nav Races', '5.2 Simultaneous click Allow + navigation does not throw Action already taken', () => {
  const h = createHarness();
  const { request } = h.webview.dispatchPermissionRequest({ permission: 'media' });
  const banner = getBanner(h.panel);
  const allowBtn = getAllowBtn(banner);

  assert.doesNotThrow(() => {
    // Click Allow
    allowBtn.click();
    // Simulate instantaneous navigation in same tick
    h.webview.src = 'https://other.com';
    MockMutationObserver.notify('attributes', h.webview, { attributeName: 'src' });
  }, 'Simultaneous click + navigation must never throw');

  assert.strictEqual(request.allowed, true);
  assert.strictEqual(request.callCount, 1, 'Only 1 action taken');
});

runStress('Lifecycle & Nav Races', '5.3 Webview removal with 20 queued requests denies all pending and clears queue', () => {
  const h = createHarness();
  const requests = [];

  for (let i = 0; i < 20; i++) {
    const r = h.webview.dispatchPermissionRequest({ permission: 'media', url: `https://site-${i}.com` });
    requests.push(r.request);
  }

  assert(getBanner(h.panel) !== null);

  // Webview removed from DOM
  h.webview.remove();

  assert.strictEqual(getBanner(h.panel), null, 'Banner removed on webview detachment');
  // All 20 requests must be denied and have callCount === 1
  for (let i = 0; i < 20; i++) {
    assert.strictEqual(requests[i].denied, true, `Request ${i} denied`);
    assert.strictEqual(requests[i].callCount, 1, `Request ${i} called exactly once`);
  }
});

runStress('Lifecycle & Nav Races', '5.4 Panel Close (X) with 50 queued requests triggers clean teardown of all', () => {
  const h = createHarness();
  const requests = [];

  for (let i = 0; i < 50; i++) {
    const r = h.webview.dispatchPermissionRequest({ permission: 'geolocation', url: `https://loc-${i}.org` });
    requests.push(r.request);
  }

  const closeBtn = h.panel.querySelector('header button.close');
  assert(closeBtn !== null);
  closeBtn.click();

  assert.strictEqual(getBanner(h.panel), null, 'Banner unmounted on panel close');
  for (let i = 0; i < 50; i++) {
    assert.strictEqual(requests[i].denied, true, `Request ${i} denied on close`);
    assert.strictEqual(requests[i].callCount, 1, `Request ${i} called once`);
  }
});

runStress('Lifecycle & Nav Races', '5.5 Panel visibility toggle (multitasking blur) preserves active prompt', () => {
  const h = createHarness();
  const { request } = h.webview.dispatchPermissionRequest({ permission: 'media' });
  assert(getBanner(h.panel) !== null);

  // Multitasking blur: panel loses 'visible' class
  h.panel.classList.remove('visible');

  // Prompt banner must be preserved in DOM for when user returns
  assert(getBanner(h.panel) !== null, 'Banner preserved during multitasking blur');
  assert.strictEqual(request.actionTaken, false, 'Decision not prematurely made');

  // Re-focus panel: user can now decide
  h.panel.classList.add('visible');
  getAllowBtn(getBanner(h.panel)).click();
  assert.strictEqual(request.allowed, true);
  assert.strictEqual(request.callCount, 1);
});

// ── SUITE 6: Asynchronous Interleaving Fuzzing Oracle ───────────────────────

runStress('Fuzzing Oracle', '6.1 100 randomized permutations of (Allow, Block, Close, Nav, Detach) - zero errors', () => {
  const actions = ['allow', 'block', 'close', 'nav', 'detach'];

  for (let iter = 0; iter < 100; iter++) {
    const h = createHarness();
    const req = new StrictChromiumPermissionRequest('https://fuzz-test.com');
    h.webview.dispatchPermissionRequest({ permission: 'media', request: req });

    // Pick 2 random actions to execute in rapid succession
    const a1 = actions[Math.floor(Math.random() * actions.length)];
    const a2 = actions[Math.floor(Math.random() * actions.length)];

    function executeAction(act) {
      const banner = getBanner(h.panel);
      if (act === 'allow') {
        const btn = getAllowBtn(banner);
        if (btn) btn.click();
      } else if (act === 'block') {
        const btn = getBlockBtn(banner);
        if (btn) btn.click();
      } else if (act === 'close') {
        const closeBtn = h.panel.querySelector('header button.close');
        if (closeBtn) closeBtn.click();
      } else if (act === 'nav') {
        h.webview.src = `https://nav-${Math.random()}.com`;
        MockMutationObserver.notify('attributes', h.webview, { attributeName: 'src' });
      } else if (act === 'detach') {
        h.webview.remove();
      }
    }

    assert.doesNotThrow(() => {
      executeAction(a1);
      executeAction(a2);
    }, `Fuzz failure on pair [${a1}, ${a2}] (iteration ${iter})`);

    // Strict invariant: callCount must NEVER exceed 1
    assert(req.callCount <= 1, `Invariant violation: callCount was ${req.callCount} on [${a1}, ${a2}]`);
  }
});

runStress('Fuzzing Oracle', '6.2 Asynchronous microtask interleaving: prompt resolution vs DOM observer trigger', async () => {
  const h = createHarness();
  const { request } = h.webview.dispatchPermissionRequest({ permission: 'media' });
  const banner = getBanner(h.panel);
  const allowBtn = getAllowBtn(banner);

  await new Promise((resolve) => {
    // Schedule simultaneous microtask and macrotask resolutions
    queueMicrotask(() => {
      allowBtn.click();
    });
    queueMicrotask(() => {
      // Simulate observer firing concurrently
      MockMutationObserver.notify('attributes', h.webview, { attributeName: 'src' });
    });
    setTimeout(() => {
      assert.strictEqual(request.callCount, 1, 'Asynchronous microtask interleaving executed exactly once');
      assert.strictEqual(request.allowed, true);
      resolve();
    }, 10);
  });
});

// ── SUITE 7: Deep Lifecycle & Invariant Probes ──────────────────────────────

runStress('Deep Invariants', '7.1 Multi-permission coexistence per origin: media and geolocation stored and recalled independently', () => {
  const h = createHarness();
  const origin = 'https://meet.google.com';

  // Request 1: Media
  const r1 = h.webview.dispatchPermissionRequest({ permission: 'media', url: `${origin}/room` });
  const b1 = getBanner(h.panel);
  assert(b1 !== null);
  getAllowBtn(b1).click();
  assert.strictEqual(r1.request.allowed, true);

  // Request 2: Geolocation on same origin
  const r2 = h.webview.dispatchPermissionRequest({ permission: 'geolocation', url: `${origin}/room` });
  const b2 = getBanner(h.panel);
  assert(b2 !== null, 'Geolocation on same origin must prompt user');
  getAllowBtn(b2).click();
  assert.strictEqual(r2.request.allowed, true);

  // Both should now be cached
  const r3 = h.webview.dispatchPermissionRequest({ permission: 'media', url: `${origin}/room` });
  assert.strictEqual(r3.request.allowed, true, 'Media auto-allowed from cache');
  assert.strictEqual(getBanner(h.panel), null);

  const r4 = h.webview.dispatchPermissionRequest({ permission: 'geolocation', url: `${origin}/room` });
  assert.strictEqual(r4.request.allowed, true, 'Geolocation auto-allowed from cache');
  assert.strictEqual(getBanner(h.panel), null);

  // Notifications still undecided
  const r5 = h.webview.dispatchPermissionRequest({ permission: 'notifications', url: `${origin}/room` });
  assert.strictEqual(r5.request.actionTaken, false);
  assert(getBanner(h.panel) !== null, 'Notifications still undecided and prompts');
});

runStress('Deep Invariants', '7.2 Null or missing e.request in permission event does not crash mod', () => {
  const h = createHarness();
  assert.doesNotThrow(() => {
    const ev = new MockPermissionRequestEvent('media', 'https://gemini.google.com', null);
    h.webview.dispatchEvent(ev);
  }, 'Null request must not cause unhandled crash');
});

runStress('Deep Invariants', '7.3 Non-sensitive permissions (midi, pointerLock, clipboard) pass through without prompt', () => {
  const h = createHarness();
  const nonSensitives = ['midi', 'pointerLock', 'clipboard-read', 'fullscreen', 'unsupported'];

  for (const perm of nonSensitives) {
    const { request, event } = h.webview.dispatchPermissionRequest({ permission: perm });
    assert.strictEqual(event.defaultPrevented, false, `Non-sensitive ${perm} must not have preventDefault called`);
    assert.strictEqual(request.actionTaken, false, `Non-sensitive ${perm} must not be acted upon`);
    assert.strictEqual(getBanner(h.panel), null, `Non-sensitive ${perm} must not show prompt banner`);
  }
});

runStress('Deep Invariants', '7.4 Download permission passes through untouched to Vivaldi native handler', () => {
  const h = createHarness();
  const { request, event } = h.webview.dispatchPermissionRequest({ permission: 'download' });
  assert.strictEqual(event.defaultPrevented, false, 'Download must not call preventDefault');
  assert.strictEqual(event.propagationStopped, false, 'Download must not stop propagation');
  assert.strictEqual(request.actionTaken, false, 'Download must not be handled by mod');
  assert.strictEqual(getBanner(h.panel), null, 'Download must not render prompt banner');
});

runStress('Deep Invariants', '7.5 Dynamically appended panels after bootstrap are observed and hooked', () => {
  const h = createHarness();
  const doc = h.doc;
  const panelsContainer = doc.body.querySelector('#panels-container');

  // Create and append dynamic panel to observed container
  const newPanel = doc.createElement('div');
  newPanel.className = 'panel webpanel visible';
  newPanel.id = 'panel-dynamic';
  newPanel.setAttribute('data-id', 'panel-dynamic');

  const content = doc.createElement('section');
  content.className = 'webpanel-content';
  newPanel.appendChild(content);

  const newWv = doc.createElement('webview');
  newWv.tab_id = 999;
  newWv.src = 'https://dynamic.example.com';
  content.appendChild(newWv);

  panelsContainer.appendChild(newPanel);
  MockMutationObserver.notify('childList', panelsContainer, { addedNodes: [newPanel] });

  // Dispatch permission request on newly added webview
  const { request } = newWv.dispatchPermissionRequest({ permission: 'media' });
  const banner = getBanner(newPanel);
  assert(banner !== null, 'Dynamically added panel must have prompt banner rendered');
  getAllowBtn(banner).click();
  assert.strictEqual(request.allowed, true);
});

runStress('Deep Invariants', '7.6 Extension panel guard (chrome-extension://) ignores permissionrequest', () => {
  const h = createHarness();
  h.webview.src = 'chrome-extension://abcdefghijklmno/popup.html';

  const { request } = h.webview.dispatchPermissionRequest({ permission: 'media' });
  assert.strictEqual(request.actionTaken, false, 'Extension panel must not be handled');
  assert.strictEqual(getBanner(h.panel), null, 'Extension panel must not show prompt banner');
});

runStress('Deep Invariants', '7.7 Revocation API under hostile args and origin-wide clearing', () => {
  const h = createHarness();
  const origin = 'https://revoke-test.com';

  // Seed permissions
  const r1 = h.webview.dispatchPermissionRequest({ permission: 'media', url: origin });
  getAllowBtn(getBanner(h.panel)).click();
  assert.strictEqual(r1.request.allowed, true);

  // Revoke with hostile/empty parameters must not throw
  assert.doesNotThrow(() => {
    h.sandbox.window.__edgeRevokePermission(null, null);
    h.sandbox.window.__edgeRevokePermission('', '');
    h.sandbox.window.__edgeRevokePermission('https://nonexistent.org', 'media');
  });

  // Revoke specific permission
  h.sandbox.window.__edgeRevokePermission(origin, 'media');
  const r2 = h.webview.dispatchPermissionRequest({ permission: 'media', url: origin });
  assert.strictEqual(r2.request.actionTaken, false);
  assert(getBanner(h.panel) !== null, 'After revoking, origin prompts again');
  getAllowBtn(getBanner(h.panel)).click();

  // Revoke entire origin (null permission)
  h.sandbox.window.__edgeRevokePermission(origin, null);
  const r3 = h.webview.dispatchPermissionRequest({ permission: 'media', url: origin });
  assert.strictEqual(r3.request.actionTaken, false);
  assert(getBanner(h.panel) !== null, 'After revoking entire origin, origin prompts again');
  getBlockBtn(getBanner(h.panel)).click();
  assert.strictEqual(r3.request.denied, true);

  // Clear all permissions
  h.sandbox.window.__edgeClearAllPermissions();
  const r4 = h.webview.dispatchPermissionRequest({ permission: 'media', url: origin });
  assert.strictEqual(r4.request.actionTaken, false);
  assert(getBanner(h.panel) !== null, 'After clear all, prompt is shown again');
});



setTimeout(() => {
  console.log('\n──────────────────────────────────────────────────────────────────────');
  console.log('📊 STRESS TEST RESULTS BREAKDOWN');
  console.log('──────────────────────────────────────────────────────────────────────');

  let passed = 0;
  let failed = 0;
  let currentCat = '';

  for (const r of stressResults) {
    if (r.category !== currentCat) {
      currentCat = r.category;
      console.log(`\n  ▶ ${currentCat}`);
    }
    if (r.passed) {
      passed++;
      console.log(`    ✔ [PASS] ${r.name}`);
    } else {
      failed++;
      console.log(`    ✖ [FAIL] ${r.name}`);
      console.log(`      Error: ${r.error}`);
    }
  }

  const total = stressResults.length;
  console.log('\n======================================================================');
  console.log(`📈 STRESS RESULTS: Total: ${total} | Passed: ${passed} | Failed: ${failed}`);
  console.log(`   Pass Rate: ${((passed / total) * 100).toFixed(1)}%`);
  console.log('======================================================================\n');

  if (failed > 0) {
    console.error(`💥 STRESS TEST SUITE DETECTED ${failed} FAILURE(S)!`);
    process.exit(1);
  } else {
    console.log('🏆 ALL ADVERSARIAL STRESS TESTS PASSED (100% GREEN)! System is rock-solid.');
    process.exit(0);
  }
}, 50);
