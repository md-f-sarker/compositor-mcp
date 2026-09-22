#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-}"
if [[ -z "$ROOT" ]]; then
  echo "Usage: $0 /absolute/path/to/Compositor" >&2
  exit 64
fi
ROOT="$(cd "$ROOT" && pwd)"
APP_DELEGATE="$ROOT/Compositor/IO/CompositorApplicationDelegate.swift"

[[ -f "$APP_DELEGATE" ]] || { echo "Missing $APP_DELEGATE" >&2; exit 66; }

python3 - "$APP_DELEGATE" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
text = text.replace("    private var mcpBridge: CompositorMCPBridge?\n", "", 1)
text = text.replace(
    "        let bridge = CompositorMCPBridge(workspace: workspace)\n"
    "        mcpBridge = bridge\n"
    "        bridge.start()\n",
    "",
    1,
)
text = text.replace(
    "    func applicationWillTerminate(_ notification: Notification) {\n"
    "        mcpBridge?.stop()\n"
    "    }\n\n",
    "",
    1,
)
path.write_text(text)
print(f"Removed app-delegate integration from {path}")
PY

PROJECT="$ROOT/Compositor.xcodeproj/project.pbxproj"
if [[ -f "$PROJECT" ]]; then
  python3 - "$PROJECT" <<'PY'
from pathlib import Path
import sys

# Restore the upstream build settings the installer changed.
path = Path(sys.argv[1])
text = path.read_text()
original = text
text = text.replace("ENABLE_APP_SANDBOX = NO;", "ENABLE_APP_SANDBOX = YES;")
text = text.replace(
    'CODE_SIGN_ENTITLEMENTS = "";',
    "CODE_SIGN_ENTITLEMENTS = Config/Compositor.entitlements;",
)
if text != original:
    path.write_text(text)
    print(f"Restored App Sandbox settings in {path}")
PY
fi

rm -rf "$ROOT/Compositor/MCP"
echo "Removed Compositor MCP bridge sources."
