import Foundation
import Network

/// Authenticated newline-delimited JSON bridge used by the companion MCP server.
///
/// The listener accepts one request per connection, rejects non-loopback peers, limits
/// request size, and publishes a short-lived random bearer token in a mode-0600 discovery file.
@MainActor
final class CompositorMCPBridge {
    private static let maximumRequestBytes = 8 * 1024 * 1024

    private let workspace: ProjectWorkspace
    private let router: CompositorMCPCommandRouter
    private let queue = DispatchQueue(label: "com.compositor.mcp.bridge", qos: .userInitiated)
    private var listener: NWListener?
    private var token: String?

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
        guard isLoopback(connection.endpoint) else {
            connection.cancel()
            return
        }
        connection.start(queue: queue)
        receive(on: connection, buffer: Data(), token: token)
    }

    private func receive(on connection: NWConnection, buffer: Data, token: String) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, complete, error in
            Task { @MainActor in
                guard let self else { connection.cancel(); return }
                if let error {
                    self.sendFailure(id: "unknown", code: "bridge_receive_failed", message: error.localizedDescription, on: connection)
                    return
                }

                var next = buffer
                if let data { next.append(data) }
                if next.count > Self.maximumRequestBytes {
                    self.sendFailure(id: "unknown", code: "request_too_large", message: "Bridge requests are limited to 8 MiB.", on: connection)
                    return
                }

                if let newline = next.firstIndex(of: 0x0A) {
                    let payload = next[..<newline]
                    await self.process(Data(payload), expectedToken: token, on: connection)
                } else if complete {
                    self.sendFailure(id: "unknown", code: "incomplete_request", message: "Request must end with a newline.", on: connection)
                } else {
                    self.receive(on: connection, buffer: next, token: token)
                }
            }
        }
    }

    private func process(_ data: Data, expectedToken: String, on connection: NWConnection) async {
        let request: CompositorMCPBridgeRequest
        do {
            request = try JSONDecoder().decode(CompositorMCPBridgeRequest.self, from: data)
        } catch {
            sendFailure(id: "unknown", code: "invalid_json", message: "Request is not valid compositor-bridge JSON.", on: connection)
            return
        }

        guard constantTimeEquals(request.token, expectedToken) else {
            sendFailure(id: request.id, code: "unauthorised", message: "Bridge authentication failed.", on: connection)
            return
        }
        let response = await router.handle(request)
        send(response, on: connection)
    }

    private func sendFailure(id: String, code: String, message: String, on connection: NWConnection) {
        send(.failure(id: id, error: .init(code: code, message: message)), on: connection)
    }

    private func send(_ response: CompositorMCPBridgeResponse, on connection: NWConnection) {
        do {
            var data = try JSONEncoder().encode(response)
            data.append(0x0A)
            connection.send(content: data, completion: .contentProcessed { _ in connection.cancel() })
        } catch {
            connection.cancel()
        }
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
