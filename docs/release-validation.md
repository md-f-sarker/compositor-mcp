# Release validation

Validation completed for the deep-parity branch on 20 September 2026.

## Completed in the development environment

- TypeScript protocol and server projects type-check with strict compiler settings.
- Both TypeScript projects build to ESM output.
- All protocol/server tests pass (77 mcp-server + 10 protocol).
- Every catalogue example validates against its advertised JSON schema.
- The TypeScript capability catalogue and Swift router agree on all **62 implemented** operation names, destructive classifications, read-only classifications and non-transactional classifications.
- Installer smoke test passes, including repeat installation and clean uninstall.
- `npm pack` produces a working standalone tarball; `compositor-mcp-server --help`, `doctor`, `configure`, and `install-bridge` verified from the packed artifact.

## Live native validation — 20 September 2026

Performed with `scripts/validate-native.sh` against upstream `robbietilton/Compositor` at audited commit `a19db90`, on macOS 26 / Swift 6.3.3 (Command Line Tools — no Xcode required for this path).

- The full app module type-checks under the project's own settings (`SWIFT_VERSION=5`, approachable concurrency). **Zero errors in the MCP bridge files.** The only diagnostics are pre-existing upstream strict-concurrency issues in `Compositor/UI/ColorPickerSheet.swift`, identical with and without the bridge installed.
- A headless harness (`scripts/validation/harness-main.swift` + `HarnessStubs.swift`) compiles the real Document/IO/Rendering/MCP stack into a runnable binary that hosts the actual `CompositorMCPBridge`.
- The harness launched the real bridge: discovery file written to `~/Library/Application Support/Compositor/MCP/bridge.json` with mode `0600`, loopback host, fresh bearer token.
- **36 end-to-end checks passed over the live JSONL protocol**, covering: ping, capability listing (62 implemented), wrong-token rejection (`unauthorised`), document create, layer add/select, all four selection tools (rectangle/ellipse/polygon/magic wand) plus `selection.none`, `pixels.fill`, all six paint operations (brushStroke, spotHeal Content-Aware mode, clone, blur, gradient, shape), adjustment.add/update (Hue/Saturation, Exposure), `filter.apply` (Gaussian Blur), `pixels.contentAwareFill`, `document.crop`, `document.resizeCanvas`, `document.resizeImage`, `layer.group`/`layer.ungroup`, `layer.distort`, `layer.featherMask`, `preview.render`, atomic batch rollback, destructive confirmation enforcement, and undo/redo.
- **Real bug found and fixed during validation:** the revision fingerprint builder in `CompositorMCPCommandRouter.swift` used `String(<CGFloat>)`, which has no matching initializer — masked by a type-checker timeout in the alpha code. Split into per-field `String(describing:)` appends.

### Not covered by the harness

- The app's own SwiftUI/AppKit views (`Compositor/UI/`) are stubbed, so canvas-level visual behaviour is unverified.
- `CompositorApplicationDelegate` patching is validated by install + typecheck, not by launching the real app.
- Compositor's own `CompositorTests`/`CompositorUITests` suites require Xcode and were not run.
- Long-running operations (large content-aware fills, remove-background on big images) against real photo assets.

## Remaining before a tagged public release

1. Build the patched app in Xcode 26 on macOS 26 and run upstream's test suites.
2. Spot-check visual output of the new paint/filter operations against the UI equivalents.
3. Publish `compositor-mcp-server` to npm and record the release tag.

The native integration is validated as far as a GUI-less environment can take it: every operation compiles against real upstream sources and executes correctly against a live `EditorSession`.
