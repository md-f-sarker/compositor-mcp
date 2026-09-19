import AppKit
import CoreGraphics
import CoreImage
import CryptoKit
import Foundation

@MainActor
final class CompositorMCPCommandRouter {
    private let workspace: ProjectWorkspace
    private let paths: CompositorMCPPathPolicy
    private var revision = 0
    private var lastObservedFingerprint: String?
    private struct IdempotencyEntry {
        let fingerprint: String
        let result: CompositorMCPJSON
    }
    private var idempotencyCache: [String: IdempotencyEntry] = [:]
    private var idempotencyOrder: [String] = []

    private let implemented: Set<String> = [
        "app.ping", "app.getState", "workspace.list", "workspace.select",
        "document.create", "document.open", "document.save", "document.importImages", "document.export", "document.flip",
        "document.resizeCanvas", "document.resizeImage", "document.crop",
        "history.undo", "history.redo",
        "layer.list", "layer.select", "layer.addBlank", "layer.duplicate", "layer.rename", "layer.delete",
        "layer.setVisibility", "layer.setOpacity", "layer.setBlendMode", "layer.move", "layer.group", "layer.ungroup", "layer.merge",
        "layer.flip", "layer.transform", "layer.distort", "layer.addMask", "layer.deleteMask", "layer.setMaskLinked",
        "layer.setClippingMask", "layer.featherMask",
        "selection.get", "selection.all", "selection.none", "selection.invert", "selection.fromLayer", "selection.fromMask",
        "selection.expand", "selection.contract", "pixels.fill", "pixels.clear", "pixels.invert", "preview.render"
    ]

    private let destructive: Set<String> = ["layer.delete", "layer.merge", "layer.deleteMask", "pixels.clear"]
    private let nonTransactional: Set<String> = [
        "workspace.select", "document.create", "document.open", "document.save", "document.importImages", "document.export",
        "history.undo", "history.redo", "preview.render"
    ]
    private let readOnly: Set<String> = ["app.ping", "app.getState", "workspace.list", "layer.list", "selection.get"]

    init(workspace: ProjectWorkspace) {
        self.workspace = workspace
        self.paths = CompositorMCPPathPolicy(workspace: workspace)
    }

    func handle(_ request: CompositorMCPBridgeRequest) async -> CompositorMCPBridgeResponse {
        observeChanges()
        guard request.protocolVersion == "compositor-bridge/1" else {
            return .failure(id: request.id, error: .init(code: "unsupported_protocol", message: "Expected compositor-bridge/1."))
        }
        do {
            let result: CompositorMCPJSON
            switch request.method {
            case "ping":
                result = ping()
            case "state":
                let includeLayers = try request.params?.optionalBool("includeLayers") ?? true
                result = state(includeLayers: includeLayers)
            case "capabilities":
                result = .object([
                    "protocol": .string("compositor-bridge/1"),
                    "implemented": .array(implemented.sorted().map(CompositorMCPJSON.string)),
                    "revision": .int(revision)
                ])
            case "execute":
                let params = request.params ?? [:]
                let value: CompositorMCPExecuteRequest = try decode(params)
                result = try await execute(value, requestId: request.id)
            default:
                throw CompositorMCPCommandError(code: "unsupported_method", message: "Unsupported bridge method: \(request.method)")
            }
            return .success(id: request.id, result: result)
        } catch let error as CompositorMCPCommandError {
            return .failure(id: request.id, error: error)
        } catch {
            return .failure(id: request.id, error: .init(code: "internal_error", message: error.localizedDescription))
        }
    }

    private func ping() -> CompositorMCPJSON {
        .object([
            "ok": .bool(true),
            "protocol": .string("compositor-bridge/1"),
            "revision": .int(revision),
            "processId": .int(Int(ProcessInfo.processInfo.processIdentifier)),
            "appVersion": .string(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "development")
        ])
    }

    private func state(includeLayers: Bool = true) -> CompositorMCPJSON {
        CompositorMCPStateBuilder(workspace: workspace, revision: revision).snapshot(includeLayers: includeLayers)
    }

    private func execute(_ request: CompositorMCPExecuteRequest, requestId: String) async throws -> CompositorMCPJSON {
        guard !request.operations.isEmpty else { throw CompositorMCPCommandError.invalid("At least one operation is required.") }
        guard request.operations.count <= 100 else { throw CompositorMCPCommandError.invalid("A batch may contain at most 100 operations.") }

        let requestFingerprint: String?
        if let key = request.idempotencyKey {
            guard (8...200).contains(key.count) else {
                throw CompositorMCPCommandError.invalid("idempotencyKey must be between 8 and 200 characters.")
            }
            let fingerprint = try idempotencyFingerprint(request)
            if let cached = idempotencyCache[key] {
                guard cached.fingerprint == fingerprint else {
                    throw CompositorMCPCommandError(
                        code: "idempotency_conflict",
                        message: "The idempotency key was already used for a different request."
                    )
                }
                return cached.result
            }
            requestFingerprint = fingerprint
        } else {
            requestFingerprint = nil
        }

        for operation in request.operations {
            guard implemented.contains(operation.name) else {
                throw CompositorMCPCommandError(code: "operation_not_implemented", message: "\(operation.name) is not implemented by this bridge build.")
            }
            try checkPrecondition(operation.precondition)
        }

        let destructiveNames = request.operations.map(\.name).filter(destructive.contains)
        if !destructiveNames.isEmpty, request.confirmDestructive != true, request.dryRun != true {
            throw CompositorMCPCommandError(
                code: "confirmation_required",
                message: "Destructive operations require confirmDestructive: true.",
                details: .object(["operations": .array(Array(Set(destructiveNames)).sorted().map(CompositorMCPJSON.string))])
            )
        }

        let atomic = request.atomic ?? true
        if atomic, request.operations.count > 1 {
            let unsafe = request.operations.map(\.name).filter(nonTransactional.contains)
            if !unsafe.isEmpty {
                throw CompositorMCPCommandError(
                    code: "non_transactional_batch",
                    message: "Atomic batches cannot include file, workspace or history operations.",
                    details: .object(["operations": .array(Array(Set(unsafe)).sorted().map(CompositorMCPJSON.string))])
                )
            }
        }

        if request.dryRun == true {
            var results: [CompositorMCPJSON] = []
            for (index, operation) in request.operations.enumerated() {
                try validate(operation)
                results.append(.object([
                    "index": .int(index), "name": .string(operation.name), "ok": .bool(true),
                    "value": .object(["valid": .bool(true)])
                ]))
            }
            return .object([
                "ok": .bool(true), "dryRun": .bool(true), "atomic": .bool(atomic),
                "revision": .int(revision), "results": .array(results), "state": state()
            ])
        }

        let session = workspace.current.session
        let requiresIdleEditor = request.operations.contains { !readOnly.contains($0.name) }
        if requiresIdleEditor {
            guard !workspace.isManaging, workspace.canSwitch, session.canStartProjectOperation else {
                throw CompositorMCPCommandError.busy()
            }
        }

        let shouldGroupUndo = atomic && request.operations.count > 1
            && request.operations.contains { !readOnly.contains($0.name) }
            && request.operations.allSatisfy { !nonTransactional.contains($0.name) }
        let activeLayerBefore = session.activeLayerID
        let selectedLayersBefore = session.selectedLayerIDs
        let maskTargetBefore = session.isMaskSelected
        let undoCountBefore = session.history.undoCount
        if shouldGroupUndo { session.beginEdit("MCP Batch") }
        var operationResults: [CompositorMCPJSON] = []
        var failed = false
        var mutated = false

        for (index, operation) in request.operations.enumerated() {
            do {
                let outcome = try await apply(operation)
                mutated = mutated || outcome.mutated
                operationResults.append(.object([
                    "index": .int(index), "name": .string(operation.name), "ok": .bool(true), "value": outcome.value
                ]))
                await audit(requestId: requestId, operation: operation.name, ok: true)
            } catch let error as CompositorMCPCommandError {
                failed = true
                operationResults.append(.object([
                    "index": .int(index), "name": .string(operation.name), "ok": .bool(false),
                    "error": .object([
                        "code": .string(error.code), "message": .string(error.message),
                        "details": error.details ?? .null, "retryable": .bool(error.retryable)
                    ])
                ]))
                await audit(requestId: requestId, operation: operation.name, ok: false,
                    details: ["code": .string(error.code), "message": .string(error.message)])
                if atomic { break }
            } catch {
                failed = true
                operationResults.append(.object([
                    "index": .int(index), "name": .string(operation.name), "ok": .bool(false),
                    "error": .object(["code": .string("internal_error"), "message": .string(error.localizedDescription)])
                ]))
                await audit(requestId: requestId, operation: operation.name, ok: false,
                    details: ["code": .string("internal_error"), "message": .string(error.localizedDescription)])
                if atomic { break }
            }
        }

        var rolledBack = false
        if shouldGroupUndo {
            session.endEdit()
            if failed, session.history.undoCount > undoCountBefore, session.canUndo {
                session.undo()
                rolledBack = true
                mutated = false
            }
        }
        if failed, atomic {
            let available = Set(session.document?.layers.map(\.id) ?? [])
            let restoredSelection = selectedLayersBefore.intersection(available)
            let restoredActive = activeLayerBefore.flatMap { available.contains($0) ? $0 : nil }
            if session.activeLayerID != restoredActive || session.selectedLayerIDs != restoredSelection || session.isMaskSelected != maskTargetBefore {
                session.activeLayerID = restoredActive
                session.selectedLayerIDs = restoredSelection
                session.isMaskSelected = maskTargetBefore && session.activeLayer?.mask != nil
                rolledBack = true
            }
        }
        observeChanges()

        let result: CompositorMCPJSON = .object([
            "ok": .bool(!failed), "dryRun": .bool(false), "atomic": .bool(atomic),
            "rolledBack": .bool(rolledBack), "mutated": .bool(mutated), "revision": .int(revision),
            "results": .array(operationResults), "state": state()
        ])
        if let key = request.idempotencyKey, let fingerprint = requestFingerprint {
            cache(result, fingerprint: fingerprint, for: key)
        }
        return result
    }

    private func checkPrecondition(_ value: CompositorMCPPrecondition?) throws {
        guard let value else { return }
        if let expected = value.revision, expected != revision {
            throw CompositorMCPCommandError(
                code: "revision_conflict", message: "Editor revision changed.",
                details: .object(["expected": .int(expected), "actual": .int(revision)]), retryable: true
            )
        }
        if let expected = value.projectId, expected != "current", expected != workspace.current.id.uuidString {
            throw CompositorMCPCommandError(code: "project_conflict", message: "The selected project no longer matches the precondition.", retryable: true)
        }
        if let expected = value.documentId, expected != workspace.current.session.document?.id.uuidString {
            throw CompositorMCPCommandError(code: "document_conflict", message: "The current document no longer matches the precondition.", retryable: true)
        }
    }

    private func validate(_ operation: CompositorMCPOperation) throws {
        let arguments = operation.arguments ?? [:]
        let session = workspace.current.session

        switch operation.name {
        case "app.ping", "workspace.list", "selection.get":
            break
        case "app.getState":
            _ = try arguments.optionalBool("includeLayers")
        case "workspace.select":
            _ = try resolveProject(arguments.requiredString("projectId"))
        case "document.create":
            let width = try arguments.requiredInt("width"), height = try arguments.requiredInt("height")
            guard (1...30_000).contains(width), (1...30_000).contains(height) else {
                throw CompositorMCPCommandError.invalid("Document dimensions must be between 1 and 30,000 pixels.")
            }
            if let resolution = try arguments.optionalDouble("resolution"), !(1...2400).contains(resolution) {
                throw CompositorMCPCommandError.invalid("resolution must be between 1 and 2,400 DPI.")
            }
        case "document.open":
            _ = try paths.authorise(arguments.requiredString("path"), forWrite: false)
        case "document.save":
            if let supplied = try arguments.optionalString("path") {
                _ = try paths.authorise(supplied, forWrite: true)
            } else if session.projectURL == nil {
                throw CompositorMCPCommandError.invalid("path is required for an untitled project.")
            }
        case "document.importImages":
            let supplied = try arguments.requiredStrings("paths")
            guard (1...100).contains(supplied.count) else { throw CompositorMCPCommandError.invalid("paths must contain between 1 and 100 files.") }
            for value in supplied { _ = try paths.authorise(value, forWrite: false) }
            let x = try arguments.optionalDouble("x"), y = try arguments.optionalDouble("y")
            guard (x == nil) == (y == nil) else { throw CompositorMCPCommandError.invalid("x and y must be supplied together.") }
        case "document.export":
            _ = try paths.authorise(arguments.requiredString("path"), forWrite: true)
            let format = (try arguments.optionalString("format") ?? "png").lowercased()
            guard format == "png" || format == "jpeg" || format == "jpg" else {
                throw CompositorMCPCommandError.invalid("format must be png or jpeg.")
            }
            if let quality = try arguments.optionalDouble("quality"), !(0...1).contains(quality) {
                throw CompositorMCPCommandError.invalid("quality must be between 0 and 1.")
            }
            if let background = try arguments.optionalString("background") { _ = try parseHex(background) }
            guard session.document != nil else { throw CompositorMCPCommandError(code: "document_required", message: "No document is open.") }
        case "document.flip":
            try validateAxis(arguments.requiredString("axis"))
            guard session.canEditLayers else { throw CompositorMCPCommandError(code: "document_unavailable", message: "The canvas cannot be flipped while editing is unavailable.") }
        case "document.resizeCanvas":
            let width = try arguments.requiredDouble("width"), height = try arguments.requiredDouble("height")
            guard (1...30_000).contains(width.rounded()), (1...30_000).contains(height.rounded()) else {
                throw CompositorMCPCommandError.invalid("Document dimensions must be between 1 and 30,000 pixels.")
            }
            let anchor = try arguments.optionalString("anchor") ?? "centre"
            guard canvasAnchor(anchor) != nil else { throw CompositorMCPCommandError.invalid("Unknown anchor: \(anchor)") }
            guard session.document != nil else { throw CompositorMCPCommandError(code: "document_required", message: "No document is open.") }
        case "document.resizeImage":
            let width = try arguments.requiredDouble("width"), height = try arguments.requiredDouble("height")
            guard (1...30_000).contains(width.rounded()), (1...30_000).contains(height.rounded()) else {
                throw CompositorMCPCommandError.invalid("Document dimensions must be between 1 and 30,000 pixels.")
            }
            if let resolution = try arguments.optionalDouble("resolution"), !(1...2400).contains(resolution) {
                throw CompositorMCPCommandError.invalid("resolution must be between 1 and 2,400 DPI.")
            }
            guard session.document != nil else { throw CompositorMCPCommandError(code: "document_required", message: "No document is open.") }
        case "document.crop":
            let rect = try requireCropRect(arguments)
            guard CropGeometry.valid(rect) else {
                throw CompositorMCPCommandError.invalid("The crop rectangle is outside Compositor's limits.")
            }
            guard let document = session.document else { throw CompositorMCPCommandError(code: "document_required", message: "No document is open.") }
            guard rect.intersects(CGRect(origin: .zero, size: document.size)) else {
                throw CompositorMCPCommandError.invalid("The crop rectangle does not intersect the canvas.")
            }
        case "history.undo":
            guard session.canUndo else { throw CompositorMCPCommandError(code: "undo_unavailable", message: "Nothing can be undone.") }
        case "history.redo":
            guard session.canRedo else { throw CompositorMCPCommandError(code: "redo_unavailable", message: "Nothing can be redone.") }
        case "layer.list":
            if let requested = try arguments.optionalString("projectId") { _ = try resolveProject(requested) }
        case "layer.select":
            let values = try arguments.requiredStrings("layerIds")
            guard !values.isEmpty else { throw CompositorMCPCommandError.invalid("layerIds must not be empty.") }
            let ids = try values.map { try resolveLayer($0, session: session) }
            for id in ids where session.document?.layers.contains(where: { $0.id == id }) != true {
                throw CompositorMCPCommandError.notFound("Layer not found: \(id.uuidString)")
            }
            let target = try arguments.optionalString("target") ?? "layer"
            guard target == "layer" || target == "mask" else { throw CompositorMCPCommandError.invalid("target must be layer or mask.") }
            if target == "mask", let active = ids.last,
               session.document?.layers.first(where: { $0.id == active })?.mask == nil {
                throw CompositorMCPCommandError.notFound("The active target layer has no mask.")
            }
        case "layer.addBlank":
            _ = try arguments.optionalString("name")
            guard session.document != nil, session.canEditLayers else {
                throw CompositorMCPCommandError(code: "document_required", message: "Open or create an editable document first.")
            }
        case "layer.duplicate":
            let id = try resolveLayer(try arguments.optionalString("layerId") ?? "active", session: session)
            guard let layer = session.document?.layers.first(where: { $0.id == id }) else { throw CompositorMCPCommandError.notFound("Layer not found.") }
            guard !layer.isGroup, session.canEditLayers else { throw CompositorMCPCommandError(code: "duplicate_unavailable", message: "The selected layer cannot be duplicated.") }
        case "layer.rename":
            let id = try resolveLayer(arguments.requiredString("layerId"), session: session)
            _ = try arguments.requiredString("name")
            try requireLayer(id, session: session)
        case "layer.delete":
            let id = try resolveLayer(arguments.requiredString("layerId"), session: session)
            try requireLayer(id, session: session)
            let dependants = dependentMaskTargets(forDeleting: id, session: session)
            guard dependants.isEmpty else {
                throw CompositorMCPCommandError(
                    code: "dependent_live_masks",
                    message: "Delete would require an interactive bake-or-unlink choice. Release those clipping masks first.",
                    details: .object(["dependentLayerIds": .array(dependants.map { .string($0.uuidString) })])
                )
            }
        case "layer.setVisibility":
            let id = try resolveLayer(arguments.requiredString("layerId"), session: session)
            _ = try arguments.requiredBool("visible")
            try requireLayer(id, session: session)
        case "layer.setOpacity":
            let id = try resolveLayer(arguments.requiredString("layerId"), session: session)
            let opacity = try arguments.requiredDouble("opacity")
            guard (0...1).contains(opacity) else { throw CompositorMCPCommandError.invalid("opacity must be between 0 and 1.") }
            let layer = try requireLayer(id, session: session)
            guard !layer.isGroup else { throw CompositorMCPCommandError.invalid("Folder opacity is not supported by Compositor.") }
        case "layer.setBlendMode":
            let id = try resolveLayer(arguments.requiredString("layerId"), session: session)
            let requested = try arguments.requiredString("blendMode")
            guard LayerBlendMode.allCases.contains(where: { $0.rawValue.caseInsensitiveCompare(requested) == .orderedSame }) else {
                throw CompositorMCPCommandError.invalid("Unknown blend mode: \(requested)")
            }
            let layer = try requireLayer(id, session: session)
            guard !layer.isGroup else { throw CompositorMCPCommandError.invalid("Folders do not have blend modes in Compositor.") }
        case "layer.move":
            let id = try resolveLayer(arguments.requiredString("layerId"), session: session)
            let offset = try arguments.requiredInt("offset")
            guard (-1000...1000).contains(offset) else { throw CompositorMCPCommandError.invalid("offset must be between -1,000 and 1,000.") }
            try requireLayer(id, session: session)
        case "layer.group":
            _ = try arguments.optionalString("name")
            guard !session.selectedLayerIDs.isEmpty, session.canEditLayers else {
                throw CompositorMCPCommandError(code: "layer_required", message: "Select at least one editable layer first.")
            }
        case "layer.ungroup":
            let id = try resolveLayer(arguments.requiredString("layerId"), session: session)
            let layer = try requireLayer(id, session: session)
            guard layer.isGroup else { throw CompositorMCPCommandError.invalid("The layer is not a group.") }
            guard session.canEditLayers else {
                throw CompositorMCPCommandError(code: "ungroup_unavailable", message: "The group cannot be dissolved while another edit is active.")
            }
        case "layer.merge":
            if let value = try arguments.optionalString("layerId") {
                let id = try resolveLayer(value, session: session)
                try requireLayer(id, session: session)
            } else if !session.canMergeLayers {
                throw CompositorMCPCommandError(code: "merge_unavailable", message: "The current layer selection cannot be merged.")
            }
        case "layer.flip":
            try validateAxis(arguments.requiredString("axis"))
            guard session.canTransform else { throw CompositorMCPCommandError(code: "transform_unavailable", message: "The selected layer or group cannot be transformed.") }
        case "layer.transform":
            let id = try resolveLayer(arguments.requiredString("layerId"), session: session)
            try requireLayer(id, session: session)
            if let width = try arguments.optionalDouble("width"), width <= 0 { throw CompositorMCPCommandError.invalid("width must be greater than 0.") }
            if let height = try arguments.optionalDouble("height"), height <= 0 { throw CompositorMCPCommandError.invalid("height must be greater than 0.") }
            _ = try arguments.optionalDouble("x"); _ = try arguments.optionalDouble("y"); _ = try arguments.optionalDouble("rotation")
            _ = try arguments.optionalBool("flipX"); _ = try arguments.optionalBool("flipY")
            if let requested = try arguments.optionalString("sampling"),
               !LayerSampling.allCases.contains(where: { $0.rawValue.caseInsensitiveCompare(requested) == .orderedSame }) {
                throw CompositorMCPCommandError.invalid("Unknown sampling mode: \(requested)")
            }
        case "layer.distort":
            let id = try resolveLayer(arguments.requiredString("layerId"), session: session)
            try requireLayer(id, session: session)
            _ = try requireDistortCorners(arguments)
        case "layer.addMask":
            let id = try resolveLayer(arguments.requiredString("layerId"), session: session)
            let mode = try arguments.optionalString("mode") ?? "reveal"
            guard ["reveal", "hide", "from-selection"].contains(mode) else { throw CompositorMCPCommandError.invalid("mode must be reveal, hide or from-selection.") }
            let layer = try requireLayer(id, session: session)
            guard layer.mask == nil else { throw CompositorMCPCommandError(code: "mask_exists", message: "The layer already has a mask.") }
            if mode == "from-selection", session.selection == nil { throw CompositorMCPCommandError(code: "selection_required", message: "from-selection requires an active selection.") }
        case "layer.deleteMask":
            let id = try resolveLayer(arguments.requiredString("layerId"), session: session)
            let layer = try requireLayer(id, session: session)
            guard layer.mask != nil else { throw CompositorMCPCommandError.notFound("Layer mask not found.") }
        case "layer.setMaskLinked":
            let id = try resolveLayer(arguments.requiredString("layerId"), session: session)
            _ = try arguments.requiredBool("linked")
            let layer = try requireLayer(id, session: session)
            guard layer.mask != nil else { throw CompositorMCPCommandError.notFound("Layer mask not found.") }
        case "layer.setClippingMask":
            let id = try resolveLayer(arguments.requiredString("layerId"), session: session)
            let enabled = try arguments.requiredBool("enabled")
            let layer = try requireLayer(id, session: session)
            if (layer.maskSourceID != nil) != enabled, !session.canToggleClippingMask(id) {
                throw CompositorMCPCommandError(code: "clipping_mask_unavailable", message: "This layer cannot change its clipping-mask relationship.")
            }
        case "layer.featherMask":
            let id = try resolveLayer(arguments.requiredString("layerId"), session: session)
            let radius = try arguments.requiredDouble("radius")
            guard (0...10_000).contains(radius) else { throw CompositorMCPCommandError.invalid("radius must be between 0 and 10,000 pixels.") }
            let layer = try requireLayer(id, session: session)
            guard layer.mask != nil else { throw CompositorMCPCommandError.notFound("Layer mask not found.") }
            guard session.canEditLayers else {
                throw CompositorMCPCommandError(code: "mask_edit_unavailable", message: "The mask cannot be edited while another edit is active.")
            }
        case "selection.all":
            guard session.document != nil else { throw CompositorMCPCommandError(code: "document_required", message: "No document is open.") }
        case "selection.none":
            break
        case "selection.invert":
            guard session.selection != nil, session.canEditSelection else { throw CompositorMCPCommandError(code: "selection_required", message: "No editable selection exists.") }
        case "selection.fromLayer":
            let id = try resolveLayer(arguments.requiredString("layerId"), session: session)
            let layer = try requireLayer(id, session: session)
            guard layer.asset != nil else { throw CompositorMCPCommandError.notFound("Layer pixels not found.") }
        case "selection.fromMask":
            let id = try resolveLayer(arguments.requiredString("layerId"), session: session)
            let layer = try requireLayer(id, session: session)
            guard layer.mask != nil else { throw CompositorMCPCommandError.notFound("Layer mask not found.") }
        case "selection.expand", "selection.contract":
            let pixels = try arguments.requiredInt("pixels")
            guard (1...10_000).contains(pixels) else { throw CompositorMCPCommandError.invalid("pixels must be between 1 and 10,000.") }
            guard session.selection != nil, session.canModifySelection else { throw CompositorMCPCommandError(code: "selection_required", message: "No editable selection exists.") }
        case "pixels.fill":
            let target = try arguments.optionalString("target") ?? "foreground"
            guard target == "foreground" || target == "background" else { throw CompositorMCPCommandError.invalid("target must be foreground or background.") }
            guard session.canEditPixels else { throw CompositorMCPCommandError(code: "pixel_edit_unavailable", message: "The active layer or mask cannot be filled.") }
        case "pixels.clear":
            guard session.selection != nil, session.canEditPixels else { throw CompositorMCPCommandError(code: "selection_required", message: "Clearing pixels requires an editable selection.") }
        case "pixels.invert":
            guard session.canInvert else { throw CompositorMCPCommandError(code: "pixel_edit_unavailable", message: "The active layer or mask cannot be inverted.") }
        case "preview.render":
            guard session.document != nil else { throw CompositorMCPCommandError(code: "document_required", message: "No document is open.") }
        default:
            throw CompositorMCPCommandError(code: "operation_not_implemented", message: "\(operation.name) is not implemented.")
        }
    }

    @discardableResult
    private func requireLayer(_ id: UUID, session: EditorSession) throws -> ImageLayer {
        guard let layer = session.document?.layers.first(where: { $0.id == id }) else {
            throw CompositorMCPCommandError.notFound("Layer not found: \(id.uuidString)")
        }
        return layer
    }

    private func dependentMaskTargets(forDeleting id: UUID, session: EditorSession) -> [UUID] {
        guard let document = session.document else { return [] }
        let removed = session.descendantIDs(of: id).union([id])
        return document.layers.filter {
            !removed.contains($0.id) && $0.maskSourceID.map(removed.contains) == true
        }.map(\.id)
    }

    private func validateAxis(_ axis: String) throws {
        guard axis == "horizontal" || axis == "vertical" else {
            throw CompositorMCPCommandError.invalid("axis must be horizontal or vertical.")
        }
    }

    /// `CanvasSizeOptions.anchor` is row-major, top-left through bottom-right.
    private func canvasAnchor(_ value: String) -> Int? {
        [
            "top-left": 0, "top": 1, "top-right": 2,
            "left": 3, "centre": 4, "right": 5,
            "bottom-left": 6, "bottom": 7, "bottom-right": 8
        ][value]
    }

    /// The crop rect snapped to whole pixels, exactly as the crop tool's drags are.
    private func requireCropRect(_ arguments: [String: CompositorMCPJSON]) throws -> CGRect {
        let x = try arguments.requiredDouble("x"), y = try arguments.requiredDouble("y")
        let width = try arguments.requiredDouble("width"), height = try arguments.requiredDouble("height")
        return CropGeometry.snapped(CGRect(x: x, y: y, width: width, height: height))
    }

    /// Four document-space corner points in transform-handle order (top-left, top-right,
    /// bottom-right, bottom-left), checked the same way `previewCorners` is.
    private func requireDistortCorners(_ arguments: [String: CompositorMCPJSON]) throws -> [CGPoint] {
        guard let raw = arguments["corners"]?.array, raw.count == 4 else {
            throw CompositorMCPCommandError.invalid("corners must be an array of four points.")
        }
        let corners = try raw.map { value -> CGPoint in
            guard let point = value.object, let x = point["x"]?.number, let y = point["y"]?.number else {
                throw CompositorMCPCommandError.invalid("corners must contain {x, y} points.")
            }
            return CGPoint(x: x, y: y)
        }
        guard DistortWarp.isUsable(corners) else {
            throw CompositorMCPCommandError.invalid("corners must describe a convex, non-degenerate quadrilateral.")
        }
        return corners
    }

    private struct Outcome {
        let value: CompositorMCPJSON
        let mutated: Bool
    }

    private func apply(_ operation: CompositorMCPOperation) async throws -> Outcome {
        try validate(operation)
        let arguments = operation.arguments ?? [:]
        let session = workspace.current.session

        switch operation.name {
        case "app.ping":
            return Outcome(value: ping(), mutated: false)
        case "app.getState":
            return Outcome(value: state(includeLayers: try arguments.optionalBool("includeLayers") ?? true), mutated: false)
        case "workspace.list":
            return Outcome(value: state(includeLayers: false), mutated: false)
        case "layer.list":
            let requested = try arguments.optionalString("projectId") ?? "current"
            let projectID = try resolveProject(requested)
            guard let tab = workspace.tabs.first(where: { $0.id == projectID }) else {
                throw CompositorMCPCommandError.notFound("Project not found: \(requested)")
            }
            let layers = tab.session.document?.layers.map {
                CompositorMCPStateBuilder(workspace: workspace, revision: revision).layer($0)
            } ?? []
            return Outcome(value: .object([
                "projectId": .string(projectID.uuidString),
                "documentId": .uuid(tab.session.document?.id),
                "activeLayerId": .uuid(tab.session.activeLayerID),
                "selectedLayerIds": .array(tab.session.selectedLayerIDs.map(\.uuidString).sorted().map(CompositorMCPJSON.string)),
                "layers": .array(layers)
            ]), mutated: false)
        case "selection.get":
            return Outcome(value: CompositorMCPStateBuilder(workspace: workspace, revision: revision).selection(session), mutated: false)
        case "workspace.select":
            let id = try resolveProject(arguments.requiredString("projectId"))
            guard workspace.canSwitch || id == workspace.selectedID else { throw CompositorMCPCommandError.busy("The current project cannot be switched while an edit is active.") }
            let changed = id != workspace.selectedID
            workspace.select(id)
            return Outcome(value: .object(["projectId": .string(workspace.current.id.uuidString)]), mutated: changed)
        case "document.create":
            let width = try arguments.requiredInt("width"), height = try arguments.requiredInt("height")
            let resolution = try arguments.optionalDouble("resolution") ?? 72
            let tab = workspace.addTab(reuseEmpty: true)
            tab.session.beginEdit("New Canvas")
            tab.session.createDocument(width: width, height: height, emptyLayer: true)
            tab.session.document?.resolution = min(2400, max(1, resolution))
            tab.session.endEdit()
            return Outcome(value: .object([
                "projectId": .string(tab.id.uuidString),
                "documentId": .uuid(tab.session.document?.id),
                "activeLayerId": .uuid(tab.session.activeLayerID)
            ]), mutated: true)
        case "document.open":
            let url = try paths.authorise(arguments.requiredString("path"), forWrite: false)
            guard await workspace.open(url) else { throw CompositorMCPCommandError(code: "open_failed", message: "Compositor could not open the project.") }
            return Outcome(value: .object(["projectId": .string(workspace.current.id.uuidString), "path": .string(url.path)]), mutated: true)
        case "document.save":
            guard let snapshot = session.projectSnapshot() else { throw CompositorMCPCommandError(code: "document_required", message: "No document is open.") }
            let supplied = try arguments.optionalString("path")
            let destination: URL
            if let supplied {
                destination = try paths.authorise(supplied, forWrite: true)
            } else if let existing = session.projectURL {
                destination = try paths.authorise(existing.path, forWrite: true)
            } else {
                throw CompositorMCPCommandError.invalid("path is required for an untitled project.")
            }
            try await ProjectStore.shared.save(snapshot, to: destination)
            session.projectURL = destination
            session.history.markSaved()
            return Outcome(value: .object(["path": .string(destination.path)]), mutated: true)
        case "document.importImages":
            let urls = try arguments.requiredStrings("paths").map { try paths.authorise($0, forWrite: false) }
            let x = try arguments.optionalDouble("x"), y = try arguments.optionalDouble("y")
            let point = (x != nil || y != nil) ? CGPoint(x: CGFloat(x ?? 0), y: CGFloat(y ?? 0)) : nil
            session.importError = nil
            await session.importImages(urls, at: point)
            if let error = session.importError {
                throw CompositorMCPCommandError(code: "import_failed", message: error)
            }
            return Outcome(value: .object(["imported": .int(urls.count)]), mutated: true)
        case "document.export":
            guard let snapshot = session.projectSnapshot() else { throw CompositorMCPCommandError(code: "document_required", message: "No document is open.") }
            let destination = try paths.authorise(arguments.requiredString("path"), forWrite: true)
            let format = (try arguments.optionalString("format") ?? "png").lowercased()
            switch format {
            case "png":
                try await ImageExporter.shared.exportPNG(snapshot, to: destination)
            case "jpeg", "jpg":
                let raster = try await ImageExporter.shared.render(snapshot)
                var options = JPEGOptions()
                options.quality = min(1, max(0, try arguments.optionalDouble("quality") ?? 0.85))
                let colour = try arguments.optionalString("background") ?? "#FFFFFF"
                let rgb = try parseHex(colour)
                options.red = rgb.0; options.green = rgb.1; options.blue = rgb.2
                let encoded = try await ImageExporter.shared.jpeg(raster, options: options)
                try await ImageExporter.shared.write(encoded.data, to: destination)
            default:
                throw CompositorMCPCommandError.invalid("format must be png or jpeg.")
            }
            return Outcome(value: .object(["path": .string(destination.path), "format": .string(format)]), mutated: false)
        case "document.flip":
            guard session.canEditLayers else { throw CompositorMCPCommandError(code: "document_unavailable", message: "The canvas cannot be flipped while editing is unavailable.") }
            let axis = try arguments.requiredString("axis")
            guard axis == "horizontal" || axis == "vertical" else { throw CompositorMCPCommandError.invalid("axis must be horizontal or vertical.") }
            session.flipCanvas(horizontally: axis == "horizontal")
            return Outcome(value: .object(["axis": .string(axis)]), mutated: true)
        case "document.resizeCanvas":
            let anchor = try arguments.optionalString("anchor") ?? "centre"
            guard let anchorIndex = canvasAnchor(anchor) else { throw CompositorMCPCommandError.invalid("Unknown anchor: \(anchor)") }
            let width = Int(try arguments.requiredDouble("width").rounded())
            let height = Int(try arguments.requiredDouble("height").rounded())
            guard let snapshot = session.projectSnapshot() else { throw CompositorMCPCommandError(code: "document_required", message: "No document is open.") }
            session.isProjectBusy = true
            defer { session.isProjectBusy = false }
            do {
                let resized = try await CanvasResizer.shared.resize(snapshot,
                    to: CanvasSizeOptions(width: width, height: height, anchor: anchorIndex))
                session.applyDocumentSize(resized, actionName: "Canvas Size")
            } catch {
                throw CompositorMCPCommandError.invalid(error.localizedDescription)
            }
            return Outcome(value: .object([
                "documentId": .uuid(session.document?.id),
                "width": .int(session.document?.width ?? width),
                "height": .int(session.document?.height ?? height),
                "anchor": .string(anchor)
            ]), mutated: true)
        case "document.resizeImage":
            let width = Int(try arguments.requiredDouble("width").rounded())
            let height = Int(try arguments.requiredDouble("height").rounded())
            guard let snapshot = session.projectSnapshot() else { throw CompositorMCPCommandError(code: "document_required", message: "No document is open.") }
            let resolution = try arguments.optionalDouble("resolution") ?? snapshot.manifest.resolution ?? 72
            session.isProjectBusy = true
            defer { session.isProjectBusy = false }
            do {
                let resized = try await ImageResizer.shared.resize(snapshot,
                    to: ImageSizeOptions(width: width, height: height, resolution: resolution))
                session.applyImageSize(resized)
            } catch {
                throw CompositorMCPCommandError.invalid(error.localizedDescription)
            }
            return Outcome(value: .object([
                "documentId": .uuid(session.document?.id),
                "width": .int(session.document?.width ?? width),
                "height": .int(session.document?.height ?? height),
                "resolution": .number(session.document?.resolution ?? resolution)
            ]), mutated: true)
        case "document.crop":
            let rect = try requireCropRect(arguments)
            guard CropGeometry.valid(rect) else {
                throw CompositorMCPCommandError.invalid("The crop rectangle is outside Compositor's limits.")
            }
            guard let document = session.document else { throw CompositorMCPCommandError(code: "document_required", message: "No document is open.") }
            guard rect.intersects(CGRect(origin: .zero, size: document.size)) else {
                throw CompositorMCPCommandError.invalid("The crop rectangle does not intersect the canvas.")
            }
            session.cropError = nil
            session.cropRect = rect
            await session.commitCrop()
            if let message = session.cropError {
                session.cropError = nil
                session.cancelCrop()
                throw CompositorMCPCommandError(code: "crop_failed", message: message)
            }
            guard session.cropRect == nil, let cropped = session.document else {
                session.cancelCrop()
                throw CompositorMCPCommandError(code: "crop_unavailable", message: "The crop could not be committed while another edit is active.")
            }
            return Outcome(value: .object([
                "documentId": .uuid(cropped.id),
                "x": .number(rect.minX), "y": .number(rect.minY),
                "width": .int(cropped.width), "height": .int(cropped.height)
            ]), mutated: true)
        case "history.undo":
            guard session.canUndo else { throw CompositorMCPCommandError(code: "undo_unavailable", message: "Nothing can be undone.") }
            session.undo()
            return Outcome(value: .object(["undone": .bool(true)]), mutated: true)
        case "history.redo":
            guard session.canRedo else { throw CompositorMCPCommandError(code: "redo_unavailable", message: "Nothing can be redone.") }
            session.redo()
            return Outcome(value: .object(["redone": .bool(true)]), mutated: true)
        case "layer.select":
            let ids = try arguments.requiredStrings("layerIds").map { try resolveLayer($0, session: session) }
            for id in ids where session.document?.layers.contains(where: { $0.id == id }) != true {
                throw CompositorMCPCommandError.notFound("Layer not found: \(id.uuidString)")
            }
            let target = try arguments.optionalString("target") ?? "layer"
            let nextSelected = Set(ids)
            let nextActive = ids.last
            let nextMaskTarget = target == "mask"
            let changed = session.activeLayerID != nextActive || session.selectedLayerIDs != nextSelected || session.isMaskSelected != nextMaskTarget
            session.activeLayerID = nextActive
            session.selectedLayerIDs = nextSelected
            session.isMaskSelected = nextMaskTarget
            return Outcome(value: .object(["selectedLayerIds": .array(ids.map { .string($0.uuidString) })]), mutated: changed)
        case "layer.addBlank":
            guard session.document != nil, session.canEditLayers else { throw CompositorMCPCommandError(code: "document_required", message: "Open or create an editable document first.") }
            session.beginEdit("Add Layer")
            session.addBlankLayer()
            if let name = try arguments.optionalString("name"), !name.isEmpty, let id = session.activeLayerID,
               let index = session.document?.layers.firstIndex(where: { $0.id == id }) {
                session.document?.layers[index].name = name
            }
            session.endEdit()
            return Outcome(value: layerValue(session.activeLayer), mutated: true)
        case "layer.duplicate":
            let id = try resolveLayer(try arguments.optionalString("layerId") ?? "active", session: session)
            session.selectLayer(id)
            let before = session.activeLayerID
            session.duplicateActiveLayer()
            guard let copy = session.activeLayerID, copy != before else {
                throw CompositorMCPCommandError(code: "duplicate_unavailable", message: "The selected layer cannot be duplicated.")
            }
            return Outcome(value: layerValue(session.activeLayer), mutated: true)
        case "layer.rename":
            let id = try resolveLayer(arguments.requiredString("layerId"), session: session)
            let name = try arguments.requiredString("name")
            guard let index = session.document?.layers.firstIndex(where: { $0.id == id }) else { throw CompositorMCPCommandError.notFound("Layer not found.") }
            session.beginEdit("Rename Layer")
            session.document?.layers[index].name = name
            session.endEdit()
            return Outcome(value: .object(["id": .string(id.uuidString), "name": .string(name)]), mutated: true)
        case "layer.delete":
            let id = try resolveLayer(arguments.requiredString("layerId"), session: session)
            guard let document = session.document, document.layers.contains(where: { $0.id == id }) else {
                throw CompositorMCPCommandError.notFound("Layer not found.")
            }
            let removed = session.descendantIDs(of: id).union([id])
            let dependants = document.layers.filter {
                !removed.contains($0.id) && $0.maskSourceID.map(removed.contains) == true
            }.map(\.id)
            guard dependants.isEmpty else {
                throw CompositorMCPCommandError(
                    code: "dependent_live_masks",
                    message: "Delete would require an interactive bake-or-unlink choice. Release those clipping masks first.",
                    details: .object(["dependentLayerIds": .array(dependants.map { .string($0.uuidString) })])
                )
            }
            session.deleteLayer(id)
            guard session.document?.layers.contains(where: { $0.id == id }) != true else {
                throw CompositorMCPCommandError(code: "delete_failed", message: "The layer could not be deleted.")
            }
            return Outcome(value: .object(["deletedLayerId": .string(id.uuidString)]), mutated: true)
        case "layer.setVisibility":
            let id = try resolveLayer(arguments.requiredString("layerId"), session: session)
            let visible = try arguments.requiredBool("visible")
            guard let index = session.document?.layers.firstIndex(where: { $0.id == id }) else { throw CompositorMCPCommandError.notFound("Layer not found.") }
            if session.document?.layers[index].isVisible != visible {
                session.beginEdit(visible ? "Show Layer" : "Hide Layer")
                session.document?.layers[index].isVisible = visible
                session.endEdit()
            }
            return Outcome(value: .object(["id": .string(id.uuidString), "visible": .bool(visible)]), mutated: true)
        case "layer.setOpacity":
            let id = try resolveLayer(arguments.requiredString("layerId"), session: session)
            let opacity = min(1, max(0, try arguments.requiredDouble("opacity")))
            guard let index = session.document?.layers.firstIndex(where: { $0.id == id }) else { throw CompositorMCPCommandError.notFound("Layer not found.") }
            guard session.document?.layers[index].isGroup == false else { throw CompositorMCPCommandError.invalid("Folder opacity is not supported by Compositor.") }
            session.beginEdit("Layer Opacity")
            session.document?.layers[index].opacity = opacity
            session.endEdit()
            return Outcome(value: .object(["id": .string(id.uuidString), "opacity": .number(opacity)]), mutated: true)
        case "layer.setBlendMode":
            let id = try resolveLayer(arguments.requiredString("layerId"), session: session)
            let requested = try arguments.requiredString("blendMode")
            guard let mode = LayerBlendMode.allCases.first(where: { $0.rawValue.caseInsensitiveCompare(requested) == .orderedSame }) else {
                throw CompositorMCPCommandError.invalid("Unknown blend mode: \(requested)")
            }
            guard let index = session.document?.layers.firstIndex(where: { $0.id == id }) else { throw CompositorMCPCommandError.notFound("Layer not found.") }
            guard session.document?.layers[index].isGroup == false else { throw CompositorMCPCommandError.invalid("Folders do not have blend modes in Compositor.") }
            session.beginEdit("Layer Blend Mode")
            session.document?.layers[index].blendMode = mode
            session.endEdit()
            return Outcome(value: .object(["id": .string(id.uuidString), "blendMode": .string(mode.rawValue)]), mutated: true)
        case "layer.move":
            let id = try resolveLayer(arguments.requiredString("layerId"), session: session)
            let offset = try arguments.requiredInt("offset")
            session.selectLayer(id)
            session.beginEdit("Move Layer")
            let direction = offset >= 0 ? 1 : -1
            var moved = 0
            for _ in 0..<abs(offset) {
                guard session.canMoveActiveLayer(by: direction) else { break }
                session.moveActiveLayer(by: direction)
                moved += direction
            }
            session.endEdit()
            return Outcome(value: .object([
                "layer": layerValue(session.activeLayer),
                "requestedOffset": .int(offset),
                "appliedOffset": .int(moved)
            ]), mutated: moved != 0)
        case "layer.group":
            guard session.selectedLayerIDs.count > 0 else { throw CompositorMCPCommandError(code: "layer_required", message: "Select at least one layer first.") }
            session.beginEdit("Group Layers")
            session.groupSelectedLayers()
            if let name = try arguments.optionalString("name"), !name.isEmpty, let id = session.activeLayerID,
               let index = session.document?.layers.firstIndex(where: { $0.id == id }) {
                session.document?.layers[index].name = name
            }
            session.endEdit()
            guard session.activeLayer?.isGroup == true else {
                throw CompositorMCPCommandError(code: "group_failed", message: "The selected layers could not be grouped.")
            }
            return Outcome(value: layerValue(session.activeLayer), mutated: true)
        case "layer.ungroup":
            let id = try resolveLayer(arguments.requiredString("layerId"), session: session)
            guard session.canEditLayers, var layers = session.document?.layers,
                  let slot = layers.firstIndex(where: { $0.id == id }), layers[slot].isGroup else {
                if session.document?.layers.first(where: { $0.id == id })?.isGroup == false {
                    throw CompositorMCPCommandError.invalid("The layer is not a group.")
                }
                guard session.document?.layers.contains(where: { $0.id == id }) == true else {
                    throw CompositorMCPCommandError.notFound("Layer not found.")
                }
                throw CompositorMCPCommandError(code: "ungroup_unavailable", message: "The group cannot be dissolved while another edit is active.")
            }
            // Compositor has no native ungroup: the group's direct children take its slot among
            // its siblings in stack order (bottom to top), inside one undo entry. Children that are
            // themselves groups keep their subtrees, so only the top level dissolves.
            let parent = layers[slot].parentID
            let rank = layers.filter { $0.parentID == parent }.firstIndex(where: { $0.id == id }) ?? 0
            var children = layers.filter { $0.parentID == id }
            for index in children.indices { children[index].parentID = parent }
            layers.removeAll { $0.id == id || $0.parentID == id }
            var insertion = layers.count
            var seen = 0
            for (index, layer) in layers.enumerated() where layer.parentID == parent {
                if seen == rank { insertion = index; break }
                seen += 1
            }
            layers.insert(contentsOf: children, at: insertion)
            for child in children { EditorSession.adoptClipping(child.id, in: &layers) }
            EditorSession.releaseDetachedClipping(in: &layers)
            guard (try? LayerHierarchy.validate(layers.map(\.hierarchyRecord))) != nil else {
                throw CompositorMCPCommandError(code: "ungroup_failed", message: "The group could not be dissolved.")
            }
            session.beginEdit("Ungroup Layers")
            session.document?.layers = layers
            if let topmost = children.last {
                session.activeLayerID = topmost.id
                session.selectedLayerIDs = Set(children.map(\.id))
            } else if session.activeLayerID == id {
                session.activeLayerID = nil
            }
            session.endEdit()
            return Outcome(value: .object([
                "ungroupedLayerId": .string(id.uuidString),
                "childLayerIds": .array(children.map { .string($0.id.uuidString) })
            ]), mutated: true)
        case "layer.merge":
            if let value = try arguments.optionalString("layerId") { session.selectLayer(try resolveLayer(value, session: session)) }
            guard session.canMergeLayers else { throw CompositorMCPCommandError(code: "merge_unavailable", message: "The current layer selection cannot be merged.") }
            session.mergeLayers()
            return Outcome(value: layerValue(session.activeLayer), mutated: true)
        case "layer.flip":
            guard session.canTransform else { throw CompositorMCPCommandError(code: "transform_unavailable", message: "The selected layer or group cannot be transformed.") }
            let axis = try arguments.requiredString("axis")
            guard axis == "horizontal" || axis == "vertical" else { throw CompositorMCPCommandError.invalid("axis must be horizontal or vertical.") }
            session.flipLayers(horizontally: axis == "horizontal")
            return Outcome(value: .object(["axis": .string(axis)]), mutated: true)
        case "layer.transform":
            let id = try resolveLayer(arguments.requiredString("layerId"), session: session)
            session.selectLayer(id)
            session.isMaskSelected = false
            session.beginTransform(persistent: false)
            guard var transform = session.transformEdit?.draft else { throw CompositorMCPCommandError(code: "transform_unavailable", message: "The layer cannot be transformed.") }
            if let value = try arguments.optionalDouble("x") { transform.origin.x = CGFloat(value) }
            if let value = try arguments.optionalDouble("y") { transform.origin.y = CGFloat(value) }
            if let value = try arguments.optionalDouble("width") { transform.size.width = CGFloat(value) }
            if let value = try arguments.optionalDouble("height") { transform.size.height = CGFloat(value) }
            if let value = try arguments.optionalDouble("rotation") { transform.rotation = CGFloat(value) }
            if let value = try arguments.optionalBool("flipX") { transform.flipX = value }
            if let value = try arguments.optionalBool("flipY") { transform.flipY = value }
            if let requested = try arguments.optionalString("sampling") {
                guard let sampling = LayerSampling.allCases.first(where: { $0.rawValue.caseInsensitiveCompare(requested) == .orderedSame }) else {
                    session.cancelTransform(); throw CompositorMCPCommandError.invalid("Unknown sampling mode: \(requested)")
                }
                transform.sampling = sampling
            }
            guard transform.isValid else { session.cancelTransform(); throw CompositorMCPCommandError.invalid("The resulting transform is outside Compositor's limits.") }
            session.previewTransform(transform)
            session.commitTransform()
            return Outcome(value: layerValue(session.activeLayer), mutated: true)
        case "layer.distort":
            let id = try resolveLayer(arguments.requiredString("layerId"), session: session)
            guard session.document?.layers.contains(where: { $0.id == id }) == true else {
                throw CompositorMCPCommandError.notFound("Layer not found.")
            }
            let corners = try requireDistortCorners(arguments)
            // Settle any pending transform first so the warp starts from the committed
            // placement, then drive the same beginDistort → previewCorners → commitTransform
            // pipeline the canvas uses, which resamples the pixels into the new shape.
            session.commitTransform()
            session.selectLayer(id)
            session.isMaskSelected = false
            session.beginTransform(persistent: true)
            session.beginDistort()
            guard session.transformEdit != nil, session.transformEdit?.corners != nil else {
                session.cancelTransform()
                throw CompositorMCPCommandError(code: "transform_unavailable", message: "The selected layer or group cannot be distorted.")
            }
            session.previewCorners(corners)
            session.commitTransform()
            return Outcome(value: layerValue(session.activeLayer), mutated: true)
        case "layer.addMask":
            let id = try resolveLayer(arguments.requiredString("layerId"), session: session)
            session.selectLayer(id)
            let mode = try arguments.optionalString("mode") ?? "reveal"
            switch mode {
            case "reveal": session.addLayerMask(revealing: true)
            case "hide": session.addLayerMask(revealing: false)
            case "from-selection": session.addMask(revealing: true)
            default: throw CompositorMCPCommandError.invalid("mode must be reveal, hide or from-selection.")
            }
            guard session.activeLayer?.mask != nil else { throw CompositorMCPCommandError(code: "mask_failed", message: "The mask could not be created.") }
            return Outcome(value: layerValue(session.activeLayer), mutated: true)
        case "layer.deleteMask":
            let id = try resolveLayer(arguments.requiredString("layerId"), session: session)
            guard let index = session.document?.layers.firstIndex(where: { $0.id == id }), session.document?.layers[index].mask != nil else {
                throw CompositorMCPCommandError.notFound("Layer mask not found.")
            }
            session.beginEdit("Delete Layer Mask")
            session.document?.layers[index].mask = nil
            session.isMaskSelected = false
            session.endEdit()
            return Outcome(value: .object(["layerId": .string(id.uuidString), "hasMask": .bool(false)]), mutated: true)
        case "layer.setMaskLinked":
            let id = try resolveLayer(arguments.requiredString("layerId"), session: session)
            let linked = try arguments.requiredBool("linked")
            guard let index = session.document?.layers.firstIndex(where: { $0.id == id }), var mask = session.document?.layers[index].mask else {
                throw CompositorMCPCommandError.notFound("Layer mask not found.")
            }
            session.beginEdit(linked ? "Link Layer Mask" : "Unlink Layer Mask")
            mask.isLinked = linked
            session.document?.layers[index].mask = mask
            session.endEdit()
            return Outcome(value: .object(["layerId": .string(id.uuidString), "linked": .bool(linked)]), mutated: true)
        case "layer.setClippingMask":
            let id = try resolveLayer(arguments.requiredString("layerId"), session: session)
            let enabled = try arguments.requiredBool("enabled")
            guard let layer = session.document?.layers.first(where: { $0.id == id }) else { throw CompositorMCPCommandError.notFound("Layer not found.") }
            if (layer.maskSourceID != nil) != enabled {
                guard session.canToggleClippingMask(id) else { throw CompositorMCPCommandError(code: "clipping_mask_unavailable", message: "This layer cannot change its clipping-mask relationship.") }
                session.toggleClippingMask(id)
            }
            return Outcome(value: .object(["layerId": .string(id.uuidString), "enabled": .bool(enabled)]), mutated: true)
        case "layer.featherMask":
            let id = try resolveLayer(arguments.requiredString("layerId"), session: session)
            let radius = try arguments.requiredDouble("radius")
            guard let index = session.document?.layers.firstIndex(where: { $0.id == id }),
                  let mask = session.document?.layers[index].mask else {
                throw CompositorMCPCommandError.notFound("Layer mask not found.")
            }
            guard session.canEditLayers else {
                throw CompositorMCPCommandError(code: "mask_edit_unavailable", message: "The mask cannot be edited while another edit is active.")
            }
            // Compositor has no native mask feather: the mask's own pixels are softened by a
            // Gaussian blur rendered through the same Core Image mask pipeline raster edits use
            // (`PixelAdjust.render` isMask). The radius is in mask pixels; a 1 × 1 uniform mask
            // or a zero radius leaves the asset untouched.
            var asset = mask.asset
            if radius > 0, mask.asset.image.width > 1 || mask.asset.image.height > 1 {
                let extent = CGRect(x: 0, y: 0, width: mask.asset.image.width, height: mask.asset.image.height)
                let blurred = CIImage(cgImage: mask.asset.image)
                    .clampedToExtent()
                    .applyingGaussianBlur(sigma: radius)
                    .cropped(to: extent)
                do {
                    let image = try PixelAdjust.render(blurred, width: mask.asset.image.width,
                        height: mask.asset.image.height, isMask: true)
                    asset = try LayerMask.asset(from: image)
                } catch {
                    throw CompositorMCPCommandError(code: "feather_failed", message: error.localizedDescription)
                }
            }
            let changed = asset.image !== mask.asset.image
            session.beginEdit("Feather Mask")
            session.document?.layers[index].mask = mask.replacing(asset)
            session.endEdit()
            return Outcome(value: .object([
                "layerId": .string(id.uuidString), "radius": .number(radius), "hasMask": .bool(true)
            ]), mutated: changed)
        case "selection.all":
            guard session.document != nil else { throw CompositorMCPCommandError(code: "document_required", message: "No document is open.") }
            session.selectAll()
            return Outcome(value: CompositorMCPStateBuilder(workspace: workspace, revision: revision).selection(session), mutated: true)
        case "selection.none":
            session.deselect()
            return Outcome(value: .null, mutated: true)
        case "selection.invert":
            guard session.selection != nil, session.canEditSelection else { throw CompositorMCPCommandError(code: "selection_required", message: "No editable selection exists.") }
            session.invertSelection()
            return Outcome(value: CompositorMCPStateBuilder(workspace: workspace, revision: revision).selection(session), mutated: true)
        case "selection.fromLayer":
            let id = try resolveLayer(arguments.requiredString("layerId"), session: session)
            guard session.document?.layers.first(where: { $0.id == id })?.asset != nil else { throw CompositorMCPCommandError.notFound("Layer pixels not found.") }
            session.loadLayerSelection(layerID: id)
            return Outcome(value: CompositorMCPStateBuilder(workspace: workspace, revision: revision).selection(session), mutated: true)
        case "selection.fromMask":
            let id = try resolveLayer(arguments.requiredString("layerId"), session: session)
            guard session.document?.layers.first(where: { $0.id == id })?.mask != nil else { throw CompositorMCPCommandError.notFound("Layer mask not found.") }
            session.loadMaskSelection(layerID: id)
            return Outcome(value: CompositorMCPStateBuilder(workspace: workspace, revision: revision).selection(session), mutated: true)
        case "selection.expand":
            guard session.selection != nil, session.canModifySelection else { throw CompositorMCPCommandError(code: "selection_required", message: "No editable selection exists.") }
            session.expandSelection(by: try arguments.requiredInt("pixels"))
            return Outcome(value: CompositorMCPStateBuilder(workspace: workspace, revision: revision).selection(session), mutated: true)
        case "selection.contract":
            guard session.selection != nil, session.canModifySelection else { throw CompositorMCPCommandError(code: "selection_required", message: "No editable selection exists.") }
            session.contractSelection(by: try arguments.requiredInt("pixels"))
            return Outcome(value: CompositorMCPStateBuilder(workspace: workspace, revision: revision).selection(session), mutated: true)
        case "pixels.fill":
            guard session.canEditPixels else { throw CompositorMCPCommandError(code: "pixel_edit_unavailable", message: "The active layer or mask cannot be filled.") }
            let target = try arguments.optionalString("target") ?? "foreground"
            guard target == "foreground" || target == "background" else { throw CompositorMCPCommandError.invalid("target must be foreground or background.") }
            await session.fillSelection(with: target == "background" ? .background : .foreground)
            return Outcome(value: .object(["filled": .bool(true), "target": .string(target)]), mutated: true)
        case "pixels.clear":
            guard session.selection != nil, session.canEditPixels else { throw CompositorMCPCommandError(code: "selection_required", message: "Clearing pixels requires an editable selection.") }
            await session.clearSelectedPixels()
            return Outcome(value: .object(["cleared": .bool(true)]), mutated: true)
        case "pixels.invert":
            guard session.canInvert else { throw CompositorMCPCommandError(code: "pixel_edit_unavailable", message: "The active layer or mask cannot be inverted.") }
            await session.invertPixels()
            return Outcome(value: .object(["inverted": .bool(true)]), mutated: true)
        case "preview.render":
            guard let snapshot = session.projectSnapshot() else { throw CompositorMCPCommandError(code: "document_required", message: "No document is open.") }
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("Compositor-MCP", isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
            cleanupPreviewFiles(in: directory)
            let destination = directory.appendingPathComponent("preview-\(UUID().uuidString).png")
            try await ImageExporter.shared.exportPNG(snapshot, to: destination)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destination.path)
            return Outcome(value: .object([
                "path": .string(destination.path),
                "width": .int(snapshot.manifest.width),
                "height": .int(snapshot.manifest.height),
                "mediaType": .string("image/png")
            ]), mutated: false)
        default:
            throw CompositorMCPCommandError(code: "operation_not_implemented", message: "\(operation.name) is not implemented.")
        }
    }

    private func cleanupPreviewFiles(in directory: URL) {
        let manager = FileManager.default
        guard let files = try? manager.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.contentModificationDateKey],
            options: [.skipsHiddenFiles]
        ) else { return }
        let cutoff = Date().addingTimeInterval(-24 * 60 * 60)
        let sorted = files.filter { $0.lastPathComponent.hasPrefix("preview-") }.sorted {
            let left = (try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            let right = (try? $1.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            return left > right
        }
        for (index, file) in sorted.enumerated() {
            let modified = (try? file.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            if index >= 20 || modified < cutoff { try? manager.removeItem(at: file) }
        }
    }

    private func resolveProject(_ value: String) throws -> UUID {
        if value == "current" { return workspace.current.id }
        guard let id = UUID(uuidString: value), workspace.tabs.contains(where: { $0.id == id }) else {
            throw CompositorMCPCommandError.notFound("Project not found: \(value)")
        }
        return id
    }

    private func resolveLayer(_ value: String, session: EditorSession) throws -> UUID {
        if value == "active" {
            guard let id = session.activeLayerID else { throw CompositorMCPCommandError(code: "layer_required", message: "No active layer exists.") }
            return id
        }
        guard let id = UUID(uuidString: value) else { throw CompositorMCPCommandError.invalid("Invalid layer UUID: \(value)") }
        return id
    }

    private func layerValue(_ layer: ImageLayer?) -> CompositorMCPJSON {
        guard let layer else { return .null }
        return CompositorMCPStateBuilder(workspace: workspace, revision: revision).layer(layer)
    }

    private func audit(requestId: String, operation: String, ok: Bool,
                       details: [String: CompositorMCPJSON] = [:]) async {
        guard paths.configuration.auditLogging else { return }
        await CompositorMCPAuditLog.shared.append(requestId: requestId, operation: operation, ok: ok, details: details)
    }

    /// Keeps optimistic preconditions aware of both MCP edits and edits made directly in the app.
    /// The fingerprint deliberately includes image identities so committed paint/filter changes are observed.
    private func observeChanges() {
        let next = editorFingerprint()
        if let previous = lastObservedFingerprint, previous != next { revision += 1 }
        lastObservedFingerprint = next
    }

    private func editorFingerprint() -> String {
        let current = workspace.current
        let session = current.session
        var values = [
            workspace.selectedID.uuidString,
            current.id.uuidString,
            session.projectURL?.standardizedFileURL.path ?? "",
            String(session.isModified),
            String(session.history.undoCount),
            String(session.canRedo),
            session.activeLayerID?.uuidString ?? "",
            session.selectedLayerIDs.map(\.uuidString).sorted().joined(separator: ","),
            String(session.isMaskSelected)
        ]
        guard let document = session.document else {
            values.append("no-document")
            return values.joined(separator: "|")
        }
        values.append(contentsOf: [document.id.uuidString, String(document.width), String(document.height), String(document.resolution)])
        for layer in document.layers {
            values.append(contentsOf: [
                layer.id.uuidString, layer.name, String(layer.isVisible), layer.parentID?.uuidString ?? "",
                String(layer.isGroup), String(layer.opacity), layer.blendMode.rawValue,
                String(layer.transform.origin.x), String(layer.transform.origin.y), String(layer.transform.size.width),
                String(layer.transform.size.height), String(layer.transform.rotation), String(layer.transform.flipX), String(layer.transform.flipY),
                layer.maskSourceID?.uuidString ?? "", String(layer.mask?.isEnabled ?? false), String(layer.mask?.isLinked ?? false)
            ])
            if let image = layer.asset?.image { values.append(String(ObjectIdentifier(image).hashValue)) }
            if let image = layer.mask?.asset.image { values.append(String(ObjectIdentifier(image).hashValue)) }
        }
        if let selection = session.selection {
            let bounds = selection.path.boundingBoxOfPath
            values.append(contentsOf: [String(bounds.minX), String(bounds.minY), String(bounds.width), String(bounds.height), String(selection.antialiased)])
        } else {
            values.append("no-selection")
        }
        return values.joined(separator: "|")
    }

    private func parseHex(_ value: String) throws -> (CGFloat, CGFloat, CGFloat) {
        let trimmed = value.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        guard trimmed.count == 6, let integer = Int(trimmed, radix: 16) else { throw CompositorMCPCommandError.invalid("background must be a six-digit hex colour.") }
        return (
            CGFloat((integer >> 16) & 0xff) / 255,
            CGFloat((integer >> 8) & 0xff) / 255,
            CGFloat(integer & 0xff) / 255
        )
    }

    private func decode<T: Decodable>(_ object: [String: CompositorMCPJSON]) throws -> T {
        let data = try JSONEncoder().encode(object)
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func idempotencyFingerprint(_ request: CompositorMCPExecuteRequest) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let digest = SHA256.hash(data: try encoder.encode(request))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    private func cache(_ result: CompositorMCPJSON, fingerprint: String, for key: String) {
        idempotencyCache[key] = IdempotencyEntry(fingerprint: fingerprint, result: result)
        idempotencyOrder.removeAll { $0 == key }
        idempotencyOrder.append(key)
        while idempotencyOrder.count > 100 {
            let oldest = idempotencyOrder.removeFirst()
            idempotencyCache.removeValue(forKey: oldest)
        }
    }
}
