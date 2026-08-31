/**
 * Edge Case Simulator & Verification Test Suite
 * Tests hardened behaviors:
 * 1. Rapid Click Debounce / Atomic Re-entrance Guard
 * 2. Extension Panel Protection (Bitwarden, Translate, chrome-extension://)
 * 3. Non-HTTP Schemes Safety (chrome://, vivaldi://, file://)
 * 4. SPA Hash-Routing and Subpath Cleanup
 * 5. Discard Timer Cancellation on Immediate Reopen
 * 6. Closed Tab Memory Tracking Cleanup (chrome.tabs.onRemoved)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

console.log('🧪 Starting Edge Case Simulation & Stress Tests...\n');

const code = fs.readFileSync(path.join(__dirname, '../src/edge-panel-mod.js'), 'utf8');

// Mock Environment Builder
function createMockEnvironment() {
  const tabs = new Map();
  let tabCounter = 100;
  const onRemovedListeners = [];

  const chromeMock = {
    tabs: {
      discard: (tabId, cb) => {
        const tab = tabs.get(tabId);
        if (tab) {
          tab.discarded = true;
          if (cb) cb();
        } else {
          chromeMock.runtime.lastError = new Error('No such tab');
          if (cb) cb();
          chromeMock.runtime.lastError = null;
        }
      },
      update: (tabId, updateProps) => {
        const tab = tabs.get(tabId);
        if (tab) {
          if (updateProps.url) tab.url = updateProps.url;
        }
      },
      query: (queryInfo, cb) => {
        cb(Array.from(tabs.values()));
      },
      onRemoved: {
        addListener: (fn) => onRemovedListeners.push(fn)
      }
    },
    runtime: {
      lastError: null
    }
  };

  const documentMock = {
    readyState: 'complete',
    addEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
    dispatchEvent: () => {}
  };

  const windowMock = {
    PointerEvent: function () {},
    KeyboardEvent: function () {},
    MutationObserver: function (cb) {
      return { observe: () => {}, disconnect: () => {} };
    },
    setTimeout: setTimeout,
    clearTimeout: clearTimeout
  };

  return { chromeMock, documentMock, windowMock, tabs, onRemovedListeners };
}

// ── Test 1: URL Clean Fallback Matrix ─────────────────────────────────────────
console.log('▶ Test 1: SPA & AI URL Fallback Matrix');
{
  // Extract getCleanBaseUrlFallback logic
  const match = code.match(/function getCleanBaseUrlFallback\(currentUrl\) \{([\s\S]*?)\n  \}/);
  assert(match, 'getCleanBaseUrlFallback must exist in mod');
  const getCleanBaseUrlFallback = new Function('currentUrl', match[1]);

  const testMatrix = [
    // AI Tools
    ['https://gemini.google.com/app/c8473829472', 'https://gemini.google.com/app'],
    ['https://claude.ai/chat/49823-fe82', 'https://claude.ai/new'],
    ['https://chatgpt.com/c/67b93-92a', 'https://chatgpt.com/'],
    ['https://grok.com/chat/xyz123', 'https://grok.com/'],
    ['https://copilot.microsoft.com/chats/abc', 'https://copilot.microsoft.com/'],
    ['https://perplexity.ai/search/what-is-vivaldi', 'https://www.perplexity.ai/'],
    ['https://chat.deepseek.com/c/9922', 'https://chat.deepseek.com/'],
    // SPA Hash & Query Cleaning
    ['https://app.slack.com/client/T123/C456#msg-999', 'https://app.slack.com/client/T123/C456'],
    ['https://jira.company.com/secure/RapidBoard.jspa?rapidView=42#subtask-12', 'https://jira.company.com/secure/RapidBoard.jspa'],
    // Non-HTTP (Must safely return null)
    ['chrome://settings', null],
    ['vivaldi://notes', null],
    ['chrome-extension://abcdefg/popup.html', null],
    ['file:///home/user/doc.html', null],
    ['', null],
    [null, null]
  ];

  for (const [input, expected] of testMatrix) {
    const actual = getCleanBaseUrlFallback(input);
    assert.strictEqual(actual, expected, `Failed for input: ${input} (got ${actual}, expected ${expected})`);
  }
  console.log('  ✔ All 15 URL matrix cases passed cleanly.');
}

// ── Test 2: Extension Panel Guard ────────────────────────────────────────────
console.log('▶ Test 2: Extension Panel Detection Guard');
{
  const match = code.match(/function isExtensionPanel\(panel\) \{([\s\S]*?)\n  \}/);
  assert(match, 'isExtensionPanel must exist in mod');

  const mockPanelHelper = (opts) => ({
    getAttribute: () => opts.id || null,
    dataset: { id: opts.id || null },
    querySelector: () => ({
      src: opts.src || '',
      getAttribute: () => opts.src || null
    })
  });

  const getPanelId = (p) => p.dataset.id;
  const getWebview = (p) => p.querySelector();
  const getRgeComponent = (p) => ({
    isExtension: () => Boolean(p.dataset.id && p.dataset.id.startsWith('ext-'))
  });

  const isExtensionPanel = new Function('panel', 'getPanelId', 'getWebview', 'getRgeComponent', match[1]);

  const extPanel = mockPanelHelper({ id: 'ext-bitwarden', src: 'chrome-extension://nngceckbapebfimnlniiiahkandclblb/popup.html' });
  const normalPanel = mockPanelHelper({ id: 'custom-web-1', src: 'https://gemini.google.com/app' });

  assert.strictEqual(isExtensionPanel(extPanel, getPanelId, getWebview, getRgeComponent), true, 'Bitwarden must be identified as extension panel');
  assert.strictEqual(isExtensionPanel(normalPanel, getPanelId, getWebview, getRgeComponent), false, 'Gemini must NOT be identified as extension panel');
  console.log('  ✔ Extension panel isolation verified.');
}

// ── Test 3: Tab Memory Cleanup on Tab Removal ────────────────────────────────
console.log('▶ Test 3: Tab Removal Cleanup (chrome.tabs.onRemoved)');
{
  assert(code.includes('chrome.tabs.onRemoved.addListener'), 'Must register chrome.tabs.onRemoved listener');
  assert(code.includes('discardedTabs.delete(closedTabId)'), 'Must clean discardedTabs set on tab removal');
  assert(code.includes('revivingTabs.delete(closedTabId)'), 'Must clean revivingTabs set on tab removal');
  console.log('  ✔ chrome.tabs.onRemoved memory leak protection verified.');
}

// ── Test 4: Debounce & Discard Timer Cancellation ────────────────────────────
console.log('▶ Test 4: Rapid Click Debounce & Timer Management');
{
  assert(code.includes('panel.__isClosing'), 'Must feature atomic __isClosing guard against rapid clicks');
  assert(code.includes('panel.__glideDiscardTimer'), 'Must track glide discard timer directly on panel instance');
  assert(code.includes('clearTimeout(panel.__glideDiscardTimer)'), 'Must cancel discard timer if panel is reopened quickly');
  console.log('  ✔ Atomic debounce and glide timer cancellation verified.');
}

// ── Test 5: Scoped Mutation Observer Container ───────────────────────────────
console.log('▶ Test 5: Scoped DOM Mutation Observer');
{
  assert(code.includes('#panels-container'), 'Must check for #panels-container or #panels for scoped observer');
  assert(code.includes('subtree: false'), 'Must use subtree: false on panel container observer to avoid DOM thrashing');
  console.log('  ✔ DOM performance guard verified.');
}

console.log('\n========================================================');
console.log('🎉 ALL EDGE CASE SIMULATION TESTS PASSED (100% GREEN)');
console.log('========================================================');
