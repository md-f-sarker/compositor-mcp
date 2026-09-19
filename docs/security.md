# Security

## Trust boundaries

The MCP client and Node server run as the signed-in macOS user. The Compositor app exposes a local command bridge to that user's processes. This project does not attempt to defend against a fully compromised user account; it limits accidental exposure, confused-deputy behaviour and untrusted network access.

## Controls

### Network and authentication

The listener rejects non-loopback endpoints. A fresh 32-byte token is generated with `SecRandomCopyBytes` on every app launch. The token is required on each request and compared without early exit. Requests are limited to 8 MiB and one request is accepted per connection.

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

## Known limitations

- Any process running as the same macOS user can normally read that user's mode-0600 files and can therefore use the bridge while Compositor is running. Use a separate OS account for stronger isolation.
- The bridge is not suitable for remote exposure. Do not forward its port or replace the discovery host with a non-loopback address.
- Capability-level permission profiles are not implemented in v0.1. File roots and destructive confirmation are the current authorisation boundaries.
- Audit logging is best-effort so an unavailable log file does not corrupt an editing operation.
- A malicious MCP client can ask for expensive valid work. Request and response limits reduce memory abuse, but CPU/GPU quotas are not implemented.

## Reporting a vulnerability

Do not open a public issue while the repository is private or before coordinated disclosure. Follow [`SECURITY.md`](../SECURITY.md).
