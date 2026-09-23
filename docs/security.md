# Security

## Trust boundaries

The MCP client and Node server run as the signed-in macOS user. The Compositor app exposes a local command bridge to that user's processes. This project does not attempt to defend against a fully compromised user account; it limits accidental exposure, confused-deputy behaviour and untrusted network access.

## Controls

### Network and authentication

The listener rejects non-loopback endpoints. A fresh 32-byte token is generated with `SecRandomCopyBytes` on every app launch. The token is required on each request and compared without early exit. Requests are limited to 8 MiB and one request is accepted per connection.

Resource exhaustion is bounded: at most 32 connections may be streaming requests at once, a connection that has not completed a request within 30 seconds is dropped, the serial work queue holds at most 64 requests, and depth/decode/token checks run *before* a request is admitted to the queue — unauthenticated payloads never occupy editing capacity.

### Discovery file

The app writes `bridge.json` under `~/Library/Application Support/Compositor/MCP` with directory mode `0700` and file mode `0600`. The Node server verifies that the discovery path is a regular file, is owned by the current user and has no group/other permission bits. It also rejects non-loopback hosts from the discovery document.

### Filesystem policy

`config.json` contains explicit allowed root directories. File paths must be absolute. The app expands `~`, standardises paths and resolves symlinks before checking containment. For a not-yet-created output, it resolves the parent and then appends the final component. The directory of the currently open project is allowed automatically.

A minimal configuration is:

```json
{
  "enabled": true,
  "allowedRoots": ["/Users/example/Pictures"],
  "auditLogging": true
}
```

### Editing safety

Capabilities are labelled `read`, `write`, `filesystem` or `destructive`. Destructive operations are rejected unless the caller explicitly sets `confirmDestructive: true`; dry runs do not require confirmation. Atomic batches cannot include non-transactional operations. Optimistic preconditions can bind a request to project ID, document ID and revision.

### Audit trail

When enabled, the app writes one JSON object per attempted operation to `audit.jsonl`. The log includes timestamp, request ID, operation name, result and compact error details. It never records the bridge token.

### Preview path pinning

`preview.render` returns a path the server then reads back for inline previews and the `compositor://preview/latest` resource. To stop a compromised or buggy bridge turning that into an arbitrary-file oracle, the server only reads paths pinned to the preview convention — `<tmp>/Compositor-MCP/preview-*.png` — and verifies the PNG signature plus a hard size cap (1 MiB for inlining, 16 MiB for the resource) on the opened file. Any other path is ignored.

### Elicitation is UX, not authorization

When a client advertises elicitation, destructive batches ask once via `elicitation/create` before running. This is a convenience layer only: the same client can always set `confirmDestructive: true` itself, so an accepted prompt grants nothing the flag would not. Declines and cancels fail the batch with `confirmation_declined`; clients without elicitation keep the plain `confirmation_required` error.

### Request timeouts

Each bridge request is bounded by a timeout (default 30 s, `COMPOSITOR_MCP_TIMEOUT_MS` on the server process). A `bridge_timeout` means the server *abandoned* the request — the app may still complete the operation in the background. Because a timed-out mutation is indeterminate, retry it with the same `idempotencyKey` rather than resending blindly: the bridge deduplicates on the key.

## Known limitations

- Any process running as the same macOS user can normally read that user's mode-0600 files and can therefore use the bridge while Compositor is running. Use a separate OS account for stronger isolation.
- The bridge is not suitable for remote exposure. Do not forward its port or replace the discovery host with a non-loopback address.
- Capability-level permission profiles are not implemented in v0.1. File roots and destructive confirmation are the current authorisation boundaries.
- Audit logging is best-effort so an unavailable log file does not corrupt an editing operation.
- A malicious MCP client can ask for expensive valid work. Request and response limits reduce memory abuse, but CPU/GPU quotas are not implemented.

## Reporting a vulnerability

Do not open a public issue while the repository is private or before coordinated disclosure. Follow [`SECURITY.md`](../SECURITY.md).
