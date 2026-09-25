#!/bin/sh
# validate-native.sh <compositor-checkout>
#
# Validates the MCP bridge against a real Compositor checkout without Xcode:
#   1. Installs the bridge + delegate patch (install-into-compositor.sh)
#   2. Typechecks the full app module (Swift 5 + approachable concurrency, Sparkle stubbed)
#   3. Builds a headless harness binary (Document/IO/Rendering/MCP + stubbed UI sheets)
#   4. Launches it — the real CompositorMCPBridge listens on loopback and writes
#      the mode-0600 discovery file
#   5. Runs scripts/validation/drive-bridge.mjs, which exercises every operation
#      group against the live EditorSession over the real JSONL protocol
#
# Requires: Xcode Command Line Tools (swiftc), Node. The UI/ tree is replaced by
# HarnessStubs.swift, so this validates the document engine and router — not the
# app's own views. For the full visual pass, open Compositor.xcodeproj in Xcode.
set -eu

REPO="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSITOR="${1:?usage: validate-native.sh <compositor-checkout>}"
WORK="${TMPDIR:-/tmp}/compositor-mcp-server-validation"
mkdir -p "$WORK/sparkle-stub"

cat > "$WORK/sparkle-stub/Sparkle.swift" <<'STUB'
import Foundation
public protocol SPUUpdaterDelegate: AnyObject {}
public protocol SPUStandardUserDriverDelegate: AnyObject {}
public final class SPUStandardUpdaterController {
    public init(startingUpdater: Bool, updaterDelegate: SPUUpdaterDelegate?, userDriverDelegate: SPUStandardUserDriverDelegate?) {}
    public func startUpdater() {}
    public func checkForUpdates(_ sender: Any?) {}
}
STUB

SDK="$(xcrun --show-sdk-path 2>/dev/null || echo /Library/Developer/CommandLineTools/SDKs/MacOSX.sdk)"
TARGET="arm64-apple-macosx26.0"
FLAGS="-swift-version 5 -enable-upcoming-feature NonisolatedNonsendingByDefault -enable-upcoming-feature InferIsolatedConformances -default-isolation MainActor -sdk $SDK -target $TARGET"

echo "==> Installing bridge into $COMPOSITOR"
"$REPO/scripts/install-into-compositor.sh" "$COMPOSITOR"

echo "==> Building Sparkle stub module"
swiftc -emit-module -module-name Sparkle -parse-as-library "$WORK/sparkle-stub/Sparkle.swift" \
  -emit-module-path "$WORK/sparkle-stub/Sparkle.swiftmodule" -sdk "$SDK" -target "$TARGET"

echo "==> Typechecking full app module (baseline errors in Compositor/UI are pre-existing)"
cd "$COMPOSITOR"
swiftc -typecheck $FLAGS -import-objc-header Compositor/Compositor-Bridging-Header.h -I "$WORK/sparkle-stub" $(find Compositor -name "*.swift") 2>&1 | tee "$WORK/typecheck.log" | grep "error:" || true
MCP_ERRORS=$(grep "error:" "$WORK/typecheck.log" | grep -c "Compositor/MCP/" || true)
echo "MCP file errors: $MCP_ERRORS (must be 0)"
[ "$MCP_ERRORS" = "0" ] || exit 1

echo "==> Building headless bridge harness"
# Top-level code must live in a file literally named main.swift.
cp "$REPO/scripts/validation/harness-main.swift" "$WORK/main.swift"
swiftc -o "$WORK/bridge-harness" $FLAGS -strict-concurrency=minimal \
  -import-objc-header Compositor/Compositor-Bridging-Header.h \
  "$WORK/main.swift" "$REPO/scripts/validation/HarnessStubs.swift" \
  $(find Compositor/Document Compositor/IO Compositor/Rendering Compositor/MCP -name "*.swift" \
    ! -name "CompositorApplicationDelegate.swift" \
    ! -name "EditorCanvas.swift" ! -name "BrushCursorOverlay.swift" ! -name "InlineTextEditor.swift" \
    ! -name "SampleRingOverlay.swift" ! -name "TransformOverlay.swift" ! -name "TiledLayerRenderer.swift" \
    ! -name "LayerEffectsSurface.swift" ! -name "EffectsPreviewCache.swift") \
  Compositor/Rendering/*.c

echo "==> Launching harness"
"$WORK/bridge-harness" &
HARNESS_PID=$!
trap 'kill $HARNESS_PID 2>/dev/null || true' EXIT
DISCOVERY="$HOME/Library/Application Support/Compositor/MCP/bridge.json"
rm -f "$DISCOVERY"
for _ in $(seq 1 50); do
    test -f "$DISCOVERY" && break
    kill -0 "$HARNESS_PID" 2>/dev/null || { echo "harness exited before writing discovery" >&2; exit 1; }
    sleep 0.2
done
test -f "$DISCOVERY" || { echo "discovery file missing" >&2; exit 1; }

echo "==> Driving live bridge"
node "$REPO/scripts/validation/drive-bridge.mjs"
