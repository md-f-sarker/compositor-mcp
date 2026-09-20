# Changelog

## Unreleased

- Implemented the remaining 20 catalogued capabilities natively — geometry and layer structure (`document.resizeCanvas`, `document.resizeImage`, `document.crop`, `layer.ungroup`, `layer.featherMask`, `layer.distort`), selection tools (`selection.rectangle`, `selection.ellipse`, `selection.polygon`, `selection.magicWand`), painting and retouching (`paint.brushStroke`, `paint.spotHeal`, `paint.clone`, `paint.blur`, `paint.gradient`, `paint.shape`), and adjustments/filters (`adjustment.add`, `adjustment.update`, `filter.apply`, `pixels.contentAwareFill`). The catalogue is now 62/62 implemented.
- Completed the capability contracts: every catalogue entry carries a strict input schema, aliases, tags and validated examples; added `scripts/generate-capability-docs.mjs`, which emits `docs/capabilities.md` from the registry and is checked in `npm run check`.
- Deepened the MCP surface: `search` and `execute` gained `outputSchema`/`structuredContent` and tool annotations; added resources (`compositor://state`, `compositor://layers`, `compositor://capabilities`, `compositor://preview/latest`), four workflow prompts (`export-for-web`, `subject-cutout`, `retouch-pass`, `batch-variant`), inline `image/png` previews (≤ 1 MiB), and optional elicitation-based confirmation for destructive calls.
- Made the package publishable: `npx -y compositor-mcp` runs the server, and the `compositor-mcp` CLI gained `doctor`, `install-bridge <dir>` and `configure <dir...>` subcommands; added a release workflow that publishes to npm with provenance on `v*` tags.
- Hardened the installer: verifies the Compositor checkout against the audited upstream commit, warns on drift and records both SHAs in the install report.
- Rewrote the README as a user-facing product page (quickstart, feature table, MCP surface, security summary) and added OSS hygiene files: `CODE_OF_CONDUCT.md`, issue templates, a pull-request template and `docs/upstream-proposal.md` — a ready-to-file proposal for an official bridge entry point in upstream Compositor.

## 0.1.0 - 2026-09-19

- Added token-efficient `search` and `execute` MCP tools.
- Added typed catalogue of 62 editor capabilities.
- Implemented 42 core native operations.
- Added authenticated loopback bridge and discovery protocol.
- Added filesystem allowlisting, audit log, destructive confirmation, dry runs, idempotency and optimistic preconditions.
- Added atomic native undo grouping with guarded rollback.
- Added installer, uninstaller, configuration script, mock bridge and tests.
- Added release-validation notes distinguishing automated checks from the required macOS/Xcode live-app validation.
