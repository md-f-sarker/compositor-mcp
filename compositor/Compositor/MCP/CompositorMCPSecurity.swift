import Foundation
import Security

struct CompositorMCPDiscovery: Codable, Sendable {
    let protocolVersion = "compositor-bridge/1"
    let host: String
    let port: UInt16
    let token: String
    let pid: Int32
    let startedAt: Date
    let appVersion: String?

    enum CodingKeys: String, CodingKey {
        case protocolVersion = "protocol"
        case host, port, token, pid, startedAt, appVersion
    }
}

enum CompositorMCPRuntimeFiles {
    static var directory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return base.appendingPathComponent("Compositor", isDirectory: true)
            .appendingPathComponent("MCP", isDirectory: true)
    }

    static var discovery: URL { directory.appendingPathComponent("bridge.json") }
    static var configuration: URL { directory.appendingPathComponent("config.json") }
    static var auditLog: URL { directory.appendingPathComponent("audit.jsonl") }

    static func ensureDirectory() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
    }

    static func writeDiscovery(_ value: CompositorMCPDiscovery) throws {
        try ensureDirectory()
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        let data = try encoder.encode(value)
        let temporary = directory.appendingPathComponent("bridge-\(UUID().uuidString).tmp")
        try data.write(to: temporary, options: [.atomic])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: temporary.path)
        _ = try? FileManager.default.removeItem(at: discovery)
        try FileManager.default.moveItem(at: temporary, to: discovery)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: discovery.path)
    }

    static func removeDiscovery(matching token: String) {
        guard let data = try? Data(contentsOf: discovery),
              let current = try? JSONDecoder.iso8601.decode(CompositorMCPDiscovery.self, from: data),
              current.token == token else { return }
        try? FileManager.default.removeItem(at: discovery)
    }

    static func randomToken() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = bytes.withUnsafeMutableBytes { buffer -> OSStatus in
            guard let address = buffer.baseAddress else { return errSecParam }
            return SecRandomCopyBytes(kSecRandomDefault, buffer.count, address)
        }
        guard status == errSecSuccess else {
            throw CompositorMCPCommandError(code: "token_generation_failed", message: "Could not generate a secure MCP bridge token.")
        }
        return Data(bytes).base64EncodedString()
    }
}

private extension JSONDecoder {
    static var iso8601: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}

struct CompositorMCPConfiguration: Codable, Sendable {
    var enabled: Bool
    var allowedRoots: [String]
    var auditLogging: Bool

    init(enabled: Bool = true, allowedRoots: [String] = [], auditLogging: Bool = true) {
        self.enabled = enabled
        self.allowedRoots = allowedRoots
        self.auditLogging = auditLogging
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        enabled = try values.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
        allowedRoots = try values.decodeIfPresent([String].self, forKey: .allowedRoots) ?? []
        auditLogging = try values.decodeIfPresent(Bool.self, forKey: .auditLogging) ?? true
    }

    static func load() -> Self {
        guard let data = try? Data(contentsOf: CompositorMCPRuntimeFiles.configuration),
              let value = try? JSONDecoder().decode(Self.self, from: data) else { return Self() }
        return value
    }
}

/// The bridge never grants arbitrary filesystem access. Read and write operations must stay inside
/// explicitly configured roots, with the current project's directory added automatically.
@MainActor
final class CompositorMCPPathPolicy {
    private let workspace: ProjectWorkspace
    private(set) var configuration = CompositorMCPConfiguration()

    init(workspace: ProjectWorkspace) {
        self.workspace = workspace
        reload()
    }

    func reload() {
        configuration = CompositorMCPConfiguration.load()
    }

    func authorise(_ suppliedPath: String, forWrite: Bool) throws -> URL {
        guard suppliedPath.hasPrefix("/") || suppliedPath.hasPrefix("~") else {
            throw CompositorMCPCommandError.invalid("File paths must be absolute.")
        }
        let expanded = NSString(string: suppliedPath).expandingTildeInPath
        let candidate = URL(fileURLWithPath: expanded).standardizedFileURL
        let canonical = canonicalURL(candidate, forWrite: forWrite)
        let roots = allowedRootURLs()
        guard roots.contains(where: { isInside(canonical, root: $0) }) else {
            throw CompositorMCPCommandError(
                code: "filesystem_denied",
                message: "The requested path is outside the MCP authorised roots.",
                details: .object([
                    "path": .string(canonical.path),
                    "configuration": .string(CompositorMCPRuntimeFiles.configuration.path)
                ])
            )
        }
        return canonical
    }

    private func allowedRootURLs() -> [URL] {
        var paths = configuration.allowedRoots
        if let project = workspace.current.session.projectURL {
            paths.append(project.deletingLastPathComponent().path)
        }
        return Array(Set(paths.map { NSString(string: $0).expandingTildeInPath }))
            .map { URL(fileURLWithPath: $0, isDirectory: true).standardizedFileURL.resolvingSymlinksInPath() }
    }

    private func canonicalURL(_ value: URL, forWrite: Bool) -> URL {
        if !forWrite || FileManager.default.fileExists(atPath: value.path) {
            return value.resolvingSymlinksInPath()
        }
        let parent = value.deletingLastPathComponent().resolvingSymlinksInPath()
        return parent.appendingPathComponent(value.lastPathComponent).standardizedFileURL
    }

    private func isInside(_ candidate: URL, root: URL) -> Bool {
        let candidatePath = candidate.standardizedFileURL.path
        let rootPath = root.standardizedFileURL.path
        return candidatePath == rootPath || candidatePath.hasPrefix(rootPath.hasSuffix("/") ? rootPath : rootPath + "/")
    }
}

actor CompositorMCPAuditLog {
    static let shared = CompositorMCPAuditLog()

    func append(requestId: String, operation: String, ok: Bool, details: [String: CompositorMCPJSON] = [:]) async {
        let record: CompositorMCPJSON = .object([
            "timestamp": .string(ISO8601DateFormatter().string(from: Date())),
            "requestId": .string(requestId),
            "operation": .string(operation),
            "ok": .bool(ok),
            "details": .object(details)
        ])
        guard let data = try? JSONEncoder().encode(record), var line = String(data: data, encoding: .utf8) else { return }
        line.append("\n")
        do {
            try CompositorMCPRuntimeFiles.ensureDirectory()
            if !FileManager.default.fileExists(atPath: CompositorMCPRuntimeFiles.auditLog.path) {
                try Data().write(to: CompositorMCPRuntimeFiles.auditLog)
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: CompositorMCPRuntimeFiles.auditLog.path)
            }
            let handle = try FileHandle(forWritingTo: CompositorMCPRuntimeFiles.auditLog)
            try handle.seekToEnd()
            try handle.write(contentsOf: Data(line.utf8))
            try handle.close()
        } catch {
            // Auditing must never break editing. A future UI can surface audit-write failures.
        }
    }
}
