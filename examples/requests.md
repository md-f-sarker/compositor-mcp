# Request examples

These are arguments to the MCP tools, not raw bridge requests.

Connect the server with `npx -y compositor-mcp-server` (see
[`mcp-client-config.json`](mcp-client-config.json) and
[`codex-config.toml`](codex-config.toml) for client stanzas, including a
development-checkout variant), then send the arguments below to the `search`
and `execute` tools.

## Discover an operation

```json
{
  "query": "export the current image as a high quality jpeg",
  "limit": 5,
  "includeSchemas": true
}
```

## Inspect state

```json
{
  "operations": [
    { "name": "app.getState", "arguments": { "includeLayers": true } }
  ]
}
```

## Create and prepare a document atomically

File/workspace operations are non-transactional, so document creation is a separate call:

```json
{
  "operations": [
    { "name": "document.create", "arguments": { "width": 1600, "height": 900, "resolution": 72 } }
  ]
}
```

Then run native edits as one undo step:

```json
{
  "atomic": true,
  "idempotencyKey": "hero-setup-2026-09-19",
  "operations": [
    { "name": "layer.addBlank", "arguments": { "name": "Retouch" } },
    { "name": "layer.setOpacity", "arguments": { "layerId": "active", "opacity": 0.65 } },
    { "name": "layer.setBlendMode", "arguments": { "layerId": "active", "blendMode": "Overlay" } }
  ]
}
```

## Optimistic precondition

Read the current state, then attach its IDs/revision:

```json
{
  "operations": [
    {
      "name": "layer.rename",
      "arguments": { "layerId": "active", "name": "Approved retouch" },
      "precondition": {
        "projectId": "current",
        "documentId": "DOCUMENT_UUID_FROM_STATE",
        "revision": 7
      }
    }
  ]
}
```

## Export

```json
{
  "atomic": false,
  "operations": [
    {
      "name": "document.export",
      "arguments": {
        "path": "/Users/example/Pictures/final.jpg",
        "format": "jpeg",
        "quality": 0.92,
        "background": "#FFFFFF"
      }
    }
  ]
}
```
