# Architecture

## Design goals

Compositor MCP is designed around five constraints:

1. Native fidelity: operations call Compositor's own model, renderer, project store and undo system.
2. Small model context: clients see `search` and `execute`, not one large MCP tool per editor command.
3. Progressive disclosure: `search` returns only relevant operation schemas.
4. Local-first security: the app bridge is loopback-only, authenticated and filesystem-constrained.
5. Parity without coupling the protocol to UI layout: capability names describe editor intent, not buttons or coordinates.

## Components

### Protocol package

`packages/protocol` is the source of truth for public operation names, descriptions, risk classes, implementation status, aliases, examples and JSON schemas. It has no MCP SDK dependency and can be reused by tests or future transports.

### MCP server

`packages/mcp-server` uses the stable v2 TypeScript SDK and serves stdio through `serveStdio`. It exposes:

- `search(query, limit, includeSchemas, includePlanned)`
- `execute(operations, atomic, dryRun, confirmDestructive, idempotencyKey)`

Both tools declare `outputSchema`s and return `structuredContent` alongside text, so typed clients can consume results without parsing prose. Beyond the tools, the server also serves:

- **Resources** — `compositor://state`, `compositor://layers`, `compositor://capabilities` and `compositor://preview/latest` give clients a read-only window onto editor state without paying for an `execute` round trip. The capabilities resource synthesises the catalogue server-side, filtered to the bridge's implemented list, so a stale app build can never over-advertise.
- **Prompts** — four workflow recipes (`export-for-web`, `subject-cutout`, `retouch-pass`, `batch-variant`) that expand into step-by-step guidance naming only implemented operations.
- **Elicitation** — clients advertising the capability get a one-shot `confirm` prompt for destructive batches; declining or cancelling fails the call with `confirmation_declined`. `confirmDestructive: true` remains the portable contract, and elicitation is a UX affordance rather than an authorization boundary.
- **CLI** — the same package ships `doctor`, `install-bridge`, `uninstall-bridge` and `configure` subcommands for setup and diagnostics.

The server performs fast catalogue-level validation before contacting the app.

### Local bridge protocol

The server reads `~/Library/Application Support/Compositor/MCP/bridge.json`, validates its ownership and mode, then opens a new loopback TCP connection per request. Requests and responses are single-line JSON terminated by `\n`.

The bridge protocol is deliberately private and versioned separately from MCP as `compositor-bridge/1`.

### Native command router

`CompositorMCPCommandRouter` runs on the main actor and maps stable public operation names to `ProjectWorkspace` and `EditorSession` methods. It is responsible for:

- editor-state preconditions;
- native transaction boundaries;
- destructive confirmation;
- filesystem authorisation;
- idempotency caching;
- audit records;
- app state snapshots and revision tracking.

## Transactions

An atomic batch containing only document-edit operations is wrapped in an outer `EditorSession.beginEdit/endEdit` transaction. Existing Compositor operations can keep their own nested transactions. If an operation fails, the router checks whether the batch created a new history entry before undoing it; this prevents accidentally undoing an older user edit.

File, workspace, preview and history operations are classified as non-transactional. They cannot be mixed into a multi-operation atomic batch.

## Revisions and external edits

The router maintains a monotonic bridge revision. Before and after requests it fingerprints the selected project, document, history, layer metadata, image identities and selection. This lets optimistic preconditions detect edits made directly in the Compositor UI as well as edits made through MCP.

## Adding an operation

1. Add the capability to `packages/protocol/src/capabilities.ts` with a stable name and strict schema.
2. Mark it `planned` until the app implementation exists.
3. Add it to the Swift router's implemented set and switch only when implementation is complete.
4. Prefer an existing `EditorSession` method over direct model mutation.
5. Make single operations undoable; ensure nested use is safe in a batch.
6. Add mock/test coverage and run `npm run parity`.
7. Update the parity document.
