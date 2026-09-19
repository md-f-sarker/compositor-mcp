# Capability parity

The goal is to expose every meaningful Compositor action through stable, typed MCP operations. The registry is now fully implemented; new catalogue entries are marked `planned` until the app implementation exists so clients can discover roadmap status without mistaking planned work for available functionality.

## Current totals

- Implemented: 62
- Planned and schema-catalogued: 0
- Total: 62

The executable source of truth is [`packages/protocol/src/capabilities.ts`](../packages/protocol/src/capabilities.ts). Every catalogued operation is implemented; `search` returns the full catalogue by default.

## Implemented groups

| Area | Operations |
|---|---|
| App/workspace | Ping, inspect state, list/select open projects |
| Documents | Create, open, save, import images, PNG/JPEG export, flip canvas, canvas size, image size, crop |
| History | Undo, redo |
| Layers | List/select, blank, duplicate, rename, delete, visibility, opacity, blend mode, move, group, ungroup, merge, flip, transform, free distort |
| Masks | Add/delete, link/unlink, clipping masks, feather |
| Selection | Inspect, all/none/invert, from layer/mask, rectangle, ellipse, polygonal lasso, magic wand, expand/contract |
| Pixels | Fill, clear, invert, content-aware fill |
| Painting/retouching | Brush/erase, spot heal, clone stamp, blur/smudge/liquify, gradient, shape layers |
| Adjustments | Add/update adjustment layers (Hue/Saturation, Levels, Curves, Exposure, Gradient Map, Grain) |
| Filters | Apply supported filters and colour adjustments (blur, noise, lens correction, remove background, curves/exposure/gradient map/grain) |
| Preview | Full-resolution temporary PNG |

## Long-running operations

Content-aware fill and remove background run Compositor's full-size analysis/render and stay transactional — one undo step, rolled back as a unit in atomic batches. On large documents they can exceed the bridge's default 30 s response timeout; raise it with `COMPOSITOR_MCP_TIMEOUT_MS` on the MCP server process when needed.

## Parity policy

An operation moves from `planned` to `implemented` only when:

1. the Swift router executes it through native Compositor logic;
2. arguments are validated on both sides;
3. it behaves correctly as a single operation and in an allowed batch;
4. its undo/destructive classification is verified;
5. tests cover normal and failure paths;
6. the parity check confirms the TypeScript and Swift registries agree.

UI-only behaviours such as panel placement or transient hover previews may be represented as state/configuration operations rather than pixel-coordinate automation.
