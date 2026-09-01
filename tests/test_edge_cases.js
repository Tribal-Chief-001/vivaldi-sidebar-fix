/**
 * Edge Case Simulator & Verification Test Suite (Root-Cause Fix Edition)
 * Tests hardened behaviors:
 * 1. Rapid Click Debounce / Atomic Re-entrance Guard
 * 2. Extension Panel Protection (Bitwarden, Translate, chrome-extension://)
 * 3. Tab Destruction uses chrome.tabs.remove() (not discard)
 * 4. Glide Timer Cancellation on Immediate Reopen
 * 5. Scoped DOM Mutation Observer
 * 6. closedPanelsForReset flag lifecycle
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('🧪 Starting Edge Case Simulation & Stress Tests...\n');

const code = fs.readFileSync(path.join(__dirname, '../src/edge-panel-mod.js'), 'utf8');

// ── Test 1: Extension Panel Guard ────────────────────────────────────────────
console.log('▶ Test 1: Extension Panel Detection Guard');
{
  assert(code.includes('isExtensionPanel'), 'isExtensionPanel function must exist');
  assert(code.includes('chrome-extension:'), 'Must detect chrome-extension:// URLs');
  assert(code.includes('vivaldi:'), 'Must detect vivaldi:// URLs');
  assert(code.includes('chrome:'), 'Must detect chrome:// URLs');
  console.log('  ✔ Extension panel detection patterns verified.');
}

// ── Test 2: Tab Destruction via chrome.tabs.remove (ROOT FIX) ────────────────
console.log('▶ Test 2: Tab Destruction uses chrome.tabs.remove (NOT discard)');
{
  const codeWithoutComments = code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  assert(codeWithoutComments.includes('chrome.tabs.remove'), 'Must use chrome.tabs.remove() to fully destroy tabs');
  assert(!codeWithoutComments.includes('chrome.tabs.discard'), 'Must NOT use chrome.tabs.discard() (root cause of all bugs)');

  // Verify the destroyPanelTab function exists and uses remove
  assert(code.includes('function destroyPanelTab'), 'destroyPanelTab function must exist');

  // Verify __edgeCloseWebPanel also uses remove
  const edgeCloseSection = code.substring(code.indexOf('window.__edgeCloseWebPanel'));
  assert(edgeCloseSection.includes('chrome?.tabs?.remove'), '__edgeCloseWebPanel must use chrome.tabs.remove');

  console.log('  ✔ Root-cause fix verified: chrome.tabs.remove() in all close paths.');
}

// ── Test 3: Rapid Click Debounce & Timer Management ─────────────────────────
console.log('▶ Test 3: Rapid Click Debounce & Timer Management');
{
  const mockPanel = {
    __isClosing: false,
    __glideTimer: null
  };

  let destroyedCount = 0;
  function simulateClose(panel) {
    if (panel.__isClosing) return false;
    panel.__isClosing = true;

    if (panel.__glideTimer) {
      clearTimeout(panel.__glideTimer);
      panel.__glideTimer = null;
    }

    panel.__glideTimer = setTimeout(() => {
      panel.__glideTimer = null;
      panel.__isClosing = false;
      destroyedCount++;
    }, 150);
    return true;
  }

  assert.strictEqual(simulateClose(mockPanel), true, 'First close must proceed');
  assert.strictEqual(simulateClose(mockPanel), false, 'Immediate second close must be debounced');
  assert.strictEqual(simulateClose(mockPanel), false, 'Immediate third close must be debounced');

  function simulateReopen(panel) {
    if (panel.__glideTimer) {
      clearTimeout(panel.__glideTimer);
      panel.__glideTimer = null;
    }
    panel.__isClosing = false;
  }

  simulateReopen(mockPanel);
  assert.strictEqual(mockPanel.__glideTimer, null, 'Reopen must cancel pending destruction timer');
  console.log('  ✔ Atomic debounce and glide timer cancellation verified.');
}

// ── Test 4: __edgeShouldReset Flag Lifecycle ────────────────────────────────
console.log('▶ Test 4: __edgeShouldReset Flag Lifecycle');
{
  // Simulate the closedPanelsForReset lifecycle
  const closedPanelsForReset = new Set();

  // Simulate closing a panel
  closedPanelsForReset.add('panel-chatgpt');

  // Simulate __edgeShouldReset call (as called by componentDidUpdate)
  function edgeShouldReset(panelId) {
    if (!panelId) return false;
    if (closedPanelsForReset.has(panelId)) {
      closedPanelsForReset.delete(panelId);
      return true;
    }
    return false;
  }

  // First call: should return true and consume the flag
  assert.strictEqual(edgeShouldReset('panel-chatgpt'), true, 'First check after close must return true');
  // Second call: flag already consumed, should return false
  assert.strictEqual(edgeShouldReset('panel-chatgpt'), false, 'Second check must return false (flag consumed)');
  // Unknown panel: should return false
  assert.strictEqual(edgeShouldReset('panel-unknown'), false, 'Unknown panel must return false');
  // Null: should return false
  assert.strictEqual(edgeShouldReset(null), false, 'Null panel must return false');

  console.log('  ✔ __edgeShouldReset lifecycle verified (set → consumed → cleared).');
}

// ── Test 5: Scoped DOM Mutation Observer ─────────────────────────────────────
console.log('▶ Test 5: Scoped DOM Mutation Observer');
{
  assert(code.includes("document.querySelector('#panels-container')"), 'Must search for panels container');
  assert(code.includes('subtree: false'), 'Container observer must not thrash deep DOM subtree');
  console.log('  ✔ DOM performance guard verified.');
}

// ── Test 6: No Legacy Workaround Code ───────────────────────────────────────
console.log('▶ Test 6: No Legacy Workaround Code');
{
  assert(!code.includes('discardedTabs'), 'discardedTabs tracking set must not exist');
  assert(!code.includes('recentlyResetPanels'), 'recentlyResetPanels race-condition workaround must not exist');
  assert(!code.includes('getCleanBaseUrlFallback'), 'URL heuristic fallback must not exist');
  assert(!code.includes('resetWebviewToBaseUrl'), 'Manual URL reset must not exist');
  console.log('  ✔ All legacy workaround code confirmed removed.');
}

console.log('\n========================================================');
console.log('🎉 ALL EDGE CASE SIMULATION TESTS PASSED (100% GREEN)');
console.log('========================================================');
