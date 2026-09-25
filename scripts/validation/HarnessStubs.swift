import SwiftUI

struct CanvasSizeSheet: View {
    let document: CanvasDocument
    let foreground: PaletteColor
    let background: PaletteColor
    let onCommit: (CanvasSizeOptions) -> Void
    init(document: CanvasDocument, foreground: PaletteColor, background: PaletteColor, onCommit: @escaping (CanvasSizeOptions) -> Void) {
        self.document = document; self.foreground = foreground; self.background = background; self.onCommit = onCommit
    }
    var body: some View { EmptyView() }
}

struct ImageSizeSheet: View {
    let document: CanvasDocument
    let onCommit: (ImageSizeOptions) -> Void
    init(document: CanvasDocument, onCommit: @escaping (ImageSizeOptions) -> Void) {
        self.document = document; self.onCommit = onCommit
    }
    var body: some View { EmptyView() }
}

final class EffectsPreviewCache {
    func seed(_ id: UUID, image: CGImage, placement: LayerTransform) {}
    func rendered(_ id: UUID) -> (image: CGImage, inset: CGFloat, placement: LayerTransform?)? { nil }
}

struct TrimSheet: View {
    let finish: (TrimOptions?) -> Void
    init(finish: @escaping (TrimOptions?) -> Void) { self.finish = finish }
    var body: some View { EmptyView() }
}

struct PSDConversionRequest: Identifiable, Equatable, Sendable {
    let id: UUID
    let title: String
    let confirmTitle: String
    var conversions: [PSDConversion]
    var isReading: Bool
    init(id: UUID = UUID(), title: String, confirmTitle: String, conversions: [PSDConversion], isReading: Bool = false) {
        self.id = id; self.title = title; self.confirmTitle = confirmTitle; self.conversions = conversions; self.isReading = isReading
    }
}

struct JPEGExportSheet: View {
    let raster: ExportRaster
    let finish: (Data?) -> Void
    init(raster: ExportRaster, finish: @escaping (Data?) -> Void) {
        self.raster = raster; self.finish = finish
    }
    var body: some View { EmptyView() }
}

final class FloatingPanelController: NSObject {
    let identifier: NSUserInterfaceItemIdentifier
    init(name: String) { identifier = NSUserInterfaceItemIdentifier(name); super.init() }
    static func refocus(_ identifier: NSUserInterfaceItemIdentifier) {}
}

final class ColorPickerPanelController: NSObject {
    static func refocus() {}
}
