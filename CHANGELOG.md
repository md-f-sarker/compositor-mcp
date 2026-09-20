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

## 0.1.0 - 2026-09-19

- Added token-efficient `search` and `execute` MCP tools.
- Added typed catalogue of 62 editor capabilities.
- Implemented 42 core native operations.
- Added authenticated loopback bridge and discovery protocol.
- Added filesystem allowlisting, audit log, destructive confirmation, dry runs, idempotency and optimistic preconditions.
- Added atomic native undo grouping with guarded rollback.
- Added installer, uninstaller, configuration script, mock bridge and tests.
- Added release-validation notes distinguishing automated checks from the required macOS/Xcode live-app validation.
