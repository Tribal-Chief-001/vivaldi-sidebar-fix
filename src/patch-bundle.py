#!/usr/bin/env python3
"""
Vivaldi bundle.js Patcher (Cross-Platform: Linux, macOS, Windows, FreeBSD):
1. Expands maximum panel width drag limit from Golden Ratio (0.618 / 61.8%) to 0.880 (88%).
2. Expands container max-width CSS from 65vw to 88vw.
3. Preserves exact byte lengths to maintain source-map and runtime alignment.
"""

import os
import sys
import glob
import shutil

CANDIDATE_PATHS = [
    # Linux / BSD / Flatpak
    "/opt/vivaldi/resources/vivaldi/bundle.js",
    "/opt/vivaldi-snapshot/resources/vivaldi/bundle.js",
    "/usr/share/vivaldi/resources/vivaldi/bundle.js",
    "/usr/local/share/vivaldi/resources/vivaldi/bundle.js",
    "/app/vivaldi/resources/vivaldi/bundle.js",
    # macOS
    "/Applications/Vivaldi.app/Contents/Frameworks/Vivaldi Framework.framework/Resources/vivaldi/bundle.js",
    "/Applications/Vivaldi.app/Contents/Resources/vivaldi/bundle.js",
    "/Applications/Vivaldi Snapshot.app/Contents/Frameworks/Vivaldi Framework.framework/Resources/vivaldi/bundle.js",
    "/Applications/Vivaldi Snapshot.app/Contents/Resources/vivaldi/bundle.js",
]

def find_bundle_path():
    # 1. Check fixed Unix / macOS paths
    for p in CANDIDATE_PATHS:
        if os.path.isfile(p):
            return p

    # 2. Check Windows paths (User & System installs)
    win_roots = []
    for env_var in ["LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)"]:
        val = os.environ.get(env_var)
        if val:
            win_roots.append(val)

    for root in win_roots:
        patterns = [
            os.path.join(root, "Vivaldi", "Application", "*", "resources", "vivaldi", "bundle.js"),
            os.path.join(root, "Vivaldi Snapshot", "Application", "*", "resources", "vivaldi", "bundle.js"),
        ]
        for pat in patterns:
            matches = glob.glob(pat)
            if matches:
                # Return highest version match if multiple versions exist
                matches.sort(reverse=True)
                return matches[0]

    return None

def patch_bundle(bundle_path):
    print(f"Target bundle: {bundle_path}")

    if not os.path.exists(bundle_path):
        print(f"Error: {bundle_path} does not exist.")
        return False

    orig_backup = bundle_path + ".orig"
    if not os.path.exists(orig_backup):
        print(f"Creating pristine backup: {orig_backup}")
        shutil.copy2(bundle_path, orig_backup)
    else:
        print(f"Pristine backup already exists at {orig_backup}")

    with open(bundle_path, "r", encoding="utf-8", errors="replace") as f:
        content = f.read()

    changes = 0

    # 1. Expand Math.clamp drag limiter (0.618 -> 0.880)
    # Target: 0.618*this.context.innerWidth or similar
    if "0.618" in content:
        content = content.replace("0.618", "0.880")
        print(" -> Patched width clamp factor (0.618 -> 0.880 [88% width])")
        changes += 1
    elif "0.880" in content:
        print(" -> Drag clamp factor already set to 0.880")
    else:
        print(" -> Note: 0.618 clamp pattern not matched (may already be patched or different build)")

    # 2. Expand CSS container max-width clamp (65vw -> 88vw)
    # Target: `65vw` or `min(${...}px, 65vw)`
    if "65vw" in content:
        content = content.replace("65vw", "88vw")
        print(" -> Patched container max-width (65vw -> 88vw)")
        changes += 1
    elif "88vw" in content:
        print(" -> Container max-width already set to 88vw")
    else:
        print(" -> Note: 65vw pattern not matched")

    # 3. Enable native Vivaldi Close (X) button even with Floating & Auto-Close
    old_close = "shouldShowCloseButton=e=>this.props.prefValues[D.kPanelsShowCloseButton]&&!((si.ZP.getSeparateFloating(e,this.winId)||this.props.prefValues[D.kPanelsAsOverlayEnabled])&&this.props.prefValues[D.kPanelsAsOverlayAutoClose]);"
    if old_close in content:
        base = "shouldShowCloseButton=e=>Boolean(this.props.prefValues[D.kPanelsShowCloseButton]);/*"
        padding = len(old_close) - len(base) - len("*/;")
        new_close = base + " " * padding + "*/;"
        content = content.replace(old_close, new_close, 1)
        print(" -> Enabled native Vivaldi close button in bundle.js")
        changes += 1
    elif "shouldShowCloseButton=e=>Boolean(this.props.prefValues[D.kPanelsShowCloseButton]);" in content:
        print(" -> Native close button already enabled in bundle.js")

    if changes > 0:
        with open(bundle_path, "w", encoding="utf-8") as f:
            f.write(content)
        print(f"Successfully applied {changes} patch(es) to {bundle_path}")
        return True
    else:
        print("No modifications needed or already up to date.")
        return True

def main():
    if len(sys.argv) > 1:
        target = sys.argv[1]
    else:
        target = find_bundle_path()

    if not target:
        print("Error: Could not locate Vivaldi bundle.js automatically.")
        print("Usage: python3 patch-bundle.py [path_to_bundle.js]")
        sys.exit(1)

    success = patch_bundle(target)
    sys.exit(0 if success else 1)

if __name__ == "__main__":
    main()
