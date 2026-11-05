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

# 4. Remove Triple-Lock persistence hooks & systemd units
if [ "$EUID" -eq 0 ]; then
    echo "[+] Removing persistence hooks and services..."

    # Systemd units
    if command -v systemctl >/dev/null 2>&1; then
        systemctl disable --now vivaldi-sidebar-mod-persist.path >/dev/null 2>&1 || true
        rm -f "/etc/systemd/system/vivaldi-sidebar-mod-persist.path"
        rm -f "/etc/systemd/system/vivaldi-sidebar-mod-persist.service"
        systemctl daemon-reload >/dev/null 2>&1 || true
    fi

    # DPKG hook
    rm -f "/etc/dpkg/dpkg.cfg.d/99-vivaldi-mod-persistence"

    # APT hook
    rm -f "/etc/apt/apt.conf.d/99-vivaldi-mod-persistence"

    # Persistence binary & shared assets
    rm -f "/usr/local/bin/vivaldi-sidebar-mod-persist"
    rm -rf "/usr/local/share/vivaldi-sidebar-mod"
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
