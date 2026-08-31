#!/usr/bin/env bash
# ==============================================================================
# Uninstaller / Factory Rollback for Vivaldi Edge-Style Web Panels Mod
# ==============================================================================
set -euo pipefail

VIVALDI_RESOURCE_DIR=""

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
    exit 1
fi

if [ ! -w "$VIVALDI_RESOURCE_DIR" ] && [ "$EUID" -ne 0 ]; then
    echo "[-] Please run with sudo: sudo bash uninstall.sh"
    exit 1
fi

echo "[+] Restoring stock Vivaldi files in $VIVALDI_RESOURCE_DIR..."

# 1. Restore window.html
if [ -f "$VIVALDI_RESOURCE_DIR/window.html.orig" ]; then
    echo "[+] Restoring window.html from window.html.orig..."
    cp -af "$VIVALDI_RESOURCE_DIR/window.html.orig" "$VIVALDI_RESOURCE_DIR/window.html"
    rm -f "$VIVALDI_RESOURCE_DIR/window.html.orig"
else
    # Fallback: remove script tag manually
    sed -i.bak 's|<script src="edge-panel-mod.js"></script>||g' "$VIVALDI_RESOURCE_DIR/window.html"
    rm -f "$VIVALDI_RESOURCE_DIR/window.html.bak"
fi

# 2. Remove mod JS
if [ -f "$VIVALDI_RESOURCE_DIR/edge-panel-mod.js" ]; then
    echo "[+] Removing edge-panel-mod.js..."
    rm -f "$VIVALDI_RESOURCE_DIR/edge-panel-mod.js"
fi

# 3. Restore bundle.js
if [ -f "$VIVALDI_RESOURCE_DIR/bundle.js.orig" ]; then
    echo "[+] Restoring bundle.js from bundle.js.orig..."
    cp -af "$VIVALDI_RESOURCE_DIR/bundle.js.orig" "$VIVALDI_RESOURCE_DIR/bundle.js"
    rm -f "$VIVALDI_RESOURCE_DIR/bundle.js.orig"
fi

# 4. Remove APT persistence hook
APT_HOOK_FILE="/etc/apt/apt.conf.d/99-vivaldi-mod-persistence"
if [ -f "$APT_HOOK_FILE" ]; then
    echo "[+] Removing APT persistence hook..."
    rm -f "$APT_HOOK_FILE"
fi

echo ""
echo "=============================================================================="
echo "[✓] Uninstallation complete! Vivaldi restored to 100% stock factory state."
echo "Restart Vivaldi to apply changes:"
if [[ "$OSTYPE" == "darwin"* ]]; then
    echo "    killall Vivaldi 2>/dev/null || true"
    echo "    open -a Vivaldi"
else
    echo "    killall vivaldi-bin vivaldi 2>/dev/null || true"
    echo "    vivaldi &"
fi
echo "=============================================================================="
