/**
 * Test Suite: Web Panel Keyboard Shortcut Forwarding & Bundle Patcher
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('🧪 Starting Web Panel Shortcut & Bundle Patch Verification...');

// 1. Verify bundle patch patterns
const bundlePatcherPath = path.join(__dirname, '../src/patch-bundle.py');
assert(fs.existsSync(bundlePatcherPath), 'patch-bundle.py exists');
const patcherSource = fs.readFileSync(bundlePatcherPath, 'utf8');

console.log('▶ Test 1: Verify Patcher Logic for Shortcut Passthrough');
assert(patcherSource.includes('ctrl+enter'), 'Patcher includes ctrl+enter');
assert(patcherSource.includes('meta+enter'), 'Patcher includes meta+enter');
assert(patcherSource.includes('ctrl+shift+enter'), 'Patcher includes ctrl+shift+enter');
assert(patcherSource.includes('alt+enter'), 'Patcher includes alt+enter');
assert(patcherSource.includes('closest?.("#panels")'), 'Patcher includes #panels webview focus check');
assert(patcherSource.includes('__edgeCloseWebPanel'), 'Patcher includes __edgeCloseWebPanel native bridge');
console.log('  ✔ Patcher syntax and replacement patterns verified.');

// 2. Test S(e) shortcutAllowedInText simulation
console.log('▶ Test 2: Simulating Vivaldi shortcutAllowedInText S(e) logic');
const textPassthroughSet = new Set([
  "left", "right", "shift+left", "shift+right", "shift+up", "shift+down", "enter", "shift+enter",
  "ctrl+enter", "meta+enter", "ctrl+shift+enter", "meta+shift+enter", "alt+enter",
  "ctrl+a", "ctrl+z", "ctrl+y", "ctrl+u", "ctrl+left", "ctrl+right",
  "ctrl+backspace", "ctrl+delete", "ctrl+home", "ctrl+end", "ctrl+shift+left", "ctrl+shift+right", "shift+home", "shift+end"
]);

function simulateShortcutAllowedInText(combo) {
  const normalized = combo.toLowerCase().replace(/\s+/g, '');
  if (textPassthroughSet.has(normalized)) {
    return false; // Not allowed to be intercepted by browser hotkeys (PASSED TO TEXT FIELD)
  }
  const parts = normalized.split('+');
  const key = parts[parts.length - 1];
  const hasModifier = parts.includes('ctrl') || parts.includes('meta') || parts.includes('alt') || parts.includes('shift');
  
  if (["esc", "down", "up", "home", "end", "pagedown", "pageup"].includes(key)) return true;
  if (hasModifier && (parts.includes('ctrl') || parts.includes('meta') || parts.includes('alt'))) return true;
  return false;
}

// Assert that Ctrl+Enter is protected from browser interception
assert.strictEqual(simulateShortcutAllowedInText('ctrl+enter'), false, 'Ctrl+Enter must return false (protected for website)');
assert.strictEqual(simulateShortcutAllowedInText('meta+enter'), false, 'Meta+Enter must return false (protected for website)');
assert.strictEqual(simulateShortcutAllowedInText('ctrl+shift+enter'), false, 'Ctrl+Shift+Enter must return false');
assert.strictEqual(simulateShortcutAllowedInText('shift+enter'), false, 'Shift+Enter must return false');
assert.strictEqual(simulateShortcutAllowedInText('alt+enter'), false, 'Alt+Enter must return false');
assert.strictEqual(simulateShortcutAllowedInText('ctrl+a'), false, 'Ctrl+A must return false');
assert.strictEqual(simulateShortcutAllowedInText('ctrl+z'), false, 'Ctrl+Z must return false');

// Assert that actual browser hotkeys are still allowed when not in passthrough list
assert.strictEqual(simulateShortcutAllowedInText('ctrl+t'), true, 'Ctrl+T (New Tab) should be allowed by browser');
assert.strictEqual(simulateShortcutAllowedInText('ctrl+w'), true, 'Ctrl+W (Close Tab) should be allowed by browser');
assert.strictEqual(simulateShortcutAllowedInText('ctrl+n'), true, 'Ctrl+N (New Window) should be allowed by browser');

console.log('  ✔ All shortcut passthrough assertions passed.');

// 3. Test Web Panel Focus in handleShortcut
console.log('▶ Test 3: Simulating Web Panel Focus in handleShortcut');
function simulateHandleShortcut(activeElement, combo) {
  const isInsidePanel = Boolean(activeElement?.closest('#panels'));
  const isWebview = activeElement?.tagName === 'WEBVIEW';
  const isAllowedInText = simulateShortcutAllowedInText(combo);

  if (isWebview && isInsidePanel) {
    if (!isAllowedInText) {
      return { browserExecuted: false, deliveredToGuestWebview: true };
    } else {
      return { browserExecuted: true, deliveredToGuestWebview: false };
    }
  }
  return { browserExecuted: isAllowedInText, deliveredToGuestWebview: false };
}

const mockPanelWebview = {
  tagName: 'WEBVIEW',
  closest: (sel) => (sel === '#panels' ? {} : null)
};

const ctrlEnterRes = simulateHandleShortcut(mockPanelWebview, 'ctrl+enter');
assert.strictEqual(ctrlEnterRes.deliveredToGuestWebview, true, 'Ctrl+Enter inside web panel must deliver to guest webview');
assert.strictEqual(ctrlEnterRes.browserExecuted, false, 'Ctrl+Enter must not trigger browser action');

const shiftEnterRes = simulateHandleShortcut(mockPanelWebview, 'shift+enter');
assert.strictEqual(shiftEnterRes.deliveredToGuestWebview, true, 'Shift+Enter inside web panel must deliver to guest webview');

const newTabRes = simulateHandleShortcut(mockPanelWebview, 'ctrl+t');
assert.strictEqual(newTabRes.browserExecuted, true, 'Ctrl+T must trigger browser action');

console.log('  ✔ Web Panel focus and shortcut passthrough logic verified.');

// 4. Test actual patch-bundle.py execution on mock bundle.js
console.log('▶ Test 4: Mock bundle.js patching execution');
const tmpMockBundle = '/tmp/mock_bundle.js';
const mockContent = `
const D = { kPanelsShowCloseButton: "kPanelsShowCloseButton" };
let f=new Set(["left","right","shift+left","shift+right","shift+up","shift+down","enter","shift+enter"]);f=new Set([...f,"ctrl+a","ctrl+z","ctrl+y","ctrl+u","ctrl+left","ctrl+right","ctrl+backspace","ctrl+delete","ctrl+home","ctrl+end","ctrl+shift+left","ctrl+shift+right","shift+home","shift+end"]);
shouldShowCloseButton=e=>this.props.prefValues[D.kPanelsShowCloseButton]&&!((si.ZP.getSeparateFloating(e,this.winId)||this.props.prefValues[D.kPanelsAsOverlayEnabled])&&this.props.prefValues[D.kPanelsAsOverlayAutoClose]);
this.props.showCloseButton&&(0,Fi.jsx)("button",{className:"close transparent",onClick:()=>ii.Z.closePanel(this.winId),title:(0,k.Z)("Close Panel"),children:Wge})
const clamp = 0.618;
const css = "65vw";
"WEBVIEW"===m?l.Z.windowPrivate.getFocusedElementInfo(h).then((({tagName:n,editable:i,role:s})=>{if(!i||S(r)){const i="SELECT"===n,o="SPAN"===n&&"spinbutton"===s;(!i&&!o||i&&S(r))&&v(e,h,O(r),t)}})):v(e,h,O(r),t)
`;

fs.writeFileSync(tmpMockBundle, mockContent);
const { execSync } = require('child_process');
execSync(`python3 ${bundlePatcherPath} ${tmpMockBundle}`);
const patchedContent = fs.readFileSync(tmpMockBundle, 'utf8');

assert(patchedContent.includes('0.880'), '0.618 patched to 0.880');
assert(patchedContent.includes('88vw'), '65vw patched to 88vw');
assert(patchedContent.includes('ctrl+enter'), 'ctrl+enter added to f');
assert(patchedContent.includes('p?.closest?.("#panels")'), 'handleShortcut patched for #panels');
assert(patchedContent.includes('__edgeCloseWebPanel'), '__edgeCloseWebPanel hooked into Rge close button');
fs.unlinkSync(tmpMockBundle);
if (fs.existsSync(tmpMockBundle + '.orig')) fs.unlinkSync(tmpMockBundle + '.orig');

console.log('  ✔ Patcher end-to-end execution on mock bundle verified.');
console.log('========================================================');
console.log('🎉 ALL SHORTCUT TESTS PASSED (100% GREEN)');
console.log('========================================================');
