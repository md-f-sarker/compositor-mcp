# Changelog

## Unreleased

- Implemented the remaining 20 catalogued capabilities natively — geometry and layer structure (`document.resizeCanvas`, `document.resizeImage`, `document.crop`, `layer.ungroup`, `layer.featherMask`, `layer.distort`), selection tools (`selection.rectangle`, `selection.ellipse`, `selection.polygon`, `selection.magicWand`), painting and retouching (`paint.brushStroke`, `paint.spotHeal`, `paint.clone`, `paint.blur`, `paint.gradient`, `paint.shape`), and adjustments/filters (`adjustment.add`, `adjustment.update`, `filter.apply`, `pixels.contentAwareFill`). The catalogue is now 62/62 implemented.
- Completed the capability contracts: every catalogue entry carries a strict input schema, aliases, tags and validated examples; added `scripts/generate-capability-docs.mjs`, which emits `docs/capabilities.md` from the registry and is checked in `npm run check`.
- Deepened the MCP surface: `search` and `execute` gained `outputSchema`/`structuredContent` and tool annotations; added resources (`compositor://state`, `compositor://layers`, `compositor://capabilities`, `compositor://preview/latest`), four workflow prompts (`export-for-web`, `subject-cutout`, `retouch-pass`, `batch-variant`), inline `image/png` previews (≤ 1 MiB), and optional elicitation-based confirmation for destructive calls.
- Made the package publishable: `npx -y compositor-mcp` runs the server, and the `compositor-mcp` CLI gained `doctor`, `install-bridge <dir>` and `configure <dir...>` subcommands; added a release workflow that publishes to npm with provenance on `v*` tags.
- Hardened the installer: verifies the Compositor checkout against the audited upstream commit, warns on drift and records both SHAs in the install report.
- Rewrote the README as a user-facing product page (quickstart, feature table, MCP surface, security summary) and added OSS hygiene files: `CODE_OF_CONDUCT.md`, issue templates, a pull-request template and `docs/upstream-proposal.md` — a ready-to-file proposal for an official bridge entry point in upstream Compositor.
- Renamed `details.destructiveOperations` to `details.operations` in `confirmation_required` payloads, matching the key the bridge emits, and moved the destructive-confirmation gate ahead of per-operation argument validation so a gated batch never reports schema errors first; declining or cancelling the elicitation prompt now fails the batch with `confirmation_declined`.
- Extended the `compositor-mcp` CLI with `uninstall-bridge` alongside `serve`, `doctor`, `install-bridge` and `configure`; `configure` now merges an existing `config.json`, preserving flags such as `enabled` and `auditLogging` instead of overwriting them.
- Raised mock-bridge fidelity to the real router: state nests the open document under `document`, layer masks report `{enabled, linked, width, height}` objects or null, missing layers fail with `not_found`, `document.create` returns `{projectId, documentId, activeLayerId}`, `layer.list` returns the `{projectId, documentId, activeLayerId, selectedLayerIds, layers}` envelope, `layer.select` supports `target: "mask"`, and `search` reports `total`/`truncated` alongside `count`.
- Made validation errors legible: a const-discriminated `oneOf` failure names the discriminator and its valid values (`kind must be one of: …`) or the matched branch's own field issues, and dropped the unenforceable `seed` setting from `filter.apply`'s "Add Noise" kind (Grain's seed remains).
- Strengthened release checks: the parity script now verifies every implemented operation appears in both the Swift validate and apply dispatch switches, `docs:check` asserts the README states the implemented count, the live bridge driver derives its expected count from the registry, and `pack:smoke` runs the packed package's bundled `install-bridge` against a fixture checkout.
- Renamed the package and CLI to `compositor-mcp-server` — the `compositor-mcp` npm name was claimed by an unrelated package, so `npx -y compositor-mcp` would have installed it. Added `server.json` for the official MCP registry.
- Fixed `prompts/get` failing with -32602 when `arguments` is omitted — the MCP spec makes the field optional, so every workflow prompt's args schema now defaults to `{}`.
- Taught the mock bridge the router's idempotency semantics: a SHA-256 fingerprint of the canonicalized request replays the stored result verbatim, a reused key over a different request fails with `idempotency_conflict`, dry runs are never cached, and the cache evicts oldest-first past 20 keys.
- Documented the SDK's 10 MiB stdio message cap and the pending-edit, non-transactional and canvas/layer bounds in a new README "Known limits" section, plus a requirements line covering tested clients and protocol revisions.
- Brought the bridge up to upstream HEAD (`75c4219`): exhaustive switches in `CompositorMCPFilters.swift` now cover the new `AdjustmentKind` cases (Black & White, Color Balance, Gaussian Blur, Motion Blur, Add Noise, Invert) and `FilterKind` cases (Black & White, Color Balance, Camera Raw Filter), with typed builders for each parameter set — the bridge previously failed to compile against HEAD, so the installer proceeded into a broken build.
- Bridged the Camera Raw filter's flat sliders (white balance, exposure, tone, presence, dehaze, glow, vignette, grain, style enums) — enough for atmospheric passes like haze and glow; the nested panel groups (curve, mixer, grading, detail, optics, geometry, calibration) are not yet bridged.
- Fixed the stock-app dead end: the installer now disables App Sandbox in the dev build's `project.pbxproj` — upstream's entitlements lack `com.apple.security.network.server`, so the bridge's loopback listener could not start and no `bridge.json` was ever written. The uninstaller restores the sandboxed settings. The audited upstream commit advanced to `75c4219`.
- Made install/uninstall a true round trip: `install-bridge` records the original build-setting values it changes in `.compositor-mcp-install-state.json`, and `uninstall-bridge` restores exactly those values (skipping settings the user has since edited) instead of writing back hardcoded defaults.
- Fixed `execute` returning a failed batch (`ok:false`) as a successful tool call — it now sets `isError` so MCP clients surface the failure correctly.
- Fixed `search` reporting `total`/`truncated` after clamping to `limit` — `total` now counts all matches and `truncated` reflects the clamp.
- Fixed non-atomic batches leaving a second failed operation's changes behind: the rollback accumulator's `||` short-circuit skipped `rollbackFailedOperation` once one rollback had succeeded.
- Hardened the native bridge against local resource exhaustion: concurrent connections capped at 32, the serial work queue bounded at 64, a 30s receive deadline reclaims abandoned connections, and requests are now decoded and authenticated *before* being admitted to the queue.
- Requires Node.js 22 or newer (Node 20 is EOL); CI uses `npm ci`; the release workflow fails if the tag doesn't match `package.json` version.

## 0.1.0 - 2026-09-19

- Added token-efficient `search` and `execute` MCP tools.
- Added typed catalogue of 62 editor capabilities.
- Implemented 42 core native operations.
- Added authenticated loopback bridge and discovery protocol.
- Added filesystem allowlisting, audit log, destructive confirmation, dry runs, idempotency and optimistic preconditions.
- Added atomic native undo grouping with guarded rollback.
- Added installer, uninstaller, configuration script, mock bridge and tests.
- Added release-validation notes distinguishing automated checks from the required macOS/Xcode live-app validation.
