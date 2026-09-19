import AppKit
import CoreGraphics
import Foundation

/// paint.* operations: brush strokes, spot healing, clone stamping, blur/smudge/liquify,
/// gradients and shape layers.
///
/// Per the parity plan every stroke is synthesised through the same native classes the
/// canvas tools drive — `BrushStroke`, `WarpStroke`, the `fillGradient` raster path and
/// `finishShape`'s layer insertion — never UI gestures. `EditorSession.makeRasterEdit`
/// supplies the pixel budget and the selection clip, so a stroke made here clips to the
/// active selection exactly like a dragged one, and `commitRasterEdit` lands it as a single
/// named undo entry (nested inside the batch transaction when a batch groups it).
@MainActor
extension CompositorMCPCommandRouter {

    // MARK: - Validation dispatch

    /// Validates one paint.* operation's arguments and target. The guards mirror the
    /// corresponding tool entry points (`beginBrush`, `beginWarp`, `refreshGradient`,
    /// `finishShape`) rather than inventing new rules; state-dependent failures the tools
    /// would silently ignore are reported as no-op outcomes at apply time, not errors.
    func validatePaint(_ name: String, arguments: [String: CompositorMCPJSON], session: EditorSession) throws {
        switch name {
        case "paint.brushStroke":
            _ = try requireStrokePoints(arguments)
            let mode = try arguments.optionalString("mode") ?? "paint"
            guard mode == "paint" || mode == "erase" else {
                throw CompositorMCPCommandError.invalid("mode must be paint or erase.")
            }
            try validateBrushArguments(arguments)
            if let color = try arguments.optionalString("color") { _ = try paintColorValue(color, argument: "color") }
            _ = try requirePaintTarget(session, pixelsOnly: false, tool: "Brush")
        case "paint.spotHeal":
            _ = try requireStrokePoints(arguments)
            try validateBrushArguments(arguments)
            let mode = try arguments.optionalString("mode") ?? "Content-Aware"
            guard spotHealingMode(mode) != nil else {
                throw CompositorMCPCommandError.invalid("mode must be Content-Aware, Create Texture or Proximity Match.")
            }
            _ = try requirePaintTarget(session, pixelsOnly: true, tool: "Spot Healing")
        case "paint.clone":
            _ = try requireStrokePoints(arguments)
            _ = try requireDocumentPoint(arguments, key: "source")
            try validateBrushArguments(arguments)
            _ = try arguments.optionalBool("aligned")
            _ = try arguments.optionalBool("sampleAllLayers")
            _ = try requirePaintTarget(session, pixelsOnly: true, tool: "Clone Stamp")
        case "paint.blur":
            _ = try requireStrokePoints(arguments)
            let mode = try arguments.optionalString("mode") ?? "Blur"
            guard let tool = blurToolMode(mode) else {
                throw CompositorMCPCommandError.invalid("mode must be Blur, Smudge or Liquify.")
            }
            try validateBrushArguments(arguments, opacityKey: "strength")
            // Blur can soften a mask; Smudge and Liquify push pixels and refuse masks,
            // exactly as `beginBrush`/`beginWarp` route them.
            _ = try requirePaintTarget(session, pixelsOnly: tool != .blur, tool: tool.rawValue)
        case "paint.gradient":
            _ = try requireDocumentPoint(arguments, key: "start")
            _ = try requireDocumentPoint(arguments, key: "end")
            if let shape = try arguments.optionalString("shape"), gradientShape(shape) == nil {
                throw CompositorMCPCommandError.invalid("shape must be Linear or Radial.")
            }
            if let style = try arguments.optionalString("style"), gradientStyle(style) == nil {
                throw CompositorMCPCommandError.invalid("style must be Foreground to Background or Foreground to Transparent.")
            }
            if let opacity = try arguments.optionalDouble("opacity"), !(0...1).contains(opacity) {
                throw CompositorMCPCommandError.invalid("opacity must be between 0 and 1.")
            }
            _ = try arguments.optionalBool("reversed")
            _ = try requireGradientStops(arguments)
            _ = try requirePaintTarget(session, pixelsOnly: false, tool: "Gradient")
        case "paint.shape":
            let kind = try arguments.optionalString("kind") ?? "Rectangle"
            guard shapeKind(kind) != nil else {
                throw CompositorMCPCommandError.invalid("kind must be Rectangle or Ellipse.")
            }
            _ = try arguments.requiredDouble("x")
            _ = try arguments.requiredDouble("y")
            let width = try arguments.requiredDouble("width"), height = try arguments.requiredDouble("height")
            guard (1...30_000).contains(width.rounded()), (1...30_000).contains(height.rounded()) else {
                throw CompositorMCPCommandError.invalid("width and height must be between 1 and 30,000 pixels.")
            }
            if let radius = try arguments.optionalDouble("cornerRadius"), !(0...15_000).contains(radius) {
                throw CompositorMCPCommandError.invalid("cornerRadius must be between 0 and 15,000 pixels.")
            }
            if let color = try arguments.optionalString("color") { _ = try paintColorValue(color, argument: "color") }
            _ = try arguments.optionalString("name")
            // The Shape tool's own budget, with its own message.
            guard Int(width.rounded()) * Int(height.rounded()) <= EditorSession.maxShapePixels else {
                throw CompositorMCPCommandError.invalid("That shape is too large. A shape can cover up to 100 megapixels.")
            }
            guard session.document != nil else {
                throw CompositorMCPCommandError(code: "document_required", message: "No document is open.")
            }
            guard session.canEditLayers else {
                throw CompositorMCPCommandError(code: "shape_unavailable", message: "The shape cannot be drawn while another edit is active.")
            }
        default:
            throw CompositorMCPCommandError(code: "operation_not_implemented", message: "\(name) is not implemented.")
        }
    }

    // MARK: - Apply dispatch

    /// Executes one paint.* operation. `validatePaint` has already run via `apply`, so the
    /// argument reads below cannot fail; state guards are repeated because a batch's earlier
    /// operations may have changed the target since validation.
    func applyPaint(_ name: String, arguments: [String: CompositorMCPJSON], session: EditorSession) async throws -> Outcome {
        switch name {
        case "paint.brushStroke":
            let layer = try requirePaintTarget(session, pixelsOnly: false, tool: "Brush")
            let points = try requireStrokePoints(arguments)
            let mode = try arguments.optionalString("mode") ?? "paint"
            let color = try strokeColor(arguments, mask: session.isMaskSelected, session: session)
            var settings = strokeSettings(arguments, color: color, opacity: arguments["opacity"]?.number ?? 1)
            // Upstream only erases layer pixels; on a mask the stroke paints the mask tone,
            // which hides pixels where the mask tone is black — the mask form of erasing.
            settings.erasing = mode == "erase" && !session.isMaskSelected
            let stroke = try makeStroke(for: layer, settings: settings, session: session)
            for point in points { try append(point, to: stroke) }
            let undoName = stroke.isMask ? "Paint Mask" : (settings.erasing ? "Erase" : "Brush Stroke")
            return try await commitStroke(stroke, name: undoName, points: points.count, session: session)

        case "paint.spotHeal":
            let layer = try requirePaintTarget(session, pixelsOnly: true, tool: "Spot Healing")
            let points = try requireStrokePoints(arguments)
            let color = try strokeColor(arguments, mask: false, session: session)
            var settings = strokeSettings(arguments, color: color, opacity: arguments["opacity"]?.number ?? 1)
            // Spot Healing is a brush stroke whose painted coverage is rebuilt from nearby
            // pixels by `stroke.heal()` — which `commitStroke` runs, as `finishBrushImmediately` does.
            settings.healing = true
            settings.healingMode = spotHealingMode(try arguments.optionalString("mode") ?? "Content-Aware") ?? .contentAware
            let stroke = try makeStroke(for: layer, settings: settings, session: session)
            for point in points { try append(point, to: stroke) }
            return try await commitStroke(stroke, name: "Spot Healing", points: points.count, session: session)

        case "paint.clone":
            let layer = try requirePaintTarget(session, pixelsOnly: true, tool: "Clone Stamp")
            let points = try requireStrokePoints(arguments)
            let source = try requireDocumentPoint(arguments, key: "source")
            guard let document = session.document else {
                throw CompositorMCPCommandError(code: "document_required", message: "No document is open.")
            }
            // The same option-click → stroke-start sequence the tool performs: a new source
            // point starts a new alignment, while an unchanged aligned source reuses the
            // previous stroke's offset. `cloneSettings` are the options bar's state and are
            // restored; `cloneSource`/`cloneOffset` persist exactly as an option-click leaves
            // them, so consecutive aligned calls keep tracking like repeated strokes do.
            let aligned = try arguments.optionalBool("aligned") ?? true
            let previousCloneSettings = session.cloneSettings
            var cloneSettings = previousCloneSettings
            cloneSettings.aligned = aligned
            cloneSettings.sampleAllLayers = try arguments.optionalBool("sampleAllLayers") ?? false
            session.cloneSettings = cloneSettings
            if session.cloneSource != source { session.setCloneSource(source) }
            guard let offset = session.cloneStrokeOffset(at: points[0]) else {
                session.cloneSettings = previousCloneSettings
                throw CompositorMCPCommandError.invalid("Clone Stamp needs a source point to sample from.")
            }
            guard let sample = session.cloneSample(document) else {
                session.cloneSettings = previousCloneSettings
                throw CompositorMCPCommandError(code: "clone_failed", message: "The clone source could not be sampled.")
            }
            session.cloneOffset = offset
            session.cloneSettings = previousCloneSettings
            let color = try strokeColor(arguments, mask: false, session: session)
            let settings = strokeSettings(arguments, color: color, opacity: arguments["opacity"]?.number ?? 1)
            let stroke = try makeStroke(for: layer, settings: settings, session: session)
            stroke.clone = (sample, offset)
            for point in points { try append(point, to: stroke) }
            var outcome = try await commitStroke(stroke, name: "Clone Stamp", points: points.count, session: session)
            if case .object(var value) = outcome.value {
                value["source"] = .object(["x": .cgFloat(source.x), "y": .cgFloat(source.y)])
                value["offset"] = .object(["x": .cgFloat(offset.width), "y": .cgFloat(offset.height)])
                outcome = Outcome(value: .object(value), mutated: outcome.mutated)
            }
            return outcome

        case "paint.blur":
            let tool = blurToolMode(try arguments.optionalString("mode") ?? "Blur") ?? .blur
            let layer = try requirePaintTarget(session, pixelsOnly: tool != .blur, tool: tool.rawValue)
            guard let document = session.document else {
                throw CompositorMCPCommandError(code: "document_required", message: "No document is open.")
            }
            let points = try requireStrokePoints(arguments)
            // The warp engines read strength from the settings' opacity channel.
            let settings = strokeSettings(arguments, color: .black, opacity: arguments["strength"]?.number ?? 1)
            if tool == .blur {
                // Blur paints a softened copy of the layer (or its mask) through the tip, in
                // place. `blurSample` derives sigma from the session's brushSettings diameter,
                // so the per-call settings are installed for the sampling call only.
                let previousBrushSettings = session.brushSettings
                session.brushSettings = settings
                let sample = session.blurSample(document, mask: session.isMaskSelected)
                session.brushSettings = previousBrushSettings
                guard let sample else {
                    return strokeOutcome(stroke: nil, layer: layer, mask: session.isMaskSelected, points: points.count, applied: false)
                }
                let stroke = try makeStroke(for: layer, settings: settings, session: session)
                stroke.clone = (sample, .zero)
                stroke.isBlur = true
                for point in points { try append(point, to: stroke) }
                return try await commitStroke(stroke, name: "Blur", points: points.count, session: session)
            }
            // Smudge/Liquify: WarpStroke works on the layer's document-space composite, then
            // `finishWarp` paints the result back along the dabbed path — mirrored exactly.
            guard let image = layer.asset?.image else {
                return strokeOutcome(stroke: nil, layer: layer, mask: false, points: points.count, applied: false)
            }
            let warp: WarpStroke
            do {
                warp = try WarpStroke(layer: layer, image: image, transform: session.displayedTransform(for: layer),
                                      canvas: document.size, mode: tool, settings: settings)
            } catch {
                throw CompositorMCPCommandError(code: "paint_failed", message: error.localizedDescription)
            }
            for point in points { warp.append(point) }
            // A single-point warp never dabs — the tool's mouse-up on a click does nothing.
            guard !warp.points.isEmpty, let result = warp.image else {
                return strokeOutcome(stroke: nil, layer: layer, mask: false, points: points.count, applied: false)
            }
            // `finishWarp`'s commit stroke: a hard tip slightly wider than the brush covers
            // everything the stroke moved; `replacesWithClone` writes the warped pixels
            // rather than overlaying them.
            var commitSettings = BrushSettings()
            commitSettings.diameter = warp.diameter + 4
            commitSettings.hardness = 1
            commitSettings.opacity = 1
            let stroke = try makeStroke(for: layer, settings: commitSettings, session: session)
            stroke.clone = (result, .zero)
            stroke.replacesWithClone = true
            for point in warp.points { try append(point, to: stroke) }
            return try await commitStroke(stroke, name: tool.rawValue, points: warp.points.count, session: session)

        case "paint.gradient":
            let layer = try requirePaintTarget(session, pixelsOnly: false, tool: "Gradient")
            guard let document = session.document else {
                throw CompositorMCPCommandError(code: "document_required", message: "No document is open.")
            }
            let start = try requireDocumentPoint(arguments, key: "start")
            let end = try requireDocumentPoint(arguments, key: "end")
            let shape = gradientShape(try arguments.optionalString("shape") ?? "Linear") ?? .linear
            let opacity = try arguments.optionalDouble("opacity") ?? 1
            let reversed = try arguments.optionalBool("reversed") ?? false
            // A drag shorter than half a pixel is the click `endGradientDrag` discards, and a
            // fully transparent gradient commits nothing.
            guard hypot(end.x - start.x, end.y - start.y) >= 0.5, opacity > 0 else {
                return strokeOutcome(stroke: nil, layer: layer, mask: session.isMaskSelected, points: 0, applied: false)
            }
            if let stops = try requireGradientStops(arguments) {
                return try await applyStopsGradient(stops: stops, shape: shape, start: start, end: end,
                                                    reversed: reversed, opacity: opacity,
                                                    layer: layer, document: document, session: session)
            }
            // The beginGradient → refreshGradient → commitGradient flow without the tool gate:
            // `gradientColors` reads the options-bar settings, so they are installed for the
            // fill call only. The commit name is the same `commitGradient` uses.
            let previousGradient = session.gradientSettings
            var gradient = previousGradient
            gradient.shape = shape
            gradient.style = gradientStyle(try arguments.optionalString("style") ?? "Foreground to Transparent") ?? .foregroundToTransparent
            gradient.reversed = reversed
            gradient.opacity = CGFloat(opacity)
            session.gradientSettings = gradient
            defer { session.gradientSettings = previousGradient }
            let stroke = try makeStroke(for: layer, settings: BrushSettings(), session: session)
            do {
                try stroke.fillGradient(gradient.shape, from: start, to: end,
                                        colors: session.gradientColors(mask: stroke.isMask),
                                        opacity: gradient.opacity)
            } catch {
                throw CompositorMCPCommandError(code: "gradient_failed", message: error.localizedDescription)
            }
            guard !stroke.patches.isEmpty else {
                return strokeOutcome(stroke: stroke, layer: layer, mask: stroke.isMask, points: 0, applied: false)
            }
            do {
                try await session.commitRasterEdit(stroke, name: stroke.isMask ? "Gradient Mask" : "Gradient")
            } catch {
                throw CompositorMCPCommandError(code: "gradient_failed", message: error.localizedDescription)
            }
            return strokeOutcome(stroke: stroke, layer: layer, mask: stroke.isMask, points: 0, applied: true)

        case "paint.shape":
            guard session.document != nil else {
                throw CompositorMCPCommandError(code: "document_required", message: "No document is open.")
            }
            guard session.canEditLayers else {
                throw CompositorMCPCommandError(code: "shape_unavailable", message: "The shape cannot be drawn while another edit is active.")
            }
            let kind = shapeKind(try arguments.optionalString("kind") ?? "Rectangle") ?? .rectangle
            // Shape drafts snap to whole document pixels.
            let rect = CGRect(x: try arguments.requiredDouble("x").rounded(),
                              y: try arguments.requiredDouble("y").rounded(),
                              width: try arguments.requiredDouble("width").rounded(),
                              height: try arguments.requiredDouble("height").rounded())
            let cornerRadius = kind == .rectangle ? CGFloat(try arguments.optionalDouble("cornerRadius") ?? 0) : 0
            let color = try strokeColor(arguments, mask: false, session: session)
            let name = try arguments.optionalString("name") ?? session.nextShapeName(kind)
            let previousActive = session.activeLayerID
            do {
                let image = try EditorSession.shapeImage(kind, size: rect.size, color: color, cornerRadius: cornerRadius)
                let style = LayerShapeStyle(kind: kind, red: color.red, green: color.green,
                                            blue: color.blue, cornerRadius: cornerRadius)
                // `finishShape`'s exact commit: a new pixel layer above the active one, in one
                // undo entry named after the kind, keeping the selection, and carrying
                // `LayerShape` so a later transform redraws the vector instead of stretching.
                session.addPixelLayer(image, at: rect.origin, name: name, editName: kind.rawValue,
                                      dropsSelection: false, shape: LayerShape(style: style, image: image))
            } catch {
                throw CompositorMCPCommandError(code: "shape_failed", message: error.localizedDescription)
            }
            guard session.activeLayerID != previousActive, let layer = session.activeLayer else {
                throw CompositorMCPCommandError(code: "shape_failed", message: "The shape layer could not be created.")
            }
            return Outcome(value: layerValue(layer), mutated: true)

        default:
            throw CompositorMCPCommandError(code: "operation_not_implemented", message: "\(name) is not implemented.")
        }
    }

    // MARK: - Shared stroke machinery

    /// The layer a paint stroke lands on, gated exactly like `EditorSession.canPaint`: a
    /// document must be open, exactly one layer selected, and that layer's pixels (or mask)
    /// must be editable — groups only take their mask, hidden layers refuse paint, and an
    /// explicitly empty selection leaves nothing paintable. `pixelsOnly` mirrors the tools
    /// that refuse mask targets (Spot Healing, Clone Stamp, Smudge, Liquify).
    @discardableResult
    func requirePaintTarget(_ session: EditorSession, pixelsOnly: Bool, tool: String) throws -> ImageLayer {
        guard session.document != nil else {
            throw CompositorMCPCommandError(code: "document_required", message: "No document is open.")
        }
        guard session.selectedLayerIDs.count == 1, let layer = session.activeLayer else {
            throw CompositorMCPCommandError(code: "layer_required", message: "Select exactly one layer to paint on.")
        }
        guard session.canPaint else {
            throw CompositorMCPCommandError(code: "pixel_edit_unavailable", message: "The active layer or mask cannot be painted.")
        }
        if pixelsOnly, session.isMaskSelected {
            throw CompositorMCPCommandError(code: "pixel_edit_unavailable", message: "\(tool) works on a layer's pixels, not its mask.")
        }
        return layer
    }

    /// A document-space stroke path, bounded like the catalogue schema (1–100,000 points).
    /// `BrushStroke.append` itself drops duplicate and non-finite samples.
    func requireStrokePoints(_ arguments: [String: CompositorMCPJSON], key: String = "points") throws -> [CGPoint] {
        guard let raw = arguments[key]?.array, (1...100_000).contains(raw.count) else {
            throw CompositorMCPCommandError.invalid("\(key) must be an array of 1 to 100,000 {x, y} points.")
        }
        return try raw.map { value -> CGPoint in
            guard let point = value.object,
                  let x = point["x"]?.number, x.isFinite,
                  let y = point["y"]?.number, y.isFinite else {
                throw CompositorMCPCommandError.invalid("\(key) must contain {x, y} points.")
            }
            return CGPoint(x: x, y: y)
        }
    }

    /// A single document-space point argument: the gradient endpoints and the clone source.
    func requireDocumentPoint(_ arguments: [String: CompositorMCPJSON], key: String) throws -> CGPoint {
        guard let point = arguments[key]?.object,
              let x = point["x"]?.number, x.isFinite,
              let y = point["y"]?.number, y.isFinite else {
            throw CompositorMCPCommandError.invalid("\(key) must be an {x, y} point.")
        }
        return CGPoint(x: x, y: y)
    }

    /// Diameter 1–2,000, hardness 0–1 and opacity/strength 0.01–1 — the bounds
    /// `BrushStroke`'s initializer enforces.
    func validateBrushArguments(_ arguments: [String: CompositorMCPJSON], opacityKey: String = "opacity") throws {
        if let diameter = try arguments.optionalDouble("diameter"), !(1...2000).contains(diameter) {
            throw CompositorMCPCommandError.invalid("diameter must be between 1 and 2,000 pixels.")
        }
        if let hardness = try arguments.optionalDouble("hardness"), !(0...1).contains(hardness) {
            throw CompositorMCPCommandError.invalid("hardness must be between 0 and 1.")
        }
        if let opacity = try arguments.optionalDouble(opacityKey), !(0.01...1).contains(opacity) {
            throw CompositorMCPCommandError.invalid("\(opacityKey) must be between 0.01 and 1.")
        }
    }

    /// Optional explicit gradient stops: 2 to 32 `{offset, color}` entries, offset 0–1,
    /// matching the catalogue schema.
    func requireGradientStops(_ arguments: [String: CompositorMCPJSON]) throws -> [PaintGradientStop]? {
        guard let raw = arguments["stops"] else { return nil }
        if case .null = raw { return nil }
        guard let values = raw.array, (2...32).contains(values.count) else {
            throw CompositorMCPCommandError.invalid("stops must be an array of 2 to 32 colour stops.")
        }
        return try values.map { value in
            guard let stop = value.object,
                  let offset = stop["offset"]?.number, offset.isFinite, (0...1).contains(offset),
                  let color = stop["color"]?.string else {
                throw CompositorMCPCommandError.invalid("stops must contain {offset, color} entries with offset between 0 and 1.")
            }
            return PaintGradientStop(offset: CGFloat(offset), color: try paintColorValue(color, argument: "stops.color"))
        }
    }

    /// Explicit per-call brush settings. Unlike the interactive tool — which reads the
    /// options bar — every MCP stroke carries its own parameters; the defaults equal
    /// `BrushSettings`' own (40 px, fully hard, fully opaque).
    func strokeSettings(_ arguments: [String: CompositorMCPJSON], color: PaletteColor, opacity: Double) -> BrushSettings {
        var settings = BrushSettings()
        settings.diameter = CGFloat(arguments["diameter"]?.number ?? 40)
        settings.hardness = CGFloat(arguments["hardness"]?.number ?? 1)
        settings.opacity = CGFloat(opacity)
        settings.red = color.red
        settings.green = color.green
        settings.blue = color.blue
        return settings
    }

    /// The paint colour: `color` when supplied, else the palette's current tone — the mask
    /// paint tone (white/black) on a mask target, the foreground colour elsewhere. On a mask
    /// only the red channel is used, exactly as upstream treats mask paint.
    func strokeColor(_ arguments: [String: CompositorMCPJSON], mask: Bool, session: EditorSession) throws -> PaletteColor {
        if let hex = try arguments.optionalString("color") {
            let color = try paintColorValue(hex, argument: "color")
            return mask ? PaletteColor(red: color.red, green: color.red, blue: color.red) : color
        }
        if mask { return session.maskPaintWhite ? .white : .black }
        return session.foregroundColor
    }

    /// `#RRGGBB` colour arguments; distinct from the router's `parseHex` so errors name the
    /// right parameter.
    func paintColorValue(_ value: String, argument: String) throws -> PaletteColor {
        let trimmed = value.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        guard trimmed.count == 6, let integer = Int(trimmed, radix: 16) else {
            throw CompositorMCPCommandError.invalid("\(argument) must be a six-digit hex colour.")
        }
        return PaletteColor(
            red: CGFloat((integer >> 16) & 0xff) / 255,
            green: CGFloat((integer >> 8) & 0xff) / 255,
            blue: CGFloat(integer & 0xff) / 255
        )
    }

    /// Enum arguments match on the upstream raw values ("Content-Aware", "Smudge", …),
    /// case-insensitively like the router's blend-mode lookup.
    func spotHealingMode(_ value: String) -> SpotHealingMode? {
        SpotHealingMode.allCases.first { $0.rawValue.caseInsensitiveCompare(value) == .orderedSame }
    }
    func blurToolMode(_ value: String) -> BlurToolMode? {
        BlurToolMode.allCases.first { $0.rawValue.caseInsensitiveCompare(value) == .orderedSame }
    }
    func gradientShape(_ value: String) -> GradientShape? {
        GradientShape.allCases.first { $0.rawValue.caseInsensitiveCompare(value) == .orderedSame }
    }
    func gradientStyle(_ value: String) -> GradientStyle? {
        GradientStyle.allCases.first { $0.rawValue.caseInsensitiveCompare(value) == .orderedSame }
    }
    func shapeKind(_ value: String) -> ShapeKind? {
        ShapeKind.allCases.first { $0.rawValue.caseInsensitiveCompare(value) == .orderedSame }
    }

    /// `makeRasterEdit` rethrows with the bridge's error shape.
    func makeStroke(for layer: ImageLayer, settings: BrushSettings, session: EditorSession) throws -> BrushStroke {
        do {
            return try session.makeRasterEdit(for: layer, settings: settings)
        } catch {
            throw CompositorMCPCommandError(code: "paint_failed", message: error.localizedDescription)
        }
    }

    /// `append` rethrows with the bridge's error shape (pixel budget and render failures).
    func append(_ point: CGPoint, to stroke: BrushStroke) throws {
        do {
            try stroke.append(point)
        } catch {
            throw CompositorMCPCommandError(code: "paint_failed", message: error.localizedDescription)
        }
    }

    /// The `finishBrushImmediately` tail as one call: settle the provisional curve tail, run
    /// the healing pass when the stroke asked for it, then commit through the async raster
    /// path — the same one the gradient and fill shortcuts use — as a single named undo
    /// entry. A stroke whose dabs never touched the canvas commits nothing and reports a
    /// no-op, like a mouse-up after a drag that never entered the canvas.
    func commitStroke(_ stroke: BrushStroke, name: String, points: Int, session: EditorSession) async throws -> Outcome {
        do {
            try stroke.flush()
            if stroke.settings.healing { try stroke.heal() }
        } catch {
            throw CompositorMCPCommandError(code: "paint_failed", message: error.localizedDescription)
        }
        guard !stroke.patches.isEmpty else {
            return strokeOutcome(stroke: stroke, layer: stroke.layer, mask: stroke.isMask, points: points, applied: false)
        }
        do {
            try await session.commitRasterEdit(stroke, name: name)
        } catch {
            throw CompositorMCPCommandError(code: "paint_failed", message: error.localizedDescription)
        }
        return strokeOutcome(stroke: stroke, layer: stroke.layer, mask: stroke.isMask, points: points, applied: true)
    }

    /// Uniform paint outcome: the target layer, whether its mask was painted, the input
    /// point count, whether anything landed, and the document-space bounds the stroke dirtied.
    func strokeOutcome(stroke: BrushStroke?, layer: ImageLayer, mask: Bool, points: Int, applied: Bool) -> Outcome {
        Outcome(value: .object([
            "applied": .bool(applied),
            "layerId": .string(layer.id.uuidString),
            "mask": .bool(mask),
            "points": .int(points),
            "bounds": boundsValue(applied ? stroke?.dirtyDocumentRect : nil)
        ]), mutated: applied)
    }

    func boundsValue(_ rect: CGRect?) -> CompositorMCPJSON {
        guard let rect, !rect.isNull, !rect.isEmpty else { return .null }
        return .object([
            "x": .cgFloat(rect.minX), "y": .cgFloat(rect.minY),
            "width": .cgFloat(rect.width), "height": .cgFloat(rect.height)
        ])
    }

    // MARK: - Explicit gradient stops

    /// A parsed `{offset, color}` gradient stop.
    struct PaintGradientStop {
        let offset: CGFloat
        let color: PaletteColor
    }

    /// Explicit colour stops go beyond the options bar's two-colour gradients:
    /// `BrushStroke.fillGradient` hard-wires its locations to 0/1, so multi-stop ramps and
    /// interior offsets are rendered to a document-size image first, then composited through
    /// BrushStroke's clone channel — the same mechanism Clone Stamp uses — painted under a
    /// canvas-wide coverage pass. Selection clipping, the layer transform, the pixel budget
    /// and the undo entry all still come from the raster pipeline.
    func applyStopsGradient(stops: [PaintGradientStop], shape: GradientShape,
                            start: CGPoint, end: CGPoint, reversed: Bool, opacity: Double,
                            layer: ImageLayer, document: CanvasDocument,
                            session: EditorSession) async throws -> Outcome {
        let image = try gradientImage(stops: stops, shape: shape, start: start, end: end,
                                      canvas: document.size, reversed: reversed)
        var settings = BrushSettings()
        settings.diameter = 2000   // the widest brush: the fewest coverage rows
        settings.hardness = 1      // a hard tip saturates coverage to full strength
        settings.opacity = CGFloat(max(0.01, opacity))
        let stroke = try makeStroke(for: layer, settings: settings, session: session)
        stroke.clone = (image, .zero)
        // `isBlur` is what lets the clone path draw into mask tiles at all; the Blur tool
        // sets it for exactly this purpose, and on a pixels target it changes nothing.
        if stroke.isMask { stroke.isBlur = true }
        // Only the paintable region needs coverage — the canvas intersected with the
        // selection, the same region `fillGradient` paints.
        var region = CGRect(origin: .zero, size: document.size)
        if let clip = stroke.selectionClip { region = region.intersection(clip.rect) }
        guard !region.isNull, !region.isEmpty else {
            return strokeOutcome(stroke: nil, layer: layer, mask: session.isMaskSelected, points: 0, applied: false)
        }
        let path = coveragePath(region, diameter: settings.diameter)
        for point in path { try append(point, to: stroke) }
        return try await commitStroke(stroke, name: stroke.isMask ? "Gradient Mask" : "Gradient",
                                      points: path.count, session: session)
    }

    /// A document-space ramp image for explicit colour stops, honouring every offset.
    /// `reversed` mirrors the ramp, as the options bar's Reverse does. Rendered in sRGB; on
    /// a mask target the clone channel draws it into the gray tile contexts, converting as
    /// it does for any image.
    func gradientImage(stops: [PaintGradientStop], shape: GradientShape,
                       start: CGPoint, end: CGPoint, canvas: CGSize, reversed: Bool) throws -> CGImage {
        let sorted = stops.sorted { $0.offset < $1.offset }
        let ordered = reversed
            ? sorted.map { PaintGradientStop(offset: 1 - $0.offset, color: $0.color) }.sorted { $0.offset < $1.offset }
            : sorted
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let gradient = CGGradient(
                colorsSpace: space,
                colors: ordered.map {
                    CGColor(colorSpace: space, components: [$0.color.red, $0.color.green, $0.color.blue, 1])!
                } as CFArray,
                locations: ordered.map(\.offset)) else {
            throw CompositorMCPCommandError(code: "gradient_failed", message: "The colour stops could not be rendered.")
        }
        let context: CGContext
        do {
            context = try BrushRaster.context(width: Int(canvas.width), height: Int(canvas.height), mask: false)
        } catch {
            throw CompositorMCPCommandError(code: "gradient_failed", message: error.localizedDescription)
        }
        switch shape {
        case .linear:
            context.drawLinearGradient(gradient, start: start, end: end,
                                       options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
        case .radial:
            context.drawRadialGradient(gradient, startCenter: start, startRadius: 0, endCenter: start,
                                       endRadius: hypot(end.x - start.x, end.y - start.y),
                                       options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
        }
        guard let image = context.makeImage() else {
            throw CompositorMCPCommandError(code: "gradient_failed", message: "The colour stops could not be rendered.")
        }
        return image
    }

    /// A serpentine point path whose brush band covers `rect` completely. `BrushStroke` lays
    /// dabs along the walked path at ~1.5% of the diameter, so rows spaced a little under
    /// one diameter apart saturate the coverage everywhere — how an explicit-stops gradient
    /// paints its whole region through the clone channel.
    func coveragePath(_ rect: CGRect, diameter: CGFloat) -> [CGPoint] {
        let radius = diameter / 2
        let step = diameter * 0.9
        var points: [CGPoint] = []
        var y = rect.minY - radius
        var leftToRight = true
        while y <= rect.maxY + radius {
            points.append(CGPoint(x: leftToRight ? rect.minX - radius : rect.maxX + radius, y: y))
            points.append(CGPoint(x: leftToRight ? rect.maxX + radius : rect.minX - radius, y: y))
            leftToRight.toggle()
            y += step
        }
        return points
    }
}
