---
name: testing-compositor-mcp-real-bridge
description: How to end-to-end test the compositor-mcp bridge against the real Compositor macOS app (not the mock) — clone upstream, pin the audited commit, build unsandboxed with xcodebuild, configure roots before launching, drive MCP over stdio.
---

# Testing compositor-mcp against the real Compositor app

The repo's MCP server normally runs against a mock bridge in dev. To test REAL editing, the Node server must run without `COMPOSITOR_MCP_MOCK` and talk to a live Compositor build via the Swift bridge.

## Devin Secrets Needed

None. Everything is local.

## Steps

1. **Build the Node server**: `npm install && npm run build` at repo root, or `npm run build -w compositor-mcp-server`. Verify `packages/mcp-server/dist/index.js` exists and is newer than `src/`.

2. **Clone upstream at the AUDITED commit** — HEAD drifts and may not compile (e.g. enum cases added to AdjustmentKind/FilterKind break the bridge's exhaustive switches). The audited SHA is pinned in `scripts/install-into-compositor.sh` (`AUDITED_UPSTREAM_SHA`):
   ```bash
   git clone https://github.com/robbietilton/Compositor ~/repos/Compositor
   cd ~/repos/Compositor && git fetch origin <AUDITED_SHA> && git checkout <AUDITED_SHA>
   ```

3. **Install the bridge**: `./scripts/install-into-compositor.sh /path/to/Compositor` — copies `compositor/Compositor/MCP/*.swift` and string-anchors a patch into `CompositorApplicationDelegate.swift`.

4. **Build UNSANDBOXED** — a stock Debug/Release build is sandboxed and the bridge's NWListener cannot bind (no `com.apple.security.network.server`), plus the sandbox writes `bridge.json` inside the app container where the Node side never looks. Override the capability build settings:
   ```bash
   xcodebuild -project Compositor.xcodeproj -scheme Compositor -configuration Debug \
     -derivedDataPath ~/comp-dd \
     CODE_SIGN_ENTITLEMENTS= ENABLE_APP_SANDBOX=NO ENABLE_USER_SELECTED_FILES=none \
     ENABLE_OUTGOING_NETWORK_CONNECTIONS=NO ENABLE_HARDENED_RUNTIME=NO build
   ```
   `CODE_SIGN_ENTITLEMENTS=` alone is NOT enough — Xcode's `ENABLE_*` capability settings re-inject app-sandbox/network entitlements at sign time. Verify with `codesign -d --entitlements :- <app>` — should show only `get-task-allow`.

5. **Configure authorized roots BEFORE launching the app** — the bridge reads `config.json` once at startup:
   ```bash
   node packages/mcp-server/dist/index.js configure /path/to/test-assets
   ```
   If file ops return "outside the MCP authorised roots" even though `doctor` shows the root, the app launched before configure ran — quit (mind unsaved-changes dialogs) and relaunch.

6. **Launch + verify**: `open ~/comp-dd/Build/Products/Debug/Compositor.app` → `~/Library/Application Support/Compositor/MCP/bridge.json` appears (mode 0600, host 127.0.0.1). `node dist/index.js doctor` should report bridge reachable + capability count.

7. **Drive MCP over stdio**: spawn `node packages/mcp-server/dist/index.js` (NO `COMPOSITOR_MCP_MOCK`), newline-delimited JSON-RPC. A reusable harness exists at `/Users/devin/stress/mcp-client.mjs` (`McpProbe`: `handshake()`, `request()`, `callTool()`).
   - Prove it's the REAL bridge: `app.ping` returns `processId` — must equal `bridge.json`'s `pid`.
   - Execute shape: `{operations: [{name, arguments}], atomic, dryRun, confirmDestructive, idempotencyKey}`.
   - Destructive ops (document.crop, layer.delete…) need `confirmDestructive: true`.
   - File ops (importImages/export/document.open) are non-transactional → use `atomic: false` in mixed batches.
   - Op names/schemas: `docs/capabilities.md` or `search` tool; e.g. `document.create{width,height}`, `paint.brushStroke{points[{x,y}],color}`, `paint.shape{kind,x,y,width,height,color}`, `adjustment.add{kind:"Exposure",parameters{exposure,gamma}}`, `document.crop{x,y,width,height}`, `document.export{path,format}`.

8. **Quit the app between runs** via `osascript -e 'quit app "Compositor"'` — watch for "Save changes?" dialogs that block quitting (click "Don't Save").

## Gotchas

- macOS 26 + Xcode 26 required (Sparkle SPM dep auto-resolves on first xcodebuild).
- `audit.jsonl` in the MCP dir logs every attempted op — good evidence.
- `preview.render` returns an inline `image/png` content block.
- The welcome "New canvas" screen is not a document — `document.create` via MCP creates a real doc without touching that form.
