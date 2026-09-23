import AppKit
import CoreGraphics
import CoreImage
import CryptoKit
import Foundation

@MainActor
final class CompositorMCPCommandRouter {
    /// Internal rather than private so the paint extension (CompositorMCPPaint.swift) shares them.
    let workspace: ProjectWorkspace
    private let paths: CompositorMCPPathPolicy
    var revision = 0
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
        "selection.rectangle", "selection.ellipse", "selection.polygon", "selection.magicWand",
        "selection.expand", "selection.contract", "pixels.fill", "pixels.clear", "pixels.invert", "pixels.contentAwareFill", "preview.render",
        "paint.brushStroke", "paint.spotHeal", "paint.clone", "paint.blur", "paint.gradient", "paint.shape",
        "adjustment.add", "adjustment.update", "filter.apply"
    ]

    private let destructive: Set<String> = ["document.crop", "layer.delete", "layer.merge", "layer.deleteMask", "pixels.clear"]
    private let nonTransactional: Set<String> = [
        "workspace.select", "document.create", "document.open", "document.save", "document.importImages", "document.export",
        "history.undo", "history.redo", "preview.render"
    ]
    private let readOnly: Set<String> = ["app.ping", "app.getState", "workspace.list", "layer.list", "selection.get"]

    init(workspace: ProjectWorkspace) {
        self.workspace = workspace
        self.paths = CompositorMCPPathPolicy(workspace: workspace)
    }

    // MARK: - Bridge entry points

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
        } catch let error as DecodingError {
            return .failure(id: request.id, error: .init(code: "invalid_request", message: error.localizedDescription))
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

    // MARK: - Execute pipeline

    private func execute(_ request: CompositorMCPExecuteRequest, requestId: String) async throws -> CompositorMCPJSON {
        guard !request.operations.isEmpty else {
            throw CompositorMCPCommandError(code: "invalid_request", message: "At least one operation is required.")
        }
        guard request.operations.count <= 100 else {
            throw CompositorMCPCommandError(code: "too_many_operations", message: "A batch may contain at most 100 operations.")
        }

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
            && requiresIdleEditor
            && request.operations.allSatisfy { !nonTransactional.contains($0.name) }
        let activeLayerBefore = session.activeLayerID
        let selectedLayersBefore = session.selectedLayerIDs
        let maskTargetBefore = session.isMaskSelected
        let undoCountBefore = session.history.undoCount
        if shouldGroupUndo { session.beginEdit("MCP Batch") }
        var operationResults: [CompositorMCPJSON] = []
        var auditEntries: [(operation: String, ok: Bool, details: [String: CompositorMCPJSON])] = []
        var failed = false
        var mutated = false
        var undidFailedOperation = false

        for (index, operation) in request.operations.enumerated() {
            // apply() re-resolves workspace.current per operation, and workspace.select /
            // document.open / document.create can move the active document mid-batch, so the
            // session and the per-op precondition check must both be re-evaluated here.
            let operationSession = workspace.current.session
            let undoCountBeforeOperation = operationSession.history.undoCount
            do {
                try checkPrecondition(operation.precondition)
                let outcome = try await apply(operation)
                mutated = mutated || outcome.mutated
                operationResults.append(.object([
                    "index": .int(index), "name": .string(operation.name), "ok": .bool(true), "value": outcome.value
                ]))
                auditEntries.append((operation.name, true, [:]))
            } catch let error as CompositorMCPCommandError {
                failed = true
                operationResults.append(.object([
                    "index": .int(index), "name": .string(operation.name), "ok": .bool(false),
                    "error": .object([
                        "code": .string(error.code), "message": .string(error.message),
                        "details": error.details ?? .null, "retryable": .bool(error.retryable)
                    ])
                ]))
                auditEntries.append((operation.name, false,
                    ["code": .string(error.code), "message": .string(error.message)]))
                // Rollback must run for every failed operation — `||` short-circuits,
                // so folding the call into the accumulator would skip it after the first success.
                let didUndoCommandError = rollbackFailedOperation(on: operationSession, undoCountBefore: undoCountBeforeOperation,
                                                                  grouped: shouldGroupUndo)
                undidFailedOperation = undidFailedOperation || didUndoCommandError
                if atomic { break }
            } catch {
                failed = true
                operationResults.append(.object([
                    "index": .int(index), "name": .string(operation.name), "ok": .bool(false),
                    "error": .object(["code": .string("internal_error"), "message": .string(error.localizedDescription)])
                ]))
                auditEntries.append((operation.name, false,
                    ["code": .string("internal_error"), "message": .string(error.localizedDescription)]))
                let didUndoInternalError = rollbackFailedOperation(on: operationSession, undoCountBefore: undoCountBeforeOperation,
                                                                   grouped: shouldGroupUndo)
                undidFailedOperation = undidFailedOperation || didUndoInternalError
                if atomic { break }
            }
        }
        await audit(requestId: requestId, entries: auditEntries)

        var rolledBack = undidFailedOperation
        if shouldGroupUndo {
            session.endEdit()
            if failed, session.history.undoCount > undoCountBefore {
                // session.undo() spends its first call discarding a pending gradient;
                // settle it so the entry that reverts is the grouped batch itself.
                if session.gradientEdit != nil { session.cancelGradient() }
                while session.history.undoCount > undoCountBefore, session.canUndo {
                    session.undo()
                    rolledBack = true
                }
                if rolledBack { mutated = false }
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

    /// Geometry ops replace the document outright. A pending transform, crop, gradient,
    /// lasso draft or selection move would otherwise commit against the resized document
    /// — or, for `document.crop`, be silently overwritten by the new crop rect. Refuse
    /// rather than settle implicitly: the client cannot see the UI edit it would discard.
    private func requireSettledDocument(_ session: EditorSession) throws {
        guard session.canEditLayers, session.lassoDraft == nil, session.selectionMoveOrigin == nil else {
            throw CompositorMCPCommandError(
                code: "pending_edit",
                message: "A transform, crop, gradient, filter, lasso or selection move is still in progress; commit or cancel it first.",
                retryable: true
            )
        }
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

    /// Per-operation rollback for batches without an undo group: a transactional op that
    /// mutates and then throws (e.g. `layer.group` renaming the previous active layer after
    /// a refused group, or `document.importImages` failing mid-batch) must not leave its
    /// committed edits behind while reporting ok:false. Grouped batches roll back once via
    /// the outer "MCP Batch" transaction, so this runs only when that path does not.
    @discardableResult
    private func rollbackFailedOperation(on session: EditorSession, undoCountBefore: Int, grouped: Bool) -> Bool {
        guard !grouped else { return false }
        var rolledBack = false
        // Each undo pops one committed entry (a pending gradient is discarded first, as
        // upstream's Undo behaves); loop so an op that pushed several entries fully reverts.
        while session.history.undoCount > undoCountBefore, session.canUndo {
            session.undo()
            rolledBack = true
        }
        return rolledBack
    }

    // MARK: - Operation validation

    private func validate(_ operation: CompositorMCPOperation) throws {
        let arguments = operation.arguments ?? [:]
        let session = workspace.current.session

        switch operation.name {
        // MARK: Reads
        case "app.ping", "workspace.list", "selection.get":
            break
        case "app.getState":
            _ = try arguments.optionalBool("includeLayers")
        // MARK: Workspace and documents
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
            guard format == "png" || format == "jpeg" else {
                throw CompositorMCPCommandError.invalid("format must be png or jpeg.")
            }
            if let quality = try arguments.optionalDouble("quality"), !(0...1).contains(quality) {
                throw CompositorMCPCommandError.invalid("quality must be between 0 and 1.")
            }
            if let background = try arguments.optionalString("background") { _ = try parseHex(background, argument: "background") }
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
            try requireSettledDocument(session)
        case "document.resizeImage":
            let width = try arguments.requiredDouble("width"), height = try arguments.requiredDouble("height")
            guard (1...30_000).contains(width.rounded()), (1...30_000).contains(height.rounded()) else {
                throw CompositorMCPCommandError.invalid("Document dimensions must be between 1 and 30,000 pixels.")
            }
            if let resolution = try arguments.optionalDouble("resolution"), !(1...2400).contains(resolution) {
                throw CompositorMCPCommandError.invalid("resolution must be between 1 and 2,400 DPI.")
            }
            guard session.document != nil else { throw CompositorMCPCommandError(code: "document_required", message: "No document is open.") }
            try requireSettledDocument(session)
        case "document.crop":
            let rect = try requireCropRect(arguments)
            guard CropGeometry.valid(rect) else {
                throw CompositorMCPCommandError.invalid("The crop rectangle is outside Compositor's limits.")
            }
            guard let document = session.document else { throw CompositorMCPCommandError(code: "document_required", message: "No document is open.") }
            try requireSettledDocument(session)
            guard rect.intersects(CGRect(origin: .zero, size: document.size)) else {
                throw CompositorMCPCommandError.invalid("The crop rectangle does not intersect the canvas.")
            }
        // MARK: History
        case "history.undo":
            guard session.canUndo else { throw CompositorMCPCommandError(code: "undo_unavailable", message: "Nothing can be undone.") }
        case "history.redo":
            guard session.canRedo else { throw CompositorMCPCommandError(code: "redo_unavailable", message: "Nothing can be redone.") }
        // MARK: Layers
        case "layer.list":
            if let requested = try arguments.optionalString("projectId") { _ = try resolveProject(requested) }
        case "layer.select":
            let values = try arguments.requiredStrings("layerIds")
            guard (1...100).contains(values.count) else {
                throw CompositorMCPCommandError.invalid("layerIds must contain between 1 and 100 ids.")
            }
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
            let name = try arguments.requiredString("name")
            guard name.count <= 200 else { throw CompositorMCPCommandError.invalid("name must be at most 200 characters.") }
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
            guard LayerBlendMode.matching(requested) != nil else {
                throw CompositorMCPCommandError.invalid("Unknown blend mode: \(requested)")
            }
            let layer = try requireLayer(id, session: session)
            guard !layer.isGroup else { throw CompositorMCPCommandError.invalid("Folders do not have blend modes in Compositor.") }
        case "layer.move":
            let id = try resolveLayer(arguments.requiredString("layerId"), session: session)
            let offset = try arguments.requiredInt("offset")
            guard (-1000...1000).contains(offset) else { throw CompositorMCPCommandError.invalid("offset must be between -1,000 and 1,000.") }
            try requireLayer(id, session: session)
        // MARK: Layer groups
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
        // MARK: Layer transforms
        case "layer.flip":
            try validateAxis(arguments.requiredString("axis"))
            guard session.canTransform else { throw CompositorMCPCommandError(code: "transform_unavailable", message: "The selected layer or group cannot be transformed.") }
        case "layer.transform":
            let id = try resolveLayer(arguments.requiredString("layerId"), session: session)
            try requireLayer(id, session: session)
            if let width = try arguments.optionalDouble("width"), !(1...300_000).contains(width) {
                throw CompositorMCPCommandError.invalid("width must be between 1 and 300,000 pixels.")
            }
            if let height = try arguments.optionalDouble("height"), !(1...300_000).contains(height) {
                throw CompositorMCPCommandError.invalid("height must be between 1 and 300,000 pixels.")
            }
            _ = try arguments.optionalDouble("x"); _ = try arguments.optionalDouble("y"); _ = try arguments.optionalDouble("rotation")
            _ = try arguments.optionalBool("flipX"); _ = try arguments.optionalBool("flipY")
            if let requested = try arguments.optionalString("sampling"), LayerSampling.matching(requested) == nil {
                throw CompositorMCPCommandError.invalid("Unknown sampling mode: \(requested)")
            }
        case "layer.distort":
            let id = try resolveLayer(arguments.requiredString("layerId"), session: session)
            try requireLayer(id, session: session)
            _ = try requireDistortCorners(arguments)
        // MARK: Layer masks
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
        // MARK: Selection
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
        case "selection.rectangle", "selection.ellipse":
            _ = try requireSelectionRect(arguments)
            _ = try requireSelectionMode(arguments)
            guard session.document != nil else { throw CompositorMCPCommandError(code: "document_required", message: "No document is open.") }
            guard session.canEditSelection else {
                throw CompositorMCPCommandError(code: "selection_unavailable", message: "The selection cannot be changed while another edit is active.")
            }
        case "selection.polygon":
            _ = try requirePolygonPoints(arguments)
            _ = try requireSelectionMode(arguments)
            guard session.document != nil else { throw CompositorMCPCommandError(code: "document_required", message: "No document is open.") }
            guard session.canEditSelection else {
                throw CompositorMCPCommandError(code: "selection_unavailable", message: "The selection cannot be changed while another edit is active.")
            }
        case "selection.magicWand":
            let point = CGPoint(x: try arguments.requiredDouble("x"), y: try arguments.requiredDouble("y"))
            if let tolerance = try arguments.optionalDouble("tolerance"), !(0...255).contains(tolerance) {
                throw CompositorMCPCommandError.invalid("tolerance must be between 0 and 255.")
            }
            _ = try arguments.optionalBool("contiguous")
            _ = try arguments.optionalBool("sampleAllLayers")
            if let sampleSize = try arguments.optionalString("sampleSize"), wandSampleSize(sampleSize) == nil {
                throw CompositorMCPCommandError.invalid("sampleSize must be Point Sample, 3 by 3 Average or 5 by 5 Average.")
            }
            _ = try requireSelectionMode(arguments)
            guard let document = session.document else { throw CompositorMCPCommandError(code: "document_required", message: "No document is open.") }
            // The wand flood-fill allocates per-pixel masks; refuse canvases beyond the
            // pixel budget upstream already applies to shape rasterisation.
            guard Int(document.size.width) * Int(document.size.height) <= EditorSession.maxShapePixels else {
                throw CompositorMCPCommandError.invalid("The canvas is too large for the magic wand.")
            }
            // The wand tool silently ignores clicks outside the canvas; through MCP that is
            // reported as invalid input because such a point can never produce a selection.
            guard point.x >= 0, point.y >= 0, point.x < document.size.width, point.y < document.size.height else {
                throw CompositorMCPCommandError.invalid("x and y must lie inside the canvas.")
            }
            guard session.canEditSelection else {
                throw CompositorMCPCommandError(code: "selection_unavailable", message: "The selection cannot be changed while another edit is active.")
            }
        case "selection.expand", "selection.contract":
            let pixels = try arguments.requiredInt("pixels")
            // resizeSelection silently ignores |delta| > 500, so accept only what upstream applies.
            guard (1...500).contains(pixels) else { throw CompositorMCPCommandError.invalid("pixels must be between 1 and 500.") }
            guard session.selection != nil, session.canModifySelection else { throw CompositorMCPCommandError(code: "selection_required", message: "No editable selection exists.") }
        // MARK: Pixels and preview
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
        // MARK: Paint and filters
        case "paint.brushStroke", "paint.spotHeal", "paint.clone", "paint.blur", "paint.gradient", "paint.shape":
            try validatePaint(operation.name, arguments: arguments, session: session)
        case "adjustment.add", "adjustment.update", "filter.apply", "pixels.contentAwareFill":
            try validateFilterAndAdjustment(operation.name, arguments: arguments, session: session)
        default:
            throw CompositorMCPCommandError(code: "operation_not_implemented", message: "\(operation.name) is not implemented.")
        }
    }

    // MARK: - Validation helpers

    /// Internal rather than private so CompositorMCPFilters.swift can resolve targets.
    @discardableResult
    func requireLayer(_ id: UUID, session: EditorSession) throws -> ImageLayer {
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
        let corners = try raw.map { try parsePoint($0, message: "corners must contain {x, y} points.") }
        guard DistortWarp.isUsable(corners) else {
            throw CompositorMCPCommandError.invalid("corners must describe a convex, non-degenerate quadrilateral.")
        }
        return corners
    }

    /// The options-bar selection combination, exactly as `selectionModeChoice` offers it.
    private func requireSelectionMode(_ arguments: [String: CompositorMCPJSON]) throws -> SelectionMode {
        switch try arguments.optionalString("mode") ?? "replace" {
        case "replace": return .replace
        case "add": return .add
        case "subtract": return .subtract
        default: throw CompositorMCPCommandError.invalid("mode must be replace, add or subtract.")
        }
    }

    /// A document-space marquee box. The Marquee quantises drags to whole pixels; the API
    /// takes the caller's bounds as given so `selection.get` reports them back unchanged.
    private func requireSelectionRect(_ arguments: [String: CompositorMCPJSON]) throws -> CGRect {
        let x = try arguments.requiredDouble("x"), y = try arguments.requiredDouble("y")
        let width = try arguments.requiredDouble("width"), height = try arguments.requiredDouble("height")
        guard width >= 1, height >= 1 else {
            throw CompositorMCPCommandError.invalid("width and height must be at least 1.")
        }
        return CGRect(x: x, y: y, width: width, height: height)
    }

    /// The polygonal lasso's document-space vertices, in drawing order.
    private func requirePolygonPoints(_ arguments: [String: CompositorMCPJSON]) throws -> [CGPoint] {
        guard let raw = arguments["points"]?.array, (3...10_000).contains(raw.count) else {
            throw CompositorMCPCommandError.invalid("points must be an array of 3 to 10,000 {x, y} points.")
        }
        return try raw.map { try parsePoint($0, message: "points must contain {x, y} points.") }
    }

    /// The options-bar sample sizes, matched on their upstream display titles.
    private func wandSampleSize(_ value: String) -> WandSampleSize? {
        WandSampleSize.matching(value, by: \.title)
    }

    // MARK: - Apply dispatch

    /// Shared marquee/lasso apply: the shape is clipped to the canvas and combined with the
    /// current selection through `applySelection`, as `finishLasso` does. An outline whose
    /// clipped area is empty selects nothing — in New mode it deselects — so no explicit
    /// empty selection is created (its `CGRect.null` bounds would not serialise to JSON).
    private func applySelectionShape(_ shape: CGPath, mode: SelectionMode, name: String, session: EditorSession) throws -> Outcome {
        guard let document = session.document, session.canEditSelection else {
            throw CompositorMCPCommandError(code: "selection_unavailable", message: "The selection cannot be changed while another edit is active.")
        }
        let canvas = CGPath(rect: CGRect(origin: .zero, size: document.size), transform: nil)
        let clipped = shape.intersection(canvas, using: .winding)
        let bounds = clipped.boundingBoxOfPath
        guard !clipped.isEmpty, bounds.width > 0, bounds.height > 0 else {
            if mode == .replace { session.deselect() }
            return selectionOutcome(session, mutated: true)
        }
        session.applySelection(shape, mode: mode, name: name)
        return selectionOutcome(session, mutated: true)
    }

    /// Internal so CompositorMCPPaint.swift can build paint outcomes.
    struct Outcome {
        let value: CompositorMCPJSON
        let mutated: Bool
    }

    private func apply(_ operation: CompositorMCPOperation) async throws -> Outcome {
        try validate(operation)
        let arguments = operation.arguments ?? [:]
        let session = workspace.current.session

        switch operation.name {
        // MARK: Reads
        case "app.ping":
            return Outcome(value: ping(), mutated: false)
        case "app.getState":
            return Outcome(value: state(includeLayers: try arguments.optionalBool("includeLayers") ?? true), mutated: false)
        case "workspace.list":
            return Outcome(value: state(includeLayers: false), mutated: false)
        case "layer.list":
            let requested = try arguments.optionalString("projectId") ?? "current"
            let tab = try resolveProject(requested)
            let layers = tab.session.document?.layers.map {
                CompositorMCPStateBuilder(workspace: workspace, revision: revision).layer($0)
            } ?? []
            return Outcome(value: .object([
                "projectId": .string(tab.id.uuidString),
                "documentId": .uuid(tab.session.document?.id),
                "activeLayerId": .uuid(tab.session.activeLayerID),
                "selectedLayerIds": .array(tab.session.selectedLayerIDs.map(\.uuidString).sorted().map(CompositorMCPJSON.string)),
                "layers": .array(layers)
            ]), mutated: false)
        case "selection.get":
            return selectionOutcome(session, mutated: false)
        // MARK: Workspace and documents
        case "workspace.select":
            let tab = try resolveProject(arguments.requiredString("projectId"))
            guard workspace.canSwitch || tab.id == workspace.selectedID else { throw CompositorMCPCommandError.busy("The current project cannot be switched while an edit is active.") }
            let changed = tab.id != workspace.selectedID
            workspace.select(tab.id)
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
            case "jpeg":
                let raster = try await ImageExporter.shared.render(snapshot)
                var options = JPEGOptions()
                options.quality = min(1, max(0, try arguments.optionalDouble("quality") ?? 0.85))
                let colour = try arguments.optionalString("background") ?? "#FFFFFF"
                let rgb = try parseHex(colour, argument: "background")
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
            try requireSettledDocument(session)
            session.isProjectBusy = true
            defer { session.isProjectBusy = false }
            do {
                let resized = try await CanvasResizer.shared.resize(snapshot,
                    to: CanvasSizeOptions(width: width, height: height, anchor: anchorIndex))
                session.applyDocumentSize(resized, actionName: "Canvas Size")
            } catch {
                throw CompositorMCPCommandError(code: "resize_failed", message: error.localizedDescription)
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
            try requireSettledDocument(session)
            session.isProjectBusy = true
            defer { session.isProjectBusy = false }
            do {
                let resized = try await ImageResizer.shared.resize(snapshot,
                    to: ImageSizeOptions(width: width, height: height, resolution: resolution))
                session.applyImageSize(resized)
            } catch {
                throw CompositorMCPCommandError(code: "resize_failed", message: error.localizedDescription)
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
            // Re-check at apply time: another op in the same batch may have left a
            // pending edit (including a crop rect) after this op was validated.
            try requireSettledDocument(session)
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
        // MARK: History
        case "history.undo":
            guard session.canUndo else { throw CompositorMCPCommandError(code: "undo_unavailable", message: "Nothing can be undone.") }
            session.undo()
            return Outcome(value: .object(["undone": .bool(true)]), mutated: true)
        case "history.redo":
            guard session.canRedo else { throw CompositorMCPCommandError(code: "redo_unavailable", message: "Nothing can be redone.") }
            session.redo()
            return Outcome(value: .object(["redone": .bool(true)]), mutated: true)
        // MARK: Layers
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
            // Go through selectLayer so switching the active layer commits a pending
            // transform or gradient instead of leaving it attached to the old layer.
            session.selectLayer(nextActive)
            session.selectedLayerIDs = nextSelected
            session.isMaskSelected = nextMaskTarget
            return Outcome(value: .object(["selectedLayerIds": .array(ids.map { .string($0.uuidString) })]), mutated: changed)
        case "layer.addBlank":
            guard session.document != nil, session.canEditLayers else { throw CompositorMCPCommandError(code: "document_required", message: "Open or create an editable document first.") }
            // Argument reads stay outside the edit so a throw can never strand a pending one.
            let name = try arguments.optionalString("name")
            session.beginEdit("Add Layer")
            session.addBlankLayer()
            if let name = name, !name.isEmpty, let id = session.activeLayerID,
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
            try requireLayer(id, session: session)
            let dependants = dependentMaskTargets(forDeleting: id, session: session)
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
            guard let mode = LayerBlendMode.matching(requested) else {
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
        // MARK: Layer groups
        case "layer.group":
            guard session.selectedLayerIDs.count > 0 else { throw CompositorMCPCommandError(code: "layer_required", message: "Select at least one layer first.") }
            // Read before beginEdit so a throw cannot strand a pending edit.
            let name = try arguments.optionalString("name")
            let previousActive = session.activeLayerID
            session.beginEdit("Group Layers")
            session.groupSelectedLayers()
            // groupSelectedLayers() refuses silently at the layer cap or on an invalid
            // hierarchy; only a newly created (freshly activated) group takes the name —
            // otherwise the write would land on whatever layer was active before.
            if let name = name, !name.isEmpty, session.activeLayer?.isGroup == true,
               let id = session.activeLayerID, id != previousActive,
               let index = session.document?.layers.firstIndex(where: { $0.id == id }) {
                session.document?.layers[index].name = name
            }
            session.endEdit()
            guard session.activeLayer?.isGroup == true, session.activeLayerID != previousActive else {
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
            let positions = Dictionary(uniqueKeysWithValues: layers.enumerated().map { ($0.element.id, $0.offset) })
            let childrenByParent = Dictionary(grouping: layers, by: \.parentID)
            /// Flat index just past a layer's whole subtree. Descendants are not contiguous
            /// upstream — grouping appends them at the array end — so the subtree is walked.
            func subtreeEnd(_ root: UUID) -> Int {
                var end = (positions[root] ?? -1) + 1
                var pending = [root]
                while let next = pending.popLast() {
                    for child in childrenByParent[next] ?? [] {
                        end = max(end, (positions[child.id] ?? -1) + 1)
                        pending.append(child.id)
                    }
                }
                return end
            }
            var insertion: Int?
            var seen = 0
            for (index, layer) in layers.enumerated() where layer.parentID == parent {
                if seen == rank { insertion = index; break }
                seen += 1
            }
            // When the dissolved group was its parent's last sibling the loop finds no rank
            // slot; the children still take the group's place at the end of the parent's
            // subtree — just past the last remaining sibling's subtree — rather than the
            // array end, where unrelated content may sit.
            let insertionPoint = insertion
                ?? layers.lastIndex(where: { $0.parentID == parent }).map { subtreeEnd(layers[$0].id) }
                ?? (parent.flatMap { positions[$0].map { $0 + 1 } } ?? layers.count)
            layers.insert(contentsOf: children, at: insertionPoint)
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
        // MARK: Layer transforms
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
            guard var transform = session.transformEdit?.draft else {
                session.cancelTransform()
                throw CompositorMCPCommandError(code: "transform_unavailable", message: "The layer cannot be transformed.")
            }
            if let value = try arguments.optionalDouble("x") { transform.origin.x = CGFloat(value) }
            if let value = try arguments.optionalDouble("y") { transform.origin.y = CGFloat(value) }
            if let value = try arguments.optionalDouble("width") { transform.size.width = CGFloat(value) }
            if let value = try arguments.optionalDouble("height") { transform.size.height = CGFloat(value) }
            if let value = try arguments.optionalDouble("rotation") { transform.rotation = CGFloat(value) }
            if let value = try arguments.optionalBool("flipX") { transform.flipX = value }
            if let value = try arguments.optionalBool("flipY") { transform.flipY = value }
            if let requested = try arguments.optionalString("sampling") {
                guard let sampling = LayerSampling.matching(requested) else {
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
            try requireLayer(id, session: session)
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
            session.brushError = nil
            session.previewCorners(corners)
            session.commitTransform()
            if let message = session.brushError {
                session.brushError = nil
                throw CompositorMCPCommandError(code: "distort_failed", message: message)
            }
            return Outcome(value: layerValue(session.activeLayer), mutated: true)
        // MARK: Layer masks
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
        // MARK: Selection
        case "selection.all":
            guard session.document != nil else { throw CompositorMCPCommandError(code: "document_required", message: "No document is open.") }
            // setSelection skips a no-op write, so the undo count is the mutation signal.
            let selectAllBefore = session.history.undoCount
            session.selectAll()
            return selectionOutcome(session, mutated: session.history.undoCount > selectAllBefore)
        case "selection.none":
            let deselectBefore = session.history.undoCount
            session.deselect()
            return Outcome(value: .null, mutated: session.history.undoCount > deselectBefore)
        case "selection.invert":
            guard session.selection != nil, session.canEditSelection else { throw CompositorMCPCommandError(code: "selection_required", message: "No editable selection exists.") }
            let invertBefore = session.history.undoCount
            session.invertSelection()
            return selectionOutcome(session, mutated: session.history.undoCount > invertBefore)
        case "selection.fromLayer":
            let id = try resolveLayer(arguments.requiredString("layerId"), session: session)
            guard session.document?.layers.first(where: { $0.id == id })?.asset != nil else { throw CompositorMCPCommandError.notFound("Layer pixels not found.") }
            let fromLayerBefore = session.history.undoCount
            session.loadLayerSelection(layerID: id)
            return selectionOutcome(session, mutated: session.history.undoCount > fromLayerBefore)
        case "selection.fromMask":
            let id = try resolveLayer(arguments.requiredString("layerId"), session: session)
            guard session.document?.layers.first(where: { $0.id == id })?.mask != nil else { throw CompositorMCPCommandError.notFound("Layer mask not found.") }
            let fromMaskBefore = session.history.undoCount
            session.loadMaskSelection(layerID: id)
            return selectionOutcome(session, mutated: session.history.undoCount > fromMaskBefore)
        case "selection.rectangle":
            let rect = try requireSelectionRect(arguments)
            let mode = try requireSelectionMode(arguments)
            return try applySelectionShape(CGPath(rect: rect, transform: nil), mode: mode, name: "Rectangular Marquee", session: session)
        case "selection.ellipse":
            let rect = try requireSelectionRect(arguments)
            let mode = try requireSelectionMode(arguments)
            return try applySelectionShape(CGPath(ellipseIn: rect, transform: nil), mode: mode, name: "Elliptical Marquee", session: session)
        case "selection.polygon":
            let points = try requirePolygonPoints(arguments)
            let mode = try requireSelectionMode(arguments)
            let outline = CGMutablePath()
            outline.addLines(between: points)
            outline.closeSubpath()
            return try applySelectionShape(outline, mode: mode, name: "Polygonal Lasso", session: session)
        case "selection.magicWand":
            let point = CGPoint(x: try arguments.requiredDouble("x"), y: try arguments.requiredDouble("y"))
            let mode = try requireSelectionMode(arguments)
            guard let document = session.document else { throw CompositorMCPCommandError(code: "document_required", message: "No document is open.") }
            guard point.x >= 0, point.y >= 0, point.x < document.size.width, point.y < document.size.height else {
                throw CompositorMCPCommandError.invalid("x and y must lie inside the canvas.")
            }
            guard session.canEditSelection else {
                throw CompositorMCPCommandError(code: "selection_unavailable", message: "The selection cannot be changed while another edit is active.")
            }
            // The same session entry point the canvas tool uses; the options-bar settings
            // are restored afterwards so one call does not reconfigure the user's wand.
            // When nothing matches, upstream clears the selection in New mode and leaves
            // it alone otherwise — the outcome is simply the resulting selection state.
            let previousSettings = session.wandSettings
            var settings = previousSettings
            settings.tolerance = Int(min(255, max(0, try arguments.optionalDouble("tolerance") ?? 32)).rounded())
            settings.contiguous = try arguments.optionalBool("contiguous") ?? true
            settings.sampleAllLayers = try arguments.optionalBool("sampleAllLayers") ?? false
            if let sampleSize = try arguments.optionalString("sampleSize"), let size = wandSampleSize(sampleSize) {
                settings.sampleSize = size
            }
            session.wandSettings = settings
            defer { session.wandSettings = previousSettings }
            session.brushError = nil
            let wandBefore = session.history.undoCount
            await session.magicWand(at: point, mode: mode)
            if let message = session.brushError {
                session.brushError = nil
                throw CompositorMCPCommandError(code: "wand_failed", message: message)
            }
            return selectionOutcome(session, mutated: session.history.undoCount > wandBefore)
        case "selection.expand":
            guard session.selection != nil, session.canModifySelection else { throw CompositorMCPCommandError(code: "selection_required", message: "No editable selection exists.") }
            let expandBefore = session.history.undoCount
            session.expandSelection(by: try arguments.requiredInt("pixels"))
            return selectionOutcome(session, mutated: session.history.undoCount > expandBefore)
        case "selection.contract":
            guard session.selection != nil, session.canModifySelection else { throw CompositorMCPCommandError(code: "selection_required", message: "No editable selection exists.") }
            let contractBefore = session.history.undoCount
            session.contractSelection(by: try arguments.requiredInt("pixels"))
            return selectionOutcome(session, mutated: session.history.undoCount > contractBefore)
        // MARK: Pixels
        case "pixels.fill":
            guard session.canEditPixels else { throw CompositorMCPCommandError(code: "pixel_edit_unavailable", message: "The active layer or mask cannot be filled.") }
            let target = try arguments.optionalString("target") ?? "foreground"
            guard target == "foreground" || target == "background" else { throw CompositorMCPCommandError.invalid("target must be foreground or background.") }
            // Fill, clear and invert report through brushError — the same channel the
            // canvas flashes — rather than throwing. A fill that covers nothing commits
            // no undo entry upstream, so `mutated` tracks whether history actually grew.
            let undoCount = session.history.undoCount
            session.brushError = nil
            await session.fillSelection(with: target == "background" ? .background : .foreground)
            if let message = session.brushError {
                session.brushError = nil
                throw CompositorMCPCommandError(code: "fill_failed", message: message)
            }
            return Outcome(value: .object(["filled": .bool(true), "target": .string(target)]),
                           mutated: session.history.undoCount > undoCount)
        case "pixels.clear":
            guard session.selection != nil, session.canEditPixels else { throw CompositorMCPCommandError(code: "selection_required", message: "Clearing pixels requires an editable selection.") }
            let undoCount = session.history.undoCount
            session.brushError = nil
            await session.clearSelectedPixels()
            if let message = session.brushError {
                session.brushError = nil
                throw CompositorMCPCommandError(code: "clear_failed", message: message)
            }
            return Outcome(value: .object(["cleared": .bool(true)]), mutated: session.history.undoCount > undoCount)
        case "pixels.invert":
            guard session.canInvert else { throw CompositorMCPCommandError(code: "pixel_edit_unavailable", message: "The active layer or mask cannot be inverted.") }
            let undoCount = session.history.undoCount
            session.brushError = nil
            await session.invertPixels()
            if let message = session.brushError {
                session.brushError = nil
                throw CompositorMCPCommandError(code: "invert_failed", message: message)
            }
            return Outcome(value: .object(["inverted": .bool(true)]), mutated: session.history.undoCount > undoCount)
        // MARK: Paint and filters
        case "paint.brushStroke", "paint.spotHeal", "paint.clone", "paint.blur", "paint.gradient", "paint.shape":
            return try await applyPaint(operation.name, arguments: arguments, session: session)
        case "adjustment.add", "adjustment.update", "filter.apply", "pixels.contentAwareFill":
            return try await applyFilterAndAdjustment(operation.name, arguments: arguments, session: session)
        // MARK: Preview
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

    // MARK: - Apply helpers

    private func cleanupPreviewFiles(in directory: URL) {
        let manager = FileManager.default
        guard let files = try? manager.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.contentModificationDateKey],
            options: [.skipsHiddenFiles]
        ) else { return }
        let cutoff = Date().addingTimeInterval(-24 * 60 * 60)
        let sorted = files.filter { $0.lastPathComponent.hasPrefix("preview-") }
            .map { (url: $0, modified: (try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast) }
            .sorted { $0.modified > $1.modified }
        for (index, file) in sorted.enumerated() {
            if index >= 20 || file.modified < cutoff { try? manager.removeItem(at: file.url) }
        }
    }

    private func resolveProject(_ value: String) throws -> ProjectTab {
        if value == "current" { return workspace.current }
        guard let id = UUID(uuidString: value), let tab = workspace.tabs.first(where: { $0.id == id }) else {
            throw CompositorMCPCommandError.notFound("Project not found: \(value)")
        }
        return tab
    }

    /// Internal rather than private so CompositorMCPFilters.swift can resolve targets.
    func resolveLayer(_ value: String, session: EditorSession) throws -> UUID {
        if value == "active" {
            guard let id = session.activeLayerID else { throw CompositorMCPCommandError(code: "layer_required", message: "No active layer exists.") }
            return id
        }
        guard let id = UUID(uuidString: value) else { throw CompositorMCPCommandError.invalid("Invalid layer UUID: \(value)") }
        return id
    }

    /// Internal so CompositorMCPPaint.swift can return the shape layer it creates.
    func layerValue(_ layer: ImageLayer?) -> CompositorMCPJSON {
        guard let layer else { return .null }
        return CompositorMCPStateBuilder(workspace: workspace, revision: revision).layer(layer)
    }

    /// The selection.* outcome: the resulting selection state plus whether it changed.
    private func selectionOutcome(_ session: EditorSession, mutated: Bool) -> Outcome {
        Outcome(value: CompositorMCPStateBuilder(workspace: workspace, revision: revision).selection(session), mutated: mutated)
    }

    // MARK: - Audit

    /// One execute call's audit records, flushed in a single append so the log does
    /// not open/seek/write/close once per operation.
    private func audit(requestId: String,
                       entries: [(operation: String, ok: Bool, details: [String: CompositorMCPJSON])]) async {
        guard paths.configuration.auditLogging, !entries.isEmpty else { return }
        await CompositorMCPAuditLog.shared.append(requestId: requestId, entries: entries)
    }

    // MARK: - Revision tracking

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
            values.append(layer.id.uuidString)
            values.append(layer.name)
            values.append(String(layer.isVisible))
            values.append(layer.parentID?.uuidString ?? "")
            values.append(String(layer.isGroup))
            values.append(String(layer.opacity))
            values.append(layer.blendMode.rawValue)
            values.append(String(describing: layer.transform.origin.x))
            values.append(String(describing: layer.transform.origin.y))
            values.append(String(describing: layer.transform.size.width))
            values.append(String(describing: layer.transform.size.height))
            values.append(String(describing: layer.transform.rotation))
            values.append(String(layer.transform.flipX))
            values.append(String(layer.transform.flipY))
            values.append(layer.maskSourceID?.uuidString ?? "")
            values.append(String(layer.mask?.isEnabled ?? false))
            values.append(String(layer.mask?.isLinked ?? false))
            if let image = layer.asset?.image { values.append(String(ObjectIdentifier(image).hashValue)) }
            if let image = layer.mask?.asset.image { values.append(String(ObjectIdentifier(image).hashValue)) }
        }
        if let selection = session.selection {
            let bounds = selection.path.boundingBoxOfPath
            values.append(String(describing: bounds.minX))
            values.append(String(describing: bounds.minY))
            values.append(String(describing: bounds.width))
            values.append(String(describing: bounds.height))
            values.append(String(selection.antialiased))
        } else {
            values.append("no-selection")
        }
        return values.joined(separator: "|")
    }

    // MARK: - Decoding and idempotency

    /// Internal rather than private so CompositorMCPPaint.swift's `paintColorValue` shares it.
    func parseHex(_ value: String, argument: String) throws -> (CGFloat, CGFloat, CGFloat) {
        let trimmed = value.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        guard trimmed.count == 6, let integer = Int(trimmed, radix: 16) else { throw CompositorMCPCommandError.invalid("\(argument) must be a six-digit hex colour.") }
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
        // Each cached entry retains a full post-execute snapshot, so the cache stays small.
        while idempotencyOrder.count > 20 {
            let oldest = idempotencyOrder.removeFirst()
            idempotencyCache.removeValue(forKey: oldest)
        }
    }
}
