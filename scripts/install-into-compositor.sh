#!/usr/bin/env bash
set -euo pipefail

# Upstream Compositor revision the bridge patch and Swift sources were audited
# against (see README.md / NOTICE.md). Drift warns but does not fail: the patch
# anchors are string-based and may still apply cleanly on newer commits.
AUDITED_UPSTREAM_SHA="a19db9011282399785dc18efcfded904627bdcc2"

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

UPSTREAM_HEAD=""
if git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  UPSTREAM_HEAD="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)"
fi

if [[ -n "$UPSTREAM_HEAD" && "$UPSTREAM_HEAD" == "$AUDITED_UPSTREAM_SHA" ]]; then
  echo "Upstream revision verified: HEAD matches audited commit $AUDITED_UPSTREAM_SHA"
elif [[ -n "$UPSTREAM_HEAD" ]]; then
  echo "WARNING: upstream drift detected — proceeding anyway." >&2
  echo "  upstream HEAD:    $UPSTREAM_HEAD" >&2
  echo "  audited commit:   $AUDITED_UPSTREAM_SHA" >&2
  echo "  The bridge patch applies by string anchors and may need review." >&2
else
  echo "NOTE: $ROOT is not a git checkout; cannot compare against audited commit $AUDITED_UPSTREAM_SHA." >&2
fi

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

PROJECT="$ROOT/Compositor.xcodeproj/project.pbxproj"
[[ -f "$PROJECT" ]] || { echo "Missing $PROJECT" >&2; exit 66; }

python3 - "$PROJECT" <<'PY'
from pathlib import Path
import sys

# The bridge hosts a loopback listener and performs file I/O under the
# configured authorized roots — both are impossible inside App Sandbox
# (the stock entitlements grant only user-selected file access), so the
# dev build must run unsandboxed. Mirrors the xcodebuild overrides
# ENABLE_APP_SANDBOX=NO and CODE_SIGN_ENTITLEMENTS= empty.
path = Path(sys.argv[1])
text = path.read_text()
original = text
text = text.replace("ENABLE_APP_SANDBOX = YES;", "ENABLE_APP_SANDBOX = NO;")
text = text.replace(
    "CODE_SIGN_ENTITLEMENTS = Config/Compositor.entitlements;",
    'CODE_SIGN_ENTITLEMENTS = "";',
)
if text != original:
    path.write_text(text)
    print(f"Disabled App Sandbox for the MCP bridge in {path}")
else:
    print(f"App Sandbox already disabled (or settings moved): {path}")
PY

echo "Installed Compositor MCP bridge sources into $DEST_DIR"
echo "Install report:"
echo "  audited upstream commit: $AUDITED_UPSTREAM_SHA"
echo "  upstream HEAD:           ${UPSTREAM_HEAD:-unknown (not a git checkout)}"
echo "  app sandbox:             disabled for this dev build (loopback listener + file I/O need it)"
echo "Open Compositor.xcodeproj and build the Compositor scheme."
