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
