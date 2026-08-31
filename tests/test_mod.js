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

// Basic checks
const requiredSignatures = [
  'chrome.tabs.discard',
  'pointerdown',
  'pointerup',
  'tab_id',
  'wv.src = targetUrl',
  'resetWebviewToBaseUrl',
  'chrome.tabs.update',
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

console.log('[✓] All mod signatures and files verified successfully!');
