# Compositor MCP

[![CI](https://github.com/md-f-sarker/compositor-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/md-f-sarker/compositor-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Model Context Protocol control of [Compositor](https://github.com/robbietilton/Compositor), the native macOS image editor.**

**Status: public beta** — the bridge is exercised against upstream Compositor `75c4219` on macOS 26; interfaces may still evolve.

> **npm publication pending.** The source is available, but `compositor-mcp-server` has not yet been published to npm. Use the source-install instructions below; the npm quickstart and badge will be added after registry publication is verified.

Compositor MCP gives AI assistants — Claude Code, Claude Desktop, Codex, or any MCP client — real, native editing power: all **62 catalogued operations implemented** and running through Compositor's own document model, renderer and undo history. No pixel clicking, no UI automation — the same code paths the app itself uses, exposed as typed, composable operations.

## What it does

You describe the edit in natural language; the assistant plans and executes it as native operations against the live document:

> **You:** "Cut out the subject, put it on its own layer and export a transparent PNG for the web."
>
> **Assistant:** selects the subject layer → runs `filter.apply` *Remove Background* → refines the mask edge → renders a preview to check the cutout → exports `hero.png` with alpha. Editing operations use Compositor's native history; exports write separate files and cannot be undone through editor history.

Or: *"Retouch a blemish in this portrait,"* *"resize this to 1600px wide and export PNG + JPEG,"* *"duplicate the layer, grade it warm, and save a variant"* — end-to-end tasks, not single clicks.

The surface stays small: a `search` tool finds the right operation and returns only its schema, an `execute` tool runs operations singly or as an atomic all-or-nothing batch, MCP resources expose live editor state and rendered previews, and workflow prompts package complete recipes for common jobs.

## Quickstart — install from source

You need macOS 26, Xcode 26, Node.js 22 or newer, Git, and a local Compositor source checkout. A stock Compositor app without the native bridge is not sufficient.

### 1. Build the MCP server

```bash
git clone https://github.com/md-f-sarker/compositor-mcp.git
cd compositor-mcp
npm ci
npm run build
npm run check
```

Keep this checkout: your MCP client will run its compiled server. Use the absolute path to `packages/mcp-server/dist/index.js` in the next step.

### 2. Add the server to your MCP client

Replace `/absolute/path/to/compositor-mcp` with the checkout directory from step 1:

```json
{
  "mcpServers": {
    "compositor": {
      "command": "node",
      "args": ["/absolute/path/to/compositor-mcp/packages/mcp-server/dist/index.js"]
    }
  }
}
```

- **Claude Code:** `claude mcp add compositor -- node /absolute/path/to/compositor-mcp/packages/mcp-server/dist/index.js`
- **Claude Desktop / other clients:** merge the JSON stanza above into the client's MCP configuration.
- If a desktop client cannot find `node`, replace `"node"` with the absolute executable path returned by `command -v node` in your terminal.

### 3. Install the native bridge and authorise filesystem roots

Use a dedicated Compositor development checkout. The tested upstream commit is `75c421980ad2d289ea8244c54cfa3a649678d259`.

> **Development-build security notice:** `install-bridge` disables App Sandbox and clears the configured entitlements in the affected build settings — the bridge's loopback listener and authorised-root file access do not work with the stock sandboxed configuration. Original values are recorded in `.compositor-mcp-install-state.json`, and `uninstall-bridge` restores the recorded settings where they have not subsequently been edited. Work on copies of important images and use a dedicated development checkout.

From the `compositor-mcp` directory:

```bash
node packages/mcp-server/dist/index.js install-bridge /absolute/path/to/Compositor
node packages/mcp-server/dist/index.js configure "$HOME/Pictures" "$HOME/Downloads"
```

Then open `Compositor.xcodeproj`, build and run the **Compositor** scheme once (Xcode file-system-synchronised groups pick up the new `Compositor/MCP` files automatically). Restart Compositor after changing configuration — file operations are denied outside the authorised roots.

### 4. Verify the setup

From the `compositor-mcp` directory, with the patched Compositor application running:

```bash
node packages/mcp-server/dist/index.js doctor
```

`doctor` checks the bridge discovery file, pings the running app, and reports the app version, protocol, implemented capability count, revision and authorised roots.

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

Two tools, plus resources and prompts — the catalogue scales underneath, not the tool list. Think of it as a typed, undoable editing API, not screenshots and synthetic clicks:

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

The bridge connection is local to your Mac. Rendered previews and document state are returned **to your MCP client**, which may send them to a remote model provider. Local bridge transport does not guarantee local-only image processing; check your client's configuration and your model provider's data policy before using private images.

See [docs/security.md](docs/security.md) for the threat model and known limitations, and [SECURITY.md](SECURITY.md) for private vulnerability reporting.

## Requirements

- macOS 26
- Xcode 26
- Node.js 22 or newer
- A local checkout of [Compositor](https://github.com/robbietilton/Compositor)
- An MCP client that speaks stdio JSON-RPC — tested with Claude Code, Claude Desktop and Codex; any client on MCP protocol revisions supported by the TypeScript SDK works.

The Swift integration was audited against upstream Compositor commit `75c421980ad2d289ea8244c54cfa3a649678d259`. The installer verifies the checkout's HEAD, warns clearly on drift, and records both SHAs in its install report. A cleanly applied patch on a newer upstream revision does not guarantee that the application will compile or behave identically.

## Known limits

- A single inbound JSON-RPC message over **10 MiB** kills the server process — a hard cap in the stock TypeScript SDK's stdio buffer, not a Compositor limit. Keep tool calls carrying large inline payloads under it.
- An in-progress interactive edit in the app (transform, crop, gradient, filter, lasso or selection move) blocks mutating operations with `pending_edit` — commit or cancel it in the app first.
- Atomic batches roll back editor history only. Filesystem writes (exports, preview renders) and other non-transactional operations cannot roll back — send them in `atomic: false` batches.
- The mock bridge is a behavioural harness (~40 of 62 operations), not a renderer: state, validation and batch semantics are real; pixels are not. Idempotent replay is keyed on the entire request — reuse a key with different arguments and it is an `idempotency_conflict`, not a replay.
- Canvas and layer bounds follow Compositor's own caps: 30,000 px per side, 100 megapixels per canvas, 10,000 layers.

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

After the source-install steps above, the development loop is:

```bash
# Run without Compositor using the deterministic mock bridge
COMPOSITOR_MCP_MOCK=1 npm run dev

# Tests, type checking, parity and doc checks
npm run check
```

The mock is a behavioural harness, not a rendering emulator: it covers about 40 of the 62 operations (documents, layers, selections, painting, filters and previews) so the MCP surface, validation and batch semantics can be exercised without macOS.

## Validation status

CI checks the TypeScript build and types, protocol/server tests, capability parity, generated documentation, installer/reinstaller/uninstaller behaviour and the standalone npm tarball. The release preflight workflow additionally scans fetched Git and pull-request history for secrets.

Native validation records, including the real application build and bridge checks on macOS 26, are in [docs/release-validation.md](docs/release-validation.md). The Ubuntu CI jobs do not replace a native Xcode build or visual testing of edited images.

## Uninstall from Compositor

From the `compositor-mcp` directory:

```bash
node packages/mcp-server/dist/index.js uninstall-bridge /absolute/path/to/Compositor
# Alternatively:
./scripts/uninstall-from-compositor.sh /absolute/path/to/Compositor
```

Rebuild Compositor after uninstalling the bridge, and remove its entry from your MCP client's configuration if it is no longer needed.

## Licensing

This integration is MIT-licensed. Compositor is a separate MIT-licensed project by Robbie Tilton — full attribution in [NOTICE](NOTICE.md).
