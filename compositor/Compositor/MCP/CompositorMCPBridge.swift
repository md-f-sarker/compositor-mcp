import Foundation
import Network

/// Authenticated newline-delimited JSON bridge used by the companion MCP server.
///
/// The listener accepts one request per connection, rejects non-loopback peers, limits
/// request size, and publishes a short-lived random bearer token in a mode-0600 discovery file.
@MainActor
final class CompositorMCPBridge {
    private static let maximumRequestBytes = 8 * 1024 * 1024
    /// Far above any legitimate request shape; guards the recursive JSON decoder.
    private static let maximumJSONDepth = 256
    /// Bounds on partially-open connections and the serial work queue — a local
    /// process that opens sockets but never sends a valid request cannot hold
    /// unbounded slots.
    private static let maximumConcurrentConnections = 32
    private static let maximumPendingRequests = 64
    private static let receiveDeadlineSeconds: TimeInterval = 30

    private let workspace: ProjectWorkspace
    private let router: CompositorMCPCommandRouter
    private let queue = DispatchQueue(label: "com.compositor.mcp.bridge", qos: .userInitiated)
    private var listener: NWListener?
    private var token: String?

    /// Requests are handled strictly one at a time in arrival order. Operations await
    /// inside `router.handle`, so without serialization two connections' requests would
    /// interleave on the main actor and corrupt shared undo groups, idempotency
    /// bookkeeping, and optimistic preconditions.
    private var pendingRequests: [(request: CompositorMCPBridgeRequest, connection: NWConnection)] = []
    private var isProcessingRequest = false
    /// Accepted connections still streaming their request. Entries live from accept()
    /// until the request is complete or the connection dies; a receive deadline
    /// reclaims slots a sender abandons mid-request.
    private var openConnections = Set<ObjectIdentifier>()

    init(workspace: ProjectWorkspace) {
        self.workspace = workspace
        self.router = CompositorMCPCommandRouter(workspace: workspace)
    }

    func start() {
        guard listener == nil else { return }
        do {
            let configuration = CompositorMCPConfiguration.load()
            guard configuration.enabled else { return }

            let token = try CompositorMCPRuntimeFiles.randomToken()
            let parameters = NWParameters.tcp
            parameters.allowLocalEndpointReuse = true
            // Kernel-enforced loopback binding; the per-connection endpoint check in
            // accept() stays as defence-in-depth.
            parameters.requiredInterfaceType = .loopback
            let listener = try NWListener(using: parameters, on: .any)
            self.token = token
            self.listener = listener

            listener.stateUpdateHandler = { [weak self, weak listener] state in
                Task { @MainActor in
                    guard let self, let listener else { return }
                    self.listenerStateChanged(state, listener: listener, token: token)
                }
            }
            listener.newConnectionHandler = { [weak self] connection in
                Task { @MainActor in self?.accept(connection, token: token) }
            }
            listener.start(queue: queue)
        } catch {
            NSLog("Compositor MCP bridge could not start: %@", error.localizedDescription)
            stop()
        }
    }

    func stop() {
        listener?.cancel()
        listener = nil
        // Drop requests still waiting for the serial queue so they never reach
        // router.handle during shutdown; the in-flight request is allowed to finish.
        for pending in pendingRequests { pending.connection.cancel() }
        pendingRequests.removeAll()
        if let token { CompositorMCPRuntimeFiles.removeDiscovery(matching: token) }
        token = nil
    }

    private func listenerStateChanged(_ state: NWListener.State, listener: NWListener, token: String) {
        switch state {
        case .ready:
            guard let port = listener.port?.rawValue else {
                NSLog("Compositor MCP bridge became ready without a TCP port.")
                stop()
                return
            }
            do {
                let discovery = CompositorMCPDiscovery(
                    host: "127.0.0.1",
                    port: port,
                    token: token,
                    pid: ProcessInfo.processInfo.processIdentifier,
                    startedAt: Date(),
                    appVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
                )
                try CompositorMCPRuntimeFiles.writeDiscovery(discovery)
                NSLog("Compositor MCP bridge listening on loopback port %d", port)
            } catch {
                NSLog("Compositor MCP bridge could not publish discovery: %@", error.localizedDescription)
                stop()
            }
        case .failed(let error):
            NSLog("Compositor MCP bridge failed: %@", error.localizedDescription)
            stop()
        case .cancelled:
            CompositorMCPRuntimeFiles.removeDiscovery(matching: token)
        default:
            break
        }
    }

    private func accept(_ connection: NWConnection, token: String) {
        // A connection accepted just as stop() runs must not reach the router.
        guard listener != nil else {
            connection.cancel()
            return
        }
        guard isLoopback(connection.endpoint) else {
            connection.cancel()
            return
        }
        let identifier = ObjectIdentifier(connection)
        guard openConnections.count < Self.maximumConcurrentConnections else {
            connection.cancel()
            return
        }
        openConnections.insert(identifier)
        connection.start(queue: queue)
        queue.asyncAfter(deadline: .now() + Self.receiveDeadlineSeconds) { [weak self] in
            Task { @MainActor in
                guard let self, self.openConnections.contains(identifier) else { return }
                self.openConnections.remove(identifier)
                connection.cancel()
            }
        }
        receive(on: connection, buffer: Data(), token: token)
    }

    private func receive(on connection: NWConnection, buffer: Data, token: String) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, complete, error in
            Task { @MainActor in
                guard let self else { connection.cancel(); return }
                if let error {
                    self.openConnections.remove(ObjectIdentifier(connection))
                    await self.reject(id: "unknown", code: "bridge_receive_failed", message: error.localizedDescription, on: connection)
                    return
                }

                var next = buffer
                if let data { next.append(data) }
                if next.count > Self.maximumRequestBytes {
                    self.openConnections.remove(ObjectIdentifier(connection))
                    await self.reject(id: "unknown", code: "request_too_large", message: "Bridge requests are limited to 8 MiB.", on: connection)
                    return
                }

                if let newline = next.firstIndex(of: 0x0A) {
                    let payload = next[..<newline]
                    self.process(Data(payload), expectedToken: token, on: connection)
                } else if complete {
                    self.openConnections.remove(ObjectIdentifier(connection))
                    await self.reject(id: "unknown", code: "incomplete_request", message: "Request must end with a newline.", on: connection)
                } else {
                    self.receive(on: connection, buffer: next, token: token)
                }
            }
        }
    }

    /// Validates, authenticates and enqueues the request, then starts the serial
    /// drain if it is not already running. Depth check, decode and token check
    /// all happen BEFORE a queue slot is granted — unauthenticated or malformed
    /// payloads never consume capacity on the editing-work queue.
    private func process(_ data: Data, expectedToken: String, on connection: NWConnection) {
        openConnections.remove(ObjectIdentifier(connection))

        guard !Self.jsonDepthExceeds(data, limit: Self.maximumJSONDepth) else {
            Task { await self.reject(id: "unknown", code: "invalid_json", message: "Request JSON exceeds the maximum nesting depth.", on: connection) }
            return
        }
        let request: CompositorMCPBridgeRequest
        do {
            request = try JSONDecoder().decode(CompositorMCPBridgeRequest.self, from: data)
        } catch {
            Task { await self.reject(id: "unknown", code: "invalid_json", message: "Request is not valid compositor-bridge JSON.", on: connection) }
            return
        }
        guard constantTimeEquals(request.token, expectedToken) else {
            Task { await self.reject(id: request.id, method: request.method, code: "unauthorised", message: "Bridge authentication failed.", on: connection) }
            return
        }
        guard pendingRequests.count < Self.maximumPendingRequests else {
            Task { await self.reject(id: request.id, method: request.method, code: "too_many_requests", message: "Bridge request queue is full; retry shortly.", on: connection) }
            return
        }

        pendingRequests.append((request, connection))
        guard !isProcessingRequest else { return }
        isProcessingRequest = true
        Task { @MainActor in
            while !self.pendingRequests.isEmpty {
                let next = self.pendingRequests.removeFirst()
                await self.handle(next.request, on: next.connection)
            }
            self.isProcessingRequest = false
        }
    }

    private func handle(_ request: CompositorMCPBridgeRequest, on connection: NWConnection) async {
        let response = await router.handle(request)
        if !response.ok {
            // Router-level rejections (confirmation_required, filesystem_denied, …)
            // never reach apply(), so record them here or they are invisible.
            await CompositorMCPAuditLog.shared.reject(requestId: request.id, method: request.method, code: response.error?.code ?? "unknown_error")
        }
        await send(response, on: connection)
    }

    /// Sends a failure response and records the rejection so malformed and
    /// unauthenticated requests are visible in the audit log. The audit record
    /// carries only the request id, method, and code — never token material.
    private func reject(id: String, method: String = "rejected", code: String, message: String, on connection: NWConnection) async {
        await CompositorMCPAuditLog.shared.reject(requestId: id, method: method, code: code)
        await send(.failure(id: id, error: .init(code: code, message: message)), on: connection)
    }

    private func send(_ response: CompositorMCPBridgeResponse, on connection: NWConnection) async {
        do {
            var data = try JSONEncoder().encode(response)
            data.append(0x0A)
            // Wait for the bytes to be processed before the next queued request runs,
            // so one request's lifecycle fully completes before the next begins.
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                connection.send(content: data, completion: .contentProcessed { _ in
                    connection.cancel()
                    continuation.resume()
                })
            }
        } catch {
            connection.cancel()
        }
    }

    /// Iteratively counts `{`/`[` nesting depth outside string literals. The scan
    /// never recurses, tracks in-string and escape state, and is safe on raw UTF-8
    /// because multi-byte sequences can never contain `"`, `\`, or bracket bytes.
    private static func jsonDepthExceeds(_ data: Data, limit: Int) -> Bool {
        var depth = 0
        var inString = false
        var escaped = false
        for byte in data {
            if inString {
                if escaped {
                    escaped = false
                } else if byte == 0x5C { // backslash
                    escaped = true
                } else if byte == 0x22 { // closing quote
                    inString = false
                }
                continue
            }
            switch byte {
            case 0x22: // opening quote
                inString = true
            case 0x7B, 0x5B: // { [
                depth += 1
                if depth > limit { return true }
            case 0x7D, 0x5D: // } ]
                depth -= 1
            default:
                break
            }
        }
        return false
    }

    private func isLoopback(_ endpoint: NWEndpoint) -> Bool {
        guard case .hostPort(let host, _) = endpoint else { return false }
        let value = String(describing: host).lowercased()
        return value == "localhost" || value == "::1" || value == "0:0:0:0:0:0:0:1" || value.hasPrefix("127.")
    }

    private func constantTimeEquals(_ left: String, _ right: String) -> Bool {
        let a = Array(left.utf8), b = Array(right.utf8)
        var difference = UInt(a.count ^ b.count)
        let count = max(a.count, b.count)
        for index in 0..<count {
            let x = index < a.count ? a[index] : 0
            let y = index < b.count ? b[index] : 0
            difference |= UInt(x ^ y)
        }
        return difference == 0
    }
}
