# Capability parity

The goal is to expose every meaningful Compositor action through stable, typed MCP operations. The registry is intentionally ahead of the implementation so clients can discover roadmap status without mistaking planned work for available functionality.

## Current totals

- Implemented: 58
- Planned and schema-catalogued: 4
- Total: 62

The executable source of truth is [`packages/protocol/src/capabilities.ts`](../packages/protocol/src/capabilities.ts). `search` hides planned operations unless `includePlanned` is true, and `execute` rejects them.

## Implemented groups

| Area | Operations |
|---|---|
| App/workspace | Ping, inspect state, list/select open projects |
| Documents | Create, open, save, import images, PNG/JPEG export, flip canvas, canvas size, image size, crop |
| History | Undo, redo |
| Layers | List/select, blank, duplicate, rename, delete, visibility, opacity, blend mode, move, group, ungroup, merge, flip, transform, free distort |
| Masks | Add/delete, link/unlink, clipping masks, feather |
| Selection | Inspect, all/none/invert, from layer/mask, rectangle, ellipse, polygonal lasso, magic wand, expand/contract |
| Pixels | Fill, clear, invert |
| Painting/retouching | Brush/erase, spot heal, clone stamp, blur/smudge/liquify, gradient, shape layers |
| Preview | Full-resolution temporary PNG |

## Planned groups

| Area | Operations |
|---|---|
| Intelligent fill | Content-aware fill |
| Adjustments | Add/update adjustment layers |
| Filters | Apply supported filters and colour adjustments |

## Parity policy

An operation moves from `planned` to `implemented` only when:

1. the Swift router executes it through native Compositor logic;
2. arguments are validated on both sides;
3. it behaves correctly as a single operation and in an allowed batch;
4. its undo/destructive classification is verified;
5. tests cover normal and failure paths;
6. the parity check confirms the TypeScript and Swift registries agree.

UI-only behaviours such as panel placement or transient hover previews may be represented as state/configuration operations rather than pixel-coordinate automation.
