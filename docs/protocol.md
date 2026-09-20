# Bridge protocol

The MCP-facing API is handled by the TypeScript SDK. This document describes the private protocol between the Node server and the native Compositor app.

## MCP surface

The server exposes exactly two tools — `search` and `execute` — plus resources and prompts. Everything below rides standard MCP; clients that never read resources or prompts lose nothing.

### Tools

| Tool | Purpose | Annotations |
| --- | --- | --- |
| `search` | Query the capability catalogue (names, risk, status, JSON schemas). | `readOnlyHint: true`, `idempotentHint: true` |
| `execute` | Run one or more typed operations with dry-run, atomic batches, preconditions, idempotency keys and destructive confirmation. | `destructiveHint: true`, `idempotentHint: false` (batches can mutate) |

Both tools declare an `outputSchema` and return `structuredContent` alongside the pretty-printed JSON `text` block, so older clients keep working unchanged:

- `search` → `{ query, count, results: [{ score, capability }], hint }`
- `execute` → the bridge envelope: `{ ok, results: [{ index, name, ok, value?, error? }], dryRun?, atomic?, rolledBack?, mutated?, revision?, state? }`

`execute` errors return `isError: true` with a text payload `{ ok: false, error: { code, message, details?, retryable? } }`.

### Resources

| URI | Content | Notes |
| --- | --- | --- |
| `compositor://state` | `application/json` | The same snapshot `app.getState` returns: projects, current document, layers, selection, revision. |
| `compositor://layers` | `application/json` | The current document's layer tree flattened out of the state snapshot. |
| `compositor://capabilities` | `application/json` | The full capability catalogue, synthesised server-side and filtered to the connected build's implemented list — a stale bridge can never over-advertise. |
| `compositor://preview/latest` | `image/png` blob | Bytes of the most recent successful `preview.render` this server session ran. Until the first render it answers with `text/plain` guidance instead. |

Resource reads that need the app (`state`, `layers`, `capabilities`) fail with a protocol error whose `data` carries the bridge error shape — `{ code: "bridge_not_running", retryable: true, ... }` when Compositor is not running.

### Prompts

Four workflow recipes render step-by-step guidance that names only implemented operations: `export-for-web` (resize → export PNG + JPEG), `subject-cutout` (remove background → new layer → refine mask), `retouch-pass` (selection → spot heal / clone / content-aware fill), and `batch-variant` (duplicate → adjust → export). Each accepts optional string arguments to tailor the recipe.

### Inline previews and destructive confirmation

When `preview.render` succeeds, the server reads the PNG the app wrote under `<tmp>/Compositor-MCP/` (owner-only, loopback-only deployment — other paths are refused), caches the bytes for `compositor://preview/latest`, and inlines an `image/png` content block in the execute result when the file is ≤ 1 MiB. Larger renders keep the path-only result.

Destructive operations require `confirmDestructive: true` — the portable contract every client supports. The confirmation gate runs *before* per-operation argument validation: a batch that needs confirmation never reports schema errors first. When the client advertises elicitation, `execute` instead asks once via `elicitation/create` (form mode, `confirm` boolean): accepting runs the batch, declining or cancelling fails it with `confirmation_declined`. Clients without elicitation keep the `confirmation_required` tool error unchanged. Elicitation is a UX affordance, not an authorization boundary — the client can always set the flag itself. The `confirmation_required` payload carries `details.operations` (the renamed `destructiveOperations` field), matching the key the bridge emits.

## Discovery

Path:

```text
~/Library/Application Support/Compositor/MCP/bridge.json
```

Example:

```json
{
  "protocol": "compositor-bridge/1",
  "host": "127.0.0.1",
  "port": 49152,
  "token": "base64-encoded-random-token",
  "pid": 12345,
  "startedAt": "2026-09-19T10:00:00Z",
  "appVersion": "0.1.0"
}
```

## Framing

Each TCP connection carries exactly one UTF-8 JSON request followed by LF. The app returns exactly one JSON response followed by LF and closes the connection.

## Request

```json
{
  "protocol": "compositor-bridge/1",
  "id": "request-uuid",
  "token": "token-from-discovery",
  "method": "execute",
  "params": {}
}
```

Methods:

- `ping`
- `state`
- `capabilities`
- `execute`

## Execute parameters

```json
{
  "operations": [
    {
      "name": "layer.setOpacity",
      "arguments": { "layerId": "active", "opacity": 0.5 },
      "precondition": {
        "projectId": "current",
        "documentId": "optional-document-uuid",
        "revision": 12
      }
    }
  ],
  "atomic": true,
  "dryRun": false,
  "confirmDestructive": false,
  "idempotencyKey": "client-generated-key"
}
```

## Response

Success:

```json
{
  "protocol": "compositor-bridge/1",
  "id": "request-uuid",
  "ok": true,
  "result": {}
}
```

Failure:

```json
{
  "protocol": "compositor-bridge/1",
  "id": "request-uuid",
  "ok": false,
  "error": {
    "code": "confirmation_required",
    "message": "Destructive operations require confirmDestructive: true.",
    "retryable": false,
    "details": {}
  }
}
```

Wire compatibility is governed by the exact `protocol` value. Additive result fields are allowed within a protocol version. Breaking request/framing/authentication changes require a new bridge version.
