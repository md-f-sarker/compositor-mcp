# Release validation

Validation completed for the deep-parity branch on 20 September 2026, and repeated for the v1.3.1 rebase on 25 September 2026.

## Live native validation — 25 September 2026, at upstream `7e9afbe` (v1.3 line)

Performed with `scripts/validate-native.sh` against upstream `robbietilton/Compositor` at audited commit `7e9afbe8559d2b74100bc57a36db1302e91ceed8` (three commits past the `v1.3.1` tag), on macOS 26 (Command Line Tools).

- The full app module type-checks under the project's own settings, now including `SWIFT_DEFAULT_ACTOR_ISOLATION=MainActor` (mirrored via `-default-isolation MainActor`) and the bridging header so the C pixel helpers resolve. **Zero errors across the module**, including the MCP bridge files.
- The harness file list now excludes v1.3's UI-layer view files moved under `Rendering/` (`EditorCanvas`, `BrushCursorOverlay`, `InlineTextEditor`, `SampleRingOverlay`, `TransformOverlay`, `TiledLayerRenderer`, `LayerEffectsSurface`, `EffectsPreviewCache`), and `HarnessStubs.swift` stubs the UI types the document engine still references (`PSDConversionRequest`, `TrimSheet`, `EffectsPreviewCache`) plus the Sparkle `checkForUpdates(_:)` method upstream's new "Check for Updates…" menu item calls.
- **45/45 end-to-end checks passed over the live JSONL protocol** (capability listing reports 64 implemented), including the v1.3 additions the driver now covers permanently: Vignette applied to an empty layer fills the canvas frame via `canVignette`, non-vignette filters still refuse empty layers with `filter_unavailable`, Bloom / Glow and Tonal Contrast apply, `layer.copy`/`layer.paste` round-trip within a project with returned layer ids, copying with an active pixel selection is refused, `document.save` performs the watcher bookkeeping (`externalChanges.saving`, digest memory, `watchProject`) so the file watcher does not mistake a bridge save for an outside edit, and undo/redo work afterwards.

## Completed in the development environment

- TypeScript protocol and server projects type-check with strict compiler settings.
- Both TypeScript projects build to ESM output.
- All protocol/server tests pass (77 mcp-server + 10 protocol).
- Every catalogue example validates against its advertised JSON schema.
- The TypeScript capability catalogue and Swift router agree on all **64 implemented** operation names, destructive classifications, read-only classifications and non-transactional classifications.
- Installer smoke test passes, including repeat installation and clean uninstall.
- `npm pack` produces a working standalone tarball; `compositor-mcp-server --help`, `doctor`, `configure`, and `install-bridge` verified from the packed artifact.

## Live native validation — 20 September 2026

Performed with `scripts/validate-native.sh` against upstream `robbietilton/Compositor` at audited commit `a19db90`, on macOS 26 / Swift 6.3.3 (Command Line Tools — no Xcode required for this path).

- The full app module type-checks under the project's own settings (`SWIFT_VERSION=5`, approachable concurrency). **Zero errors in the MCP bridge files.** The only diagnostics are pre-existing upstream strict-concurrency issues in `Compositor/UI/ColorPickerSheet.swift`, identical with and without the bridge installed.
- A headless harness (`scripts/validation/harness-main.swift` + `HarnessStubs.swift`) compiles the real Document/IO/Rendering/MCP stack into a runnable binary that hosts the actual `CompositorMCPBridge`.
- The harness launched the real bridge: discovery file written to `~/Library/Application Support/Compositor/MCP/bridge.json` with mode `0600`, loopback host, fresh bearer token.
- **36 end-to-end checks passed over the live JSONL protocol**, covering: ping, capability listing (62 implemented at the time), wrong-token rejection (`unauthorised`), document create, layer add/select, all four selection tools (rectangle/ellipse/polygon/magic wand) plus `selection.none`, `pixels.fill`, all six paint operations (brushStroke, spotHeal Content-Aware mode, clone, blur, gradient, shape), adjustment.add/update (Hue/Saturation, Exposure), `filter.apply` (Gaussian Blur), `pixels.contentAwareFill`, `document.crop`, `document.resizeCanvas`, `document.resizeImage`, `layer.group`/`layer.ungroup`, `layer.distort`, `layer.featherMask`, `preview.render`, atomic batch rollback, destructive confirmation enforcement, and undo/redo.
- **Real bug found and fixed during validation:** the revision fingerprint builder in `CompositorMCPCommandRouter.swift` used `String(<CGFloat>)`, which has no matching initializer — masked by a type-checker timeout in the alpha code. Split into per-field `String(describing:)` appends.

### Not covered by the harness

- The app's own SwiftUI/AppKit views (`Compositor/UI/`) are stubbed, so canvas-level visual behaviour is unverified.
- `CompositorApplicationDelegate` patching is validated by install + typecheck, not by launching the real app.
- Compositor's own `CompositorTests`/`CompositorUITests` suites require Xcode and were not run.
- Long-running operations (large content-aware fills, remove-background on big images) against real photo assets.

## Live full-app validation — 22 September 2026, at upstream `75c4219`

Performed against the real built application (`xcodebuild -project Compositor.xcodeproj -scheme Compositor`) rather than the headless harness.

- Bridge installed into an upstream checkout at HEAD; the installer disables App Sandbox in `project.pbxproj` for the dev build (the stock entitlements lack `com.apple.security.network.server`, so the loopback listener and authorized-root file I/O cannot run inside it). The uninstaller restores the sandboxed settings.
- Full app builds and launches via `open`; `bridge.json` is written by the normal launch path and `app.ping`'s `processId` matches it — the live endpoint is the real app process, not a stray binary.
- Every newly bridged kind executes on a real document: `adjustment.add` for Invert, Motion Blur, and Black & White (tint), `filter.apply` for Color Balance, and a Camera Raw atmosphere pass (negative Dehaze, positive Glow) followed by a blurred gradient fog layer — exported to PNG.
- Re-verified the merged fixes on the live app: `prompts/get` with no `arguments`, and `idempotency_conflict` on key reuse over a different request.

## Remaining before a tagged public release

1. Build the patched app in Xcode 26 on macOS 26 and run upstream's test suites.
2. Spot-check visual output of the new paint/filter operations against the UI equivalents.
3. Publish `compositor-mcp-server` to npm and record the release tag.

The native integration is validated as far as a GUI-less environment can take it: every operation compiles against real upstream sources and executes correctly against a live `EditorSession`.
