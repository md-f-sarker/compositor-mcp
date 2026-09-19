#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-}"
if [[ -z "$ROOT" ]]; then
  echo "Usage: $0 /absolute/path/to/Compositor" >&2
  exit 64
fi
ROOT="$(cd "$ROOT" && pwd)"
APP_DELEGATE="$ROOT/Compositor/IO/CompositorApplicationDelegate.swift"
SOURCE_DIR="$(cd "$(dirname "$0")/.." && pwd)/compositor/Compositor/MCP"
DEST_DIR="$ROOT/Compositor/MCP"

[[ -d "$ROOT/Compositor.xcodeproj" ]] || { echo "Not a Compositor checkout: $ROOT" >&2; exit 66; }
[[ -f "$APP_DELEGATE" ]] || { echo "Missing $APP_DELEGATE" >&2; exit 66; }
[[ -f "$SOURCE_DIR/CompositorMCPBridge.swift" ]] || { echo "MCP Swift sources are missing." >&2; exit 66; }

mkdir -p "$DEST_DIR"
cp "$SOURCE_DIR"/*.swift "$DEST_DIR"/

python3 - "$APP_DELEGATE" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
original = text

if "private var mcpBridge: CompositorMCPBridge?" not in text:
    needle = "    let workspace = ProjectWorkspace()\n"
    if needle not in text:
        raise SystemExit("Could not locate ProjectWorkspace in CompositorApplicationDelegate.swift")
    text = text.replace(needle, needle + "    private var mcpBridge: CompositorMCPBridge?\n", 1)

if "bridge.start()" not in text:
    needle = "    func applicationDidFinishLaunching(_ notification: Notification) {\n"
    insertion = (
        needle
        + "        let bridge = CompositorMCPBridge(workspace: workspace)\n"
        + "        mcpBridge = bridge\n"
        + "        bridge.start()\n"
    )
    if needle not in text:
        raise SystemExit("Could not locate applicationDidFinishLaunching in CompositorApplicationDelegate.swift")
    text = text.replace(needle, insertion, 1)

if "func applicationWillTerminate(_ notification: Notification)" not in text:
    needle = "    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {\n"
    insertion = (
        "    func applicationWillTerminate(_ notification: Notification) {\n"
        "        mcpBridge?.stop()\n"
        "    }\n\n"
        + needle
    )
    if needle not in text:
        raise SystemExit("Could not locate applicationShouldHandleReopen in CompositorApplicationDelegate.swift")
    text = text.replace(needle, insertion, 1)

if text != original:
    path.write_text(text)
    print(f"Patched {path}")
else:
    print(f"Already patched: {path}")
PY

echo "Installed Compositor MCP bridge sources into $DEST_DIR"
echo "Open Compositor.xcodeproj and build the Compositor scheme."
