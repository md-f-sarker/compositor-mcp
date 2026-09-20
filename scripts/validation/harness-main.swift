import AppKit
import Foundation

@MainActor var bridge: CompositorMCPBridge?

MainActor.assumeIsolated {
    let workspace = ProjectWorkspace()
    bridge = CompositorMCPBridge(workspace: workspace)
    bridge?.start()
    FileHandle.standardError.write("harness: bridge started\n".data(using: .utf8)!)
}
dispatchMain()
