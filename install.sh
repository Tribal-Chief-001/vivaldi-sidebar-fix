#!/usr/bin/env bash
# ==============================================================================
# Installer for Vivaldi Edge-Style Web Panels Mod (Linux, macOS, BSD)
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VIVALDI_RESOURCE_DIR=""

# Detect Vivaldi installation directory across Linux, macOS, BSD, and Flatpak
CANDIDATE_DIRS=(
    # Linux standard & snapshots
    "/opt/vivaldi/resources/vivaldi"
    "/opt/vivaldi-snapshot/resources/vivaldi"
    "/usr/share/vivaldi/resources/vivaldi"
    "/usr/local/share/vivaldi/resources/vivaldi"
    "/app/vivaldi/resources/vivaldi"
    # macOS
    "/Applications/Vivaldi.app/Contents/Frameworks/Vivaldi Framework.framework/Resources/vivaldi"
    "/Applications/Vivaldi.app/Contents/Resources/vivaldi"
    "/Applications/Vivaldi Snapshot.app/Contents/Frameworks/Vivaldi Framework.framework/Resources/vivaldi"
    "/Applications/Vivaldi Snapshot.app/Contents/Resources/vivaldi"
    "$HOME/Applications/Vivaldi.app/Contents/Frameworks/Vivaldi Framework.framework/Resources/vivaldi"
)

for dir in "${CANDIDATE_DIRS[@]}"; do
    if [ -d "$dir" ] && [ -f "$dir/window.html" ]; then
        VIVALDI_RESOURCE_DIR="$dir"
        break
    fi
done

if [ -z "$VIVALDI_RESOURCE_DIR" ]; then
    echo "[-] Error: Could not locate Vivaldi resources directory."
    echo "    Checked Linux paths (/opt/vivaldi/...) and macOS paths (/Applications/Vivaldi.app/...)."
    echo "    Please verify Vivaldi is installed."
    exit 1
fi

echo "[+] Detected Vivaldi directory: $VIVALDI_RESOURCE_DIR"

# Require root/sudo for system directories, allow regular user for home directory installs
if [ ! -w "$VIVALDI_RESOURCE_DIR" ] && [ "$EUID" -ne 0 ]; then
    echo "[-] This directory requires administrative privileges. Please run with sudo:"
    echo "    sudo bash install.sh"
    exit 1
fi

# Step 1: Backup window.html if pristine backup does not exist
if [ ! -f "$VIVALDI_RESOURCE_DIR/window.html.orig" ]; then
    echo "[+] Creating pristine backup: window.html.orig"
    cp -a "$VIVALDI_RESOURCE_DIR/window.html" "$VIVALDI_RESOURCE_DIR/window.html.orig"
fi

# Step 2: Copy edge-panel-mod.js
echo "[+] Installing edge-panel-mod.js into Vivaldi..."
cp -f "$SCRIPT_DIR/src/edge-panel-mod.js" "$VIVALDI_RESOURCE_DIR/edge-panel-mod.js"
chmod 644 "$VIVALDI_RESOURCE_DIR/edge-panel-mod.js"

# Step 3: Inject script tag into window.html
if ! grep -q 'src="edge-panel-mod.js"' "$VIVALDI_RESOURCE_DIR/window.html"; then
    echo "[+] Injecting script tag into window.html..."
    sed -i.bak 's|</body>|<script src="edge-panel-mod.js"></script></body>|' "$VIVALDI_RESOURCE_DIR/window.html"
    rm -f "$VIVALDI_RESOURCE_DIR/window.html.bak"
else
    echo "[*] Script tag already present in window.html"
fi

# Step 4: Patch bundle.js for 88% width expansion
if [ -f "$VIVALDI_RESOURCE_DIR/bundle.js" ]; then
    echo "[+] Running width expansion patch on bundle.js..."
    python3 "$SCRIPT_DIR/src/patch-bundle.py" "$VIVALDI_RESOURCE_DIR/bundle.js"
fi

# Step 5: Install APT Post-Invoke hook for update persistence on Debian/Ubuntu/Mint
APT_HOOK_FILE="/etc/apt/apt.conf.d/99-vivaldi-mod-persistence"
if [ -d "/etc/apt/apt.conf.d" ] && [ "$EUID" -eq 0 ]; then
    echo "[+] Setting up APT persistence hook at $APT_HOOK_FILE..."
    cat << HOOK_EOF > "$APT_HOOK_FILE"
// Re-apply Vivaldi Edge Panels mod automatically after package updates
DPkg::Post-Invoke {"if [ -x $SCRIPT_DIR/install.sh ]; then bash $SCRIPT_DIR/install.sh; fi";};
HOOK_EOF
    chmod 644 "$APT_HOOK_FILE"
fi

echo ""
echo "=============================================================================="
echo "[✓] Installation complete!"
echo "    - Dedicated close button (X) active"
echo "    - 0 MB instant RAM discard via chrome.tabs.discard() active"
echo "    - 88% max panel width slider enabled"
if [ -d "/etc/apt/apt.conf.d" ]; then
    echo "    - APT persistence hook configured"
fi
echo ""
echo "Restart Vivaldi to apply changes:"
if [[ "$OSTYPE" == "darwin"* ]]; then
    echo "    killall Vivaldi 2>/dev/null || true"
    echo "    open -a Vivaldi"
else
    echo "    killall vivaldi-bin vivaldi 2>/dev/null || true"
    echo "    vivaldi &"
fi
echo "=============================================================================="
