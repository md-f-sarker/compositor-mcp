# Proposal: an official MCP bridge entry point in Compositor

> Status: **draft, not yet filed.** This is a ready-to-submit issue for
> [`robbietilton/Compositor`](https://github.com/robbietilton/Compositor).
> Recommended timing: file after live macOS validation lands (see
> `docs/release-validation.md`) so the proposal carries "verified working on
> commit `<sha>`" evidence. The integration below was developed and audited
> against upstream commit `7e9afbe8559d2b74100bc57a36db1302e91ceed8`.
>
> When filing, paste everything below the rule into the GitHub issue body.

---

**Title:** Provide an official entry point for a local MCP (Model Context Protocol) bridge

## Summary

I maintain [compositor-mcp-server](https://github.com/md-f-sarker/compositor-mcp), an
open-source MCP server that gives AI assistants native control of
Compositor — every editing operation runs through `ProjectWorkspace`,
`EditorSession` and the normal undo pipeline rather than UI automation, so
agent-driven edits are indistinguishable from hand-made ones (single named undo
entries, live rendering, correct transactional semantics).

Today the integration installs its Swift sources into `Compositor/MCP` (picked
up cleanly by the file-system-synchronised Xcode group) and then must **patch
`CompositorApplicationDelegate.swift` by string-anchored insertion** to start
and stop the bridge. That works, but it is fragile: any refactor of the
delegate breaks the anchors, and every downstream install carries a patch step
that can silently drift from upstream.

I would like to propose — and am happy to implement — a small, officially
supported hook so external bridges can attach without patching.

## What the bridge does

`CompositorMCPBridge` is a self-contained additive component (new files only):

- Listens on a **loopback-only** TCP socket with a fresh per-launch 256-bit
  bearer token; writes a `bridge.json` discovery file (mode `0600`) under
  `~/Library/Application Support/Compositor/MCP`.
- Routes authenticated JSON requests to a command router that calls
  `EditorSession` / `ProjectWorkspace` primitives — the same code paths the UI
  uses — so every operation is undoable and transactionally grouped.
- Enforces a filesystem allowlist, destructive-operation confirmation and an
  owner-only audit log.
- It is entirely opt-in and inert when not started; nothing changes for users
  who never install the companion package.

## What is needed from Compositor

Three insertion points in `CompositorApplicationDelegate` are all the bridge
needs. The patch currently produces:

```swift
final class CompositorApplicationDelegate: NSObject, NSApplicationDelegate {
    let workspace = ProjectWorkspace()
    private var mcpBridge: CompositorMCPBridge?   // 1. field declaration
    // ...

    func applicationDidFinishLaunching(_ notification: Notification) {
        // 2. start
        let bridge = CompositorMCPBridge(workspace: workspace)
        mcpBridge = bridge
        bridge.start()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [updater] in updater.startUpdater() }
    }

    // 3. stop
    func applicationWillTerminate(_ notification: Notification) {
        mcpBridge?.stop()
    }
}
```

Any of these shapes would remove the patch requirement:

1. **Minimal:** ship the `Compositor/MCP` sources behind a build flag or
   feature setting, with the three delegate lines above committed upstream.
   Disabled by default; zero surface for non-users.
2. **Generic:** a small `ApplicationService` protocol —
   `start(workspace:)` / `stop()` — iterated in
   `applicationDidFinishLaunching` / `applicationWillTerminate`, so any
   companion service (MCP bridge, future automation surfaces) registers
   without further delegate edits.
3. **Alternative welcome:** if you would rather expose lifecycle callbacks or
   a different seam (e.g. on `ProjectWorkspace` itself), the bridge only needs
   a `ProjectWorkspace` at launch and a stop notification at termination.

## Why a hook helps

- **No patch fragility:** string anchors break on unrelated delegate
  refactors; an official seam makes the integration durable across releases.
- **Reviewable security surface:** the bridge's loopback/token/filesystem
  policy can be audited once upstream instead of living in a downstream patch.
- **Growing ecosystem:** MCP is becoming the standard way assistants drive
  desktop apps (major creative tools already ship native MCP servers). A supported
  entry point positions Compositor for agentic workflows without committing to
  any particular server implementation.

## Offer

I am happy to submit a PR implementing whichever shape you prefer, including
the bridge sources (MIT-licensed, ~7 files), tests, and documentation. If you
would rather keep Compositor core free of MCP-specific code, option 2's
generic service protocol is the smallest commitment.

For reference, the working integration (installer, patch, Swift sources and
the MCP server) is at <https://github.com/md-f-sarker/compositor-mcp> —
verified against upstream commit
`7e9afbe8559d2b74100bc57a36db1302e91ceed8`.
