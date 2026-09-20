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
        // The UUID name means nothing reads the temp file mid-write. The chmod must
        // precede the rename so bridge.json never exists with looser permissions.
        try data.write(to: temporary)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: temporary.path)
        // rename(2) atomically replaces bridge.json; removeItem+moveItem left a
        // window where no discovery file existed for clients to find.
        guard rename(temporary.path, discovery.path) == 0 else {
            let code = errno
            _ = try? FileManager.default.removeItem(at: temporary)
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(code),
                          userInfo: [NSLocalizedDescriptionKey: String(cString: strerror(code))])
        }
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

    /// Missing config means "never configured" and keeps the defaults. A config that
    /// exists but cannot be decoded or read fails closed — silently applying defaults
    /// would re-enable a bridge the user disabled.
    static func load() -> Self {
        do {
            let data = try Data(contentsOf: CompositorMCPRuntimeFiles.configuration)
            do {
                return try JSONDecoder().decode(Self.self, from: data)
            } catch {
                NSLog("Compositor MCP configuration is corrupt; disabling the bridge: %@", error.localizedDescription)
                return Self(enabled: false)
            }
        } catch let error as NSError {
            if error.domain == NSCocoaErrorDomain && error.code == NSFileReadNoSuchFileError {
                return Self()
            }
            if let underlying = error.userInfo[NSUnderlyingErrorKey] as? NSError,
               underlying.domain == NSPOSIXErrorDomain && underlying.code == Int(ENOENT) {
                return Self()
            }
            NSLog("Compositor MCP configuration could not be read; disabling the bridge: %@", error.localizedDescription)
            return Self(enabled: false)
        }
    }
}

/// The bridge never grants arbitrary filesystem access. Read and write operations must stay inside
/// explicitly configured roots, with the current project's directory added automatically.
@MainActor
final class CompositorMCPPathPolicy {
    private let workspace: ProjectWorkspace
    private(set) var configuration = CompositorMCPConfiguration()
    /// `allowedRoots` expanded, deduplicated and symlink-resolved once per reload; the
    /// current project's directory is still appended per call in `allowedRootURLs`.
    private var configuredRoots: [URL] = []

    init(workspace: ProjectWorkspace) {
        self.workspace = workspace
        reload()
    }

    func reload() {
        configuration = CompositorMCPConfiguration.load()
        configuredRoots = Array(Set(configuration.allowedRoots.map { NSString(string: $0).expandingTildeInPath }))
            .map { URL(fileURLWithPath: $0, isDirectory: true).standardizedFileURL.resolvingSymlinksInPath() }
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
        var roots = configuredRoots
        if let project = workspace.current.session.projectURL {
            let path = NSString(string: project.deletingLastPathComponent().path).expandingTildeInPath
            roots.append(URL(fileURLWithPath: path, isDirectory: true).standardizedFileURL.resolvingSymlinksInPath())
        }
        return roots
    }

    private func canonicalURL(_ value: URL, forWrite: Bool) -> URL {
        if !forWrite || FileManager.default.fileExists(atPath: value.path) {
            return value.resolvingSymlinksInPath()
        }
        // fileExists follows links, so a dangling leaf symlink inside an allowed root
        // reports false here even though the path is occupied — and a write through it
        // would land outside the root. Check the leaf itself with readlink semantics;
        // if it is a symlink, resolve the real target so containment runs against it.
        if let destination = try? FileManager.default.destinationOfSymbolicLink(atPath: value.path) {
            let resolved = value.resolvingSymlinksInPath()
            if resolved.standardizedFileURL.path != value.standardizedFileURL.path {
                return resolved
            }
            // resolvingSymlinksInPath left the dangling leaf in place; resolve the
            // link contents manually (absolute, or relative to the link's directory).
            let parent = value.deletingLastPathComponent().resolvingSymlinksInPath()
            let target = destination.hasPrefix("/")
                ? URL(fileURLWithPath: destination)
                : parent.appendingPathComponent(destination)
            return target.standardizedFileURL.resolvingSymlinksInPath()
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

    /// One formatter for the whole log; ISO8601DateFormatter is not cheap to build.
    private let formatter = ISO8601DateFormatter()

    /// The log is kept to the newest ~8 MB; older lines are truncated away on append.
    private let maxLogBytes = 8 * 1024 * 1024

    /// One execute call's records in a single ensure/open/seek/write/close pass.
    func append(requestId: String, entries: [(operation: String, ok: Bool, details: [String: CompositorMCPJSON])]) async {
        var body = ""
        for entry in entries {
            let record: CompositorMCPJSON = .object([
                "timestamp": .string(formatter.string(from: Date())),
                "requestId": .string(requestId),
                "operation": .string(entry.operation),
                "ok": .bool(entry.ok),
                "details": .object(entry.details)
            ])
            guard let data = try? JSONEncoder().encode(record), let line = String(data: data, encoding: .utf8) else { continue }
            body.append(line)
            body.append("\n")
        }
        writeBody(body)
    }

    /// Records a request rejected before it reached an operation (malformed JSON,
    /// bad token, oversized payload, confirmation_required, …) so denials are
    /// visible alongside execute records. `method` and `code` must never carry
    /// token material.
    func reject(requestId: String, method: String, code: String) async {
        guard CompositorMCPConfiguration.load().auditLogging else { return }
        let record: CompositorMCPJSON = .object([
            "timestamp": .string(formatter.string(from: Date())),
            "requestId": .string(requestId),
            "method": .string(method),
            "ok": .bool(false),
            "code": .string(code)
        ])
        guard let data = try? JSONEncoder().encode(record), let line = String(data: data, encoding: .utf8) else { return }
        writeBody(line + "\n")
    }

    private func writeBody(_ body: String) {
        guard !body.isEmpty else { return }
        do {
            try CompositorMCPRuntimeFiles.ensureDirectory()
            if !FileManager.default.fileExists(atPath: CompositorMCPRuntimeFiles.auditLog.path) {
                try Data().write(to: CompositorMCPRuntimeFiles.auditLog)
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: CompositorMCPRuntimeFiles.auditLog.path)
            }
            let incoming = Data(body.utf8)
            let size = (try? FileManager.default.attributesOfItem(atPath: CompositorMCPRuntimeFiles.auditLog.path))?[.size] as? Int ?? 0
            if size + incoming.count > maxLogBytes, let log = try? Data(contentsOf: CompositorMCPRuntimeFiles.auditLog) {
                // Over the cap: keep only the newest ~maxLogBytes/2 of whole lines so
                // steady-state appends stay cheap instead of rewriting ~8 MB every
                // time, and prepend a marker noting that history was dropped.
                var tail = (log + incoming).suffix(maxLogBytes / 2)
                if let newline = tail.firstIndex(of: 0x0a) {
                    tail = tail.suffix(from: tail.index(after: newline))
                }
                var replacement = Data()
                let marker: CompositorMCPJSON = .object([
                    "timestamp": .string(formatter.string(from: Date())),
                    "requestId": .string("audit"),
                    "operation": .string("audit_truncated"),
                    "ok": .bool(true),
                    "details": .object(["keptBytes": .number(Double(tail.count))])
                ])
                if let markerData = try? JSONEncoder().encode(marker) {
                    replacement.append(markerData)
                    replacement.append(0x0a)
                }
                replacement.append(contentsOf: tail)
                // Temp file + rename keeps the rewrite atomic: a crash mid-write can
                // no longer leave a half-written log.
                let temporary = CompositorMCPRuntimeFiles.directory.appendingPathComponent("audit-\(UUID().uuidString).tmp")
                try replacement.write(to: temporary)
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: temporary.path)
                guard rename(temporary.path, CompositorMCPRuntimeFiles.auditLog.path) == 0 else {
                    _ = try? FileManager.default.removeItem(at: temporary)
                    throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
                }
            } else {
                let handle = try FileHandle(forWritingTo: CompositorMCPRuntimeFiles.auditLog)
                // defer: close must run even when seekToEnd/write throws.
                defer { try? handle.close() }
                try handle.seekToEnd()
                try handle.write(contentsOf: incoming)
            }
        } catch {
            // Auditing must never break editing. A future UI can surface audit-write failures.
        }
    }
}
