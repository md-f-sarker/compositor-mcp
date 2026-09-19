# Bridge protocol

The MCP-facing API is handled by the TypeScript SDK. This document describes the private protocol between the Node server and the native Compositor app.

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
