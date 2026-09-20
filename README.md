# Compositor MCP

[![CI](https://github.com/md-f-sarker/compositor-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/md-f-sarker/compositor-mcp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/compositor-mcp)](https://www.npmjs.com/package/compositor-mcp)
[![License: MIT](https://img.shields.io/npm/l/compositor-mcp)](LICENSE)

**Deep Model Context Protocol control of [Compositor](https://github.com/robbietilton/Compositor), the native macOS image editor.**

Compositor MCP gives AI assistants — Claude Code, Claude Desktop, Codex, or any MCP client — real, native editing power: all **62 catalogued operations implemented** and running through Compositor's own document model, renderer and undo history. No pixel clicking, no UI automation — the same code paths the app itself uses, exposed as typed, composable operations.

## What it does

You describe the edit in natural language; the assistant plans and executes it as native operations against the live document:

> **You:** "Cut out the subject, put it on its own layer and export a transparent PNG for the web."
>
> **Assistant:** selects the subject layer → runs `filter.apply` *Remove Background* → adds a backdrop layer → feathers the mask edge → renders a preview to check the composite → exports `hero.png` with alpha. Every step is a native, undoable edit — the whole pass lands in Compositor's history like work you did by hand.

Or: *"Heal out the watermark in the corner,"* *"resize this to 1600px wide and export PNG + JPEG,"* *"duplicate the layer, grade it warm, and save a variant"* — end-to-end tasks, not single clicks.

The surface stays small even though the editor is deep: a `search` tool finds the right operation and returns only its schema, an `execute` tool runs operations singly or as an atomic all-or-nothing batch, MCP resources expose live editor state and rendered previews, and workflow prompts package complete recipes for common jobs.

## Quickstart

### 1. Add the server to your MCP client

```json
{
  "mcpServers": {
    "compositor": {
      "command": "npx",
      "args": ["-y", "compositor-mcp"]
    }
  }
}
```

- **Claude Code:** `claude mcp add compositor -- npx -y compositor-mcp`
- **Claude Desktop / other clients:** merge the JSON stanza above into the client's MCP configuration.
- Prefer a global install? `npm i -g compositor-mcp`, then use `"command": "compositor-mcp"` with no args.

### 2. Install the native bridge and authorize filesystem roots

The bridge is a small set of Swift files installed into your Compositor checkout:

```bash
npx -y compositor-mcp install-bridge /absolute/path/to/Compositor
npx -y compositor-mcp configure "$HOME/Pictures" "$HOME/Downloads"
```

Then open `Compositor.xcodeproj`, build and run the **Compositor** scheme once (Xcode file-system-synchronised groups pick up the new `Compositor/MCP` files automatically). Restart Compositor after changing configuration — file operations are denied outside the authorized roots.

### 3. Verify the setup

```bash
npx -y compositor-mcp doctor
```

`doctor` checks the bridge discovery file, pings the running app, and reports the app version, protocol, implemented capability count, revision and authorized roots.

## What you can control

All 62 operations are implemented — see the full generated reference in [docs/capabilities.md](docs/capabilities.md).

| Area | Operations |
|---|---|
| App & workspace | Ping, inspect editor state, list/select open projects |
| Documents | Create, open, save, import images, PNG/JPEG export, flip, canvas size, image size, crop |
| History | Undo, redo |
| Layers | List/select, blank, duplicate, rename, delete, visibility, opacity, blend mode, move, group, ungroup, merge, flip, transform, free distort |
| Masks | Add/delete, link/unlink, clipping masks, feather |
| Selection | Inspect, all/none/invert, from layer/mask, rectangle, ellipse, polygonal lasso, magic wand, expand/contract |
| Pixels | Fill, clear, invert, content-aware fill |
| Painting & retouching | Brush/erase strokes, spot heal, clone stamp, blur/smudge/liquify, gradients, shape layers |
| Adjustments | Add/update adjustment layers — Hue/Saturation, Levels, Curves, Exposure, Gradient Map, Grain |
| Filters | Blur, noise, lens correction, remove background, and colour filters |
| Preview | Full-resolution temporary renders (inline PNG for vision-capable clients) |

`execute` adds the controls a real editor needs: **atomic multi-operation batches** with native undo grouping, **dry runs**, **optimistic preconditions** (project/document/revision), **idempotency keys**, and **destructive-action confirmation**.

> Long-running operations such as content-aware fill and remove background can exceed the default 30 s bridge timeout on large documents — raise it with `COMPOSITOR_MCP_TIMEOUT_MS` on the server process.

## The MCP surface

Two tools, plus resources and prompts — the catalogue scales underneath, not the tool list:

- **`search`** — query the capability catalogue; returns names, risk classes and JSON schemas (`readOnlyHint`, `idempotentHint`).
- **`execute`** — run one or more typed operations (`destructiveHint`). Both tools return `structuredContent` matching a declared output schema, alongside pretty-printed text for older clients.
- **Resources** — `compositor://state` (editor snapshot), `compositor://layers` (layer tree), `compositor://capabilities` (catalogue), `compositor://preview/latest` (PNG of the most recent render).
- **Prompts** — workflow recipes that expand into step-by-step guidance naming only implemented operations: `export-for-web`, `subject-cutout`, `retouch-pass`, `batch-variant`.

Where the client supports elicitation, destructive calls can confirm interactively; `confirmDestructive: true` remains the portable contract. Details in [docs/protocol.md](docs/protocol.md).

## Security model

- The native listener accepts **loopback peers only**.
- A fresh **256-bit bearer token** is generated on every app launch.
- Discovery and audit files are created with **owner-only permissions**; the Node side refuses discovery files readable by group/others.
- File reads and writes are constrained to **configured roots** after symlink resolution; the open project's directory is added automatically.
- **Destructive operations require explicit confirmation**; atomic batches roll back only the history entry they created.
- Optional owner-only **JSONL audit log** of every attempted operation.

See [docs/security.md](docs/security.md) for the threat model and known limitations.

## Requirements

- macOS 26
- Xcode 26
- Node.js 20.12 or newer
- A local checkout of [Compositor](https://github.com/robbietilton/Compositor)

The Swift integration was audited against upstream Compositor commit `a19db9011282399785dc18efcfded904627bdcc2`. The installer verifies the checkout's HEAD, warns clearly on drift, and records both SHAs in its install report — it fails only if the app delegate has moved beyond its supported patch points.

## Repository layout

```text
packages/protocol/       Typed capability catalogue, wire types and search
packages/mcp-server/     MCP stdio server, CLI (doctor/install-bridge/configure) and bridge client
compositor/Compositor/   Swift files installed into the Compositor app
compositor/patches/      Reviewable upstream app-delegate patch
scripts/                 Install, remove, configure, parity and doc-generation checks
docs/                    Architecture, security, protocol, generated capability reference and contributor docs
examples/                MCP client configurations and request examples
```

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) and the development guide in [docs/development.md](docs/development.md). Pull requests should pass `npm run check` and note the upstream Compositor commit used for native testing.

Quick development loop:

```bash
# Run without Compositor using the deterministic mock bridge
COMPOSITOR_MCP_MOCK=1 npm run dev

# Tests, type checking, parity and doc checks
npm run check
```

The mock is a behavioural harness, not a rendering emulator: it covers about 40 of the 62 operations (documents, layers, selections, painting, filters and previews) so the MCP surface, validation and batch semantics can be exercised without macOS.

## Validation status

The TypeScript projects build and type-check, all tests pass, the Swift sources pass parser validation, the capability parity check passes, and the installer/reinstaller/uninstaller smoke test runs in CI. A live AppKit/Xcode build and full bridge test on macOS 26 are tracked in [docs/release-validation.md](docs/release-validation.md).

## Uninstall from Compositor

```bash
npx -y compositor-mcp uninstall-bridge /absolute/path/to/Compositor
# or, from a source checkout:
./scripts/uninstall-from-compositor.sh /absolute/path/to/Compositor
```

## Licensing and trademarks

This integration is MIT-licensed. Compositor is a separate MIT-licensed project by Robbie Tilton. DaVinci Resolve and Blackmagic Design are referenced only as architectural inspiration; this project is not affiliated with or endorsed by Blackmagic Design. See [NOTICE](NOTICE.md).
