import AppKit
import Foundation

@MainActor
struct CompositorMCPStateBuilder {
    let workspace: ProjectWorkspace
    let revision: Int

    func snapshot(includeLayers: Bool = true) -> CompositorMCPJSON {
        let current = workspace.current
        let session = current.session
        let projects = workspace.tabs.map { tab -> CompositorMCPJSON in
            .object([
                "id": .string(tab.id.uuidString),
                "title": .string(tab.title),
                "selected": .bool(tab.id == workspace.selectedID),
                "modified": .bool(tab.session.isModified),
                "hasDocument": .bool(tab.session.document != nil),
                "path": tab.session.projectURL.map { .string($0.path) } ?? .null
            ])
        }

        var root: [String: CompositorMCPJSON] = [
            "revision": .int(revision),
            "projects": .array(projects),
            "selectedProjectId": .string(current.id.uuidString),
            "canSwitchProject": .bool(workspace.canSwitch),
            "busy": .bool(session.isProjectBusy || workspace.isManaging)
        ]

        if let document = session.document {
            var documentValue: [String: CompositorMCPJSON] = [
                "id": .string(document.id.uuidString),
                "width": .int(document.width),
                "height": .int(document.height),
                "resolution": .number(document.resolution),
                "layerCount": .int(document.layers.count),
                "activeLayerId": .uuid(session.activeLayerID),
                "selectedLayerIds": .array(session.selectedLayerIDs.map { .string($0.uuidString) }.sorted { ($0.string ?? "") < ($1.string ?? "") }),
                "maskTargeted": .bool(session.isMaskSelected),
                "modified": .bool(session.isModified),
                "canUndo": .bool(session.canUndo),
                "canRedo": .bool(session.canRedo),
                "selection": selection(session)
            ]
            if includeLayers {
                documentValue["layers"] = .array(document.layers.map(layer))
            }
            root["document"] = .object(documentValue)
        } else {
            root["document"] = .null
        }
        return .object(root)
    }

    func layer(_ value: ImageLayer) -> CompositorMCPJSON {
        let transform = value.transform
        var result: [String: CompositorMCPJSON] = [
            "id": .string(value.id.uuidString),
            "name": .string(value.name),
            "visible": .bool(value.isVisible),
            "parentId": .uuid(value.parentID),
            "group": .bool(value.isGroup),
            "opacity": .number(value.opacity),
            "blendMode": .string(value.blendMode.rawValue),
            "maskSourceId": .uuid(value.maskSourceID),
            "hasMask": .bool(value.mask != nil),
            "adjustment": .bool(value.adjustment != nil),
            "adjustmentKind": value.adjustment.map { .string($0.kind.rawValue) } ?? .null,
            "shape": .bool(value.shape != nil),
            "transform": .object([
                "x": .cgFloat(transform.origin.x),
                "y": .cgFloat(transform.origin.y),
                "width": .cgFloat(transform.size.width),
                "height": .cgFloat(transform.size.height),
                "rotation": .cgFloat(transform.rotation),
                "flipX": .bool(transform.flipX),
                "flipY": .bool(transform.flipY),
                "sampling": .string(transform.sampling.rawValue)
            ])
        ]
        if let asset = value.asset {
            result["pixels"] = .object([
                "width": .int(asset.image.width),
                "height": .int(asset.image.height)
            ])
        } else {
            result["pixels"] = .null
        }
        if let mask = value.mask {
            result["mask"] = .object([
                "enabled": .bool(mask.isEnabled),
                "linked": .bool(mask.isLinked),
                "width": .int(mask.asset.image.width),
                "height": .int(mask.asset.image.height)
            ])
        } else {
            result["mask"] = .null
        }
        return .object(result)
    }

    func selection(_ session: EditorSession) -> CompositorMCPJSON {
        guard let selection = session.selection else { return .null }
        let bounds = selection.path.boundingBoxOfPath
        // An explicit-empty selection (e.g. select-all then invert, or a contract past
        // the edge) yields CGRect.null with infinite components — encoding those would
        // throw and drop the whole response, so report the empty shape honestly.
        guard !selection.path.isEmpty, !bounds.isNull else {
            return .object([
                "exists": .bool(false),
                "antialiased": .bool(selection.antialiased),
                "bounds": .null
            ])
        }
        return .object([
            "exists": .bool(true),
            "antialiased": .bool(selection.antialiased),
            "bounds": .object([
                "x": .cgFloat(bounds.origin.x),
                "y": .cgFloat(bounds.origin.y),
                "width": .cgFloat(bounds.size.width),
                "height": .cgFloat(bounds.size.height)
            ])
        ])
    }

}
