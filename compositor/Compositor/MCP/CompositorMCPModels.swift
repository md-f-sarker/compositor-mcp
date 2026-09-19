import Foundation

/// JSON value used by the local bridge. Keeping the bridge payload independent of app models
/// makes the wire format stable even when Compositor's internal types change.
enum CompositorMCPJSON: Codable, Equatable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: CompositorMCPJSON])
    case array([CompositorMCPJSON])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([String: CompositorMCPJSON].self) { self = .object(value) }
        else if let value = try? container.decode([CompositorMCPJSON].self) { self = .array(value) }
        else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported JSON value")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }

    var string: String? {
        guard case .string(let value) = self else { return nil }
        return value
    }

    var number: Double? {
        guard case .number(let value) = self else { return nil }
        return value
    }

    var bool: Bool? {
        guard case .bool(let value) = self else { return nil }
        return value
    }

    var object: [String: CompositorMCPJSON]? {
        guard case .object(let value) = self else { return nil }
        return value
    }

    var array: [CompositorMCPJSON]? {
        guard case .array(let value) = self else { return nil }
        return value
    }
}

struct CompositorMCPBridgeRequest: Codable, Sendable {
    let protocolVersion: String
    let id: String
    let token: String
    let method: String
    let params: [String: CompositorMCPJSON]?

    enum CodingKeys: String, CodingKey {
        case protocolVersion = "protocol"
        case id, token, method, params
    }
}

struct CompositorMCPBridgeResponse: Codable, Sendable {
    let protocolVersion = "compositor-bridge/1"
    let id: String
    let ok: Bool
    let result: CompositorMCPJSON?
    let error: CompositorMCPErrorPayload?

    enum CodingKeys: String, CodingKey {
        case protocolVersion = "protocol"
        case id, ok, result, error
    }

    static func success(id: String, result: CompositorMCPJSON) -> Self {
        Self(id: id, ok: true, result: result, error: nil)
    }

    static func failure(id: String, error: CompositorMCPCommandError) -> Self {
        Self(id: id, ok: false, result: nil, error: error.payload)
    }
}

struct CompositorMCPErrorPayload: Codable, Sendable {
    let code: String
    let message: String
    let details: CompositorMCPJSON?
    let retryable: Bool?
}

struct CompositorMCPCommandError: LocalizedError, Sendable {
    let code: String
    let message: String
    var details: CompositorMCPJSON? = nil
    var retryable = false

    var errorDescription: String? { message }
    var payload: CompositorMCPErrorPayload {
        CompositorMCPErrorPayload(code: code, message: message, details: details, retryable: retryable ? true : nil)
    }

    static func invalid(_ message: String, details: CompositorMCPJSON? = nil) -> Self {
        Self(code: "invalid_arguments", message: message, details: details)
    }

    static func notFound(_ message: String) -> Self {
        Self(code: "not_found", message: message)
    }

    static func busy(_ message: String = "Compositor is busy with another edit.") -> Self {
        Self(code: "app_busy", message: message, retryable: true)
    }
}

struct CompositorMCPOperation: Codable, Sendable {
    let name: String
    let arguments: [String: CompositorMCPJSON]?
    let precondition: CompositorMCPPrecondition?
}

struct CompositorMCPPrecondition: Codable, Sendable {
    let projectId: String?
    let documentId: String?
    let revision: Int?
}

struct CompositorMCPExecuteRequest: Codable, Sendable {
    let operations: [CompositorMCPOperation]
    let atomic: Bool?
    let dryRun: Bool?
    let confirmDestructive: Bool?
    let idempotencyKey: String?
}

extension Dictionary where Key == String, Value == CompositorMCPJSON {
    func requiredString(_ key: String) throws -> String {
        guard let value = self[key]?.string, !value.isEmpty else {
            throw CompositorMCPCommandError.invalid("\(key) must be a non-empty string.")
        }
        return value
    }

    func optionalString(_ key: String) throws -> String? {
        guard let raw = self[key] else { return nil }
        if case .null = raw { return nil }
        guard let value = raw.string else { throw CompositorMCPCommandError.invalid("\(key) must be a string.") }
        return value
    }

    func requiredDouble(_ key: String) throws -> Double {
        guard let value = self[key]?.number, value.isFinite else {
            throw CompositorMCPCommandError.invalid("\(key) must be a finite number.")
        }
        return value
    }

    func optionalDouble(_ key: String) throws -> Double? {
        guard let raw = self[key] else { return nil }
        if case .null = raw { return nil }
        guard let value = raw.number, value.isFinite else {
            throw CompositorMCPCommandError.invalid("\(key) must be a finite number.")
        }
        return value
    }

    func requiredInt(_ key: String) throws -> Int {
        guard let value = try optionalInt(key) else {
            throw CompositorMCPCommandError.invalid("\(key) must be an integer.")
        }
        return value
    }

    func optionalInt(_ key: String) throws -> Int? {
        guard let value = try optionalDouble(key) else { return nil }
        guard value.rounded() == value, value >= Double(Int.min), value <= Double(Int.max) else {
            throw CompositorMCPCommandError.invalid("\(key) must be an integer.")
        }
        return Int(value)
    }

    func requiredBool(_ key: String) throws -> Bool {
        guard let value = self[key]?.bool else { throw CompositorMCPCommandError.invalid("\(key) must be a boolean.") }
        return value
    }

    func optionalBool(_ key: String) throws -> Bool? {
        guard let raw = self[key] else { return nil }
        if case .null = raw { return nil }
        guard let value = raw.bool else { throw CompositorMCPCommandError.invalid("\(key) must be a boolean.") }
        return value
    }

    func requiredStrings(_ key: String) throws -> [String] {
        guard let values = self[key]?.array else { throw CompositorMCPCommandError.invalid("\(key) must be an array.") }
        let strings = values.compactMap(\.string)
        guard strings.count == values.count else { throw CompositorMCPCommandError.invalid("\(key) must contain only strings.") }
        return strings
    }
}

extension CompositorMCPJSON {
    static func int(_ value: Int) -> Self { .number(Double(value)) }
    static func cgFloat(_ value: CGFloat) -> Self { .number(Double(value)) }
    static func uuid(_ value: UUID?) -> Self { value.map { .string($0.uuidString) } ?? .null }
}
