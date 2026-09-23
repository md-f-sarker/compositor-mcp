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
STATE="$ROOT/.compositor-mcp-install-state.json"
if [[ -f "$PROJECT" && -f "$STATE" ]]; then
  python3 - "$PROJECT" "$STATE" <<'PY'
from pathlib import Path
import json
import re
import sys

# Restore exactly the build settings the installer recorded — never a
# hardcoded guess at upstream defaults. Settings a user changed again
# after install are left alone.
path, state_path = Path(sys.argv[1]), Path(sys.argv[2])
state = json.loads(state_path.read_text())
originals = state.get("originalBuildSettings", {})
installed = {"ENABLE_APP_SANDBOX": "NO", "CODE_SIGN_ENTITLEMENTS": '""'}

text = path.read_text()
original_text = text
for key, values in originals.items():
    if len(values) != 1:
        print(f"NOTE: {key} had multiple values before install; leaving current settings unchanged.")
        continue
    # Only rewrite lines still holding the installer-set value — anything the
    # user changed afterwards is left untouched.
    text = re.sub(rf"{key} = {re.escape(installed[key])};", f"{key} = {values[0]};", text)
if text != original_text:
    path.write_text(text)
    print(f"Restored original build settings in {path}")
else:
    print(f"No installer-modified build settings to restore in {path}")
PY
elif [[ -f "$PROJECT" ]]; then
  echo "NOTE: no install-state file found; leaving $PROJECT untouched." >&2
fi
rm -f "$STATE"

rm -rf "$ROOT/Compositor/MCP"
echo "Removed Compositor MCP bridge sources."
