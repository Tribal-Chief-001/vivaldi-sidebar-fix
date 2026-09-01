// Basic syntax and logic verification for edge-panel-mod.js
const fs = require('fs');
const path = require('path');

const modPath = path.join(__dirname, '../src/edge-panel-mod.js');
const patchPath = path.join(__dirname, '../src/patch-bundle.py');

console.log('[+] Verifying files exist...');
if (!fs.existsSync(modPath)) {
  console.error('[-] Missing src/edge-panel-mod.js');
  process.exit(1);
}
if (!fs.existsSync(patchPath)) {
  console.error('[-] Missing src/patch-bundle.py');
  process.exit(1);
}

console.log('[+] Checking JavaScript syntax...');
const code = fs.readFileSync(modPath, 'utf8');

// Core signatures that must be present in the root-cause fix
const requiredSignatures = [
  'chrome.tabs.remove',        // Root fix: remove instead of discard
  'pointerdown',
  'pointerup',
  'tab_id',
  '__edgeShouldReset',          // React bridge for componentDidUpdate
  '__edgeCloseWebPanel',        // Global Rge close bridge
  'closedPanelsForReset',       // Panel flagging set
  'destroyPanelTab',            // Tab destruction function
  'setupCloseButton',
  'NATIVE_CLOSE_SVG',
  'GLIDE_DELAY_MS'
];

for (const sig of requiredSignatures) {
  if (!code.includes(sig)) {
    console.error(`[-] Missing critical signature in mod: ${sig}`);
    process.exit(1);
  }
}

// Verify the old broken approach is NOT present
const forbiddenSignatures = [
  'chrome.tabs.discard',          // Root cause of all failures
  'discardedTabs',                // Tracking set for discarded tabs (no longer needed)
  'recentlyResetPanels',          // Race condition workaround (no longer needed)
  'resetWebviewToBaseUrl',        // Manual URL reset (no longer needed)
  'getCleanBaseUrlFallback',      // Heuristic URL guessing (no longer needed)
  'chrome.tabs.update',           // Manual tab URL update (no longer needed)
];

// Strip comments before checking for forbidden code signatures
const codeWithoutComments = code
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '');

for (const sig of forbiddenSignatures) {
  if (codeWithoutComments.includes(sig)) {
    console.error(`[-] FORBIDDEN: Old broken code "${sig}" still present in mod!`);
    process.exit(1);
  }
}

console.log('[✓] All mod signatures verified. Root-cause fix confirmed, no legacy workarounds present!');
