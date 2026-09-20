import AppKit
import CoreGraphics
import Foundation

/// adjustment.*, filter.apply and pixels.contentAwareFill: adjustment layers and the
/// Filter menu's preview–commit pipeline.
///
/// Per the parity plan these reuse the app's own editing pipeline rather than touching
/// pixels directly: `session.addAdjustment`/`updateAdjustment` for adjustment layers, and
/// `beginFilter` → `updateFilter` → `commitFilter` for filters — the same calls FilterSheet
/// and the menus drive, so undo naming, grown blur margins, selection clipping and Remove
/// Background's mask commit all behave exactly as in the UI. Content-Aware Fill and Remove
/// Background are automatic filters: they render once at full size and can take noticeable
/// time on large layers — they stay transactional, and the bridge timeout
/// (`COMPOSITOR_MCP_TIMEOUT_MS`) is the documented lever for slow runs.
@MainActor
extension CompositorMCPCommandRouter {

    // MARK: - Validation dispatch

    /// Validates one adjustment/filter operation's arguments and target. Argument shape and
    /// range errors are raised before state guards, matching the router's convention.
    func validateFilterAndAdjustment(_ name: String, arguments: [String: CompositorMCPJSON], session: EditorSession) throws {
        switch name {
        case "adjustment.add":
            let kind = try requireAdjustmentKind(arguments)
            _ = try arguments.optionalString("name")
            if let parameters = try optionalJSONObject(arguments, key: "parameters") {
                _ = try buildAdjustment(kind: kind, base: nil, parameters: parameters)
            }
            guard session.document != nil else {
                throw CompositorMCPCommandError(code: "document_required", message: "No document is open.")
            }
            guard session.canEditLayers else {
                throw CompositorMCPCommandError(code: "adjustment_unavailable", message: "An adjustment layer cannot be added while another edit is active.")
            }
        case "adjustment.update":
            let id = try resolveLayer(arguments.requiredString("layerId"), session: session)
            let layer = try requireLayer(id, session: session)
            let kind = try requireAdjustmentKind(arguments)
            guard let current = layer.adjustment else {
                throw CompositorMCPCommandError.invalid("The layer is not an adjustment layer.")
            }
            guard current.kind == kind else {
                throw CompositorMCPCommandError.invalid("kind must match the layer's adjustment kind (\(current.kind.rawValue)).")
            }
            guard let parameters = try optionalJSONObject(arguments, key: "parameters") else {
                throw CompositorMCPCommandError.invalid("parameters is required and must be an object.")
            }
            _ = try buildAdjustment(kind: kind, base: current, parameters: parameters)
            guard session.canEditLayers else {
                throw CompositorMCPCommandError(code: "adjustment_unavailable", message: "The adjustment cannot be edited while another edit is active.")
            }
        case "filter.apply":
            let kind = try requireFilterKind(arguments)
            if let settings = try optionalJSONObject(arguments, key: "settings") {
                _ = try buildFilterSettings(kind: kind, base: session.filterSettings, fields: settings)
            }
            _ = try requireFilterTarget(kind, session: session)
        case "pixels.contentAwareFill":
            _ = try requireFilterTarget(.contentAwareFill, session: session)
        default:
            throw CompositorMCPCommandError(code: "operation_not_implemented", message: "\(name) is not implemented.")
        }
    }

    // MARK: - Apply dispatch

    /// Executes one adjustment/filter operation. `validateFilterAndAdjustment` has already
    /// run via `apply`, so the argument reads below cannot fail; state guards are repeated
    /// because a batch's earlier operations may have changed the target since validation.
    func applyFilterAndAdjustment(_ name: String, arguments: [String: CompositorMCPJSON], session: EditorSession) async throws -> Outcome {
        switch name {
        case "adjustment.add":
            let kind = try requireAdjustmentKind(arguments)
            guard session.document != nil, session.canEditLayers else {
                throw CompositorMCPCommandError(code: "adjustment_unavailable", message: "An adjustment layer cannot be added while another edit is active.")
            }
            let name = try arguments.optionalString("name")
            let previousActive = session.activeLayerID
            session.addAdjustment(kind)
            // `addAdjustment` primes the floating adjustment editor for the UI gesture that
            // made it; a scripted add must not open the panel, so the prime is cleared
            // before the Layers panel's task can observe it.
            session.adjustmentEditingID = nil
            guard let id = session.activeLayerID, id != previousActive,
                  session.activeLayer?.adjustment?.kind == kind else {
                throw CompositorMCPCommandError(code: "adjustment_failed", message: "The adjustment layer could not be created.")
            }
            // Optional parameters and name land as the same "Edit … Adjustment" step the
            // panel's OK records after adding through the UI — the parameters are built
            // from the layer's real adjustment so kind defaults (Gradient Map's palette
            // colours, Grain's per-layer seed) survive a partial update.
            if let parameters = try optionalJSONObject(arguments, key: "parameters"),
               let base = session.activeLayer?.adjustment {
                let tuned = try buildAdjustment(kind: kind, base: base, parameters: parameters)
                session.beginEdit("Edit \(kind.rawValue) Adjustment")
                session.updateAdjustment(id, value: tuned)
                if let name, !name.isEmpty, let index = session.document?.layers.firstIndex(where: { $0.id == id }) {
                    session.document?.layers[index].name = name
                }
                session.endEdit()
            } else if let name, !name.isEmpty, let index = session.document?.layers.firstIndex(where: { $0.id == id }) {
                session.beginEdit("Rename Layer")
                session.document?.layers[index].name = name
                session.endEdit()
            }
            return Outcome(value: layerValue(session.activeLayer), mutated: true)

        case "adjustment.update":
            let id = try resolveLayer(arguments.requiredString("layerId"), session: session)
            let layer = try requireLayer(id, session: session)
            let kind = try requireAdjustmentKind(arguments)
            guard let current = layer.adjustment else {
                throw CompositorMCPCommandError.invalid("The layer is not an adjustment layer.")
            }
            guard current.kind == kind else {
                throw CompositorMCPCommandError.invalid("kind must match the layer's adjustment kind (\(current.kind.rawValue)).")
            }
            guard session.canEditLayers else {
                throw CompositorMCPCommandError(code: "adjustment_unavailable", message: "The adjustment cannot be edited while another edit is active.")
            }
            let parameters = try optionalJSONObject(arguments, key: "parameters") ?? [:]
            let value = try buildAdjustment(kind: kind, base: current, parameters: parameters)
            // The same undo entry `finishAdjustmentEditing` records when the panel's OK
            // writes new settings: updateAdjustment itself only swaps the metadata.
            session.beginEdit("Edit \(kind.rawValue) Adjustment")
            session.updateAdjustment(id, value: value)
            session.endEdit()
            return Outcome(value: layerValue(session.document?.layers.first { $0.id == id }), mutated: true)

        case "filter.apply":
            let kind = try requireFilterKind(arguments)
            _ = try requireFilterTarget(kind, session: session)
            var settings = session.filterSettings
            if let fields = try optionalJSONObject(arguments, key: "settings") {
                settings = try buildFilterSettings(kind: kind, base: settings, fields: fields)
            }
            return try await runFilter(kind, settings: settings.normalized, session: session)

        case "pixels.contentAwareFill":
            _ = try requireFilterTarget(.contentAwareFill, session: session)
            return try await runFilter(.contentAwareFill, settings: session.filterSettings, session: session)

        default:
            throw CompositorMCPCommandError(code: "operation_not_implemented", message: "\(name) is not implemented.")
        }
    }

    // MARK: - Shared filter machinery

    /// The layer a filter lands on, gated like `EditorSession.canAdjustColors` plus the
    /// guards that let the bridge name the failure: one selected pixel layer (groups and
    /// mask targets are refused), and a live selection for Content-Aware Fill, the only
    /// filter that cannot run without one.
    @discardableResult
    func requireFilterTarget(_ kind: FilterKind, session: EditorSession) throws -> ImageLayer {
        guard session.document != nil else {
            throw CompositorMCPCommandError(code: "document_required", message: "No document is open.")
        }
        guard session.selectedLayerIDs.count == 1, let layer = session.activeLayer else {
            throw CompositorMCPCommandError(code: "layer_required", message: "Select exactly one layer to filter.")
        }
        guard !layer.isGroup else {
            throw CompositorMCPCommandError.invalid("Filters apply to a pixel layer, not a group.")
        }
        guard !session.isMaskSelected else {
            throw CompositorMCPCommandError(code: "pixel_edit_unavailable", message: "\(kind.rawValue) works on a layer's pixels, not its mask.")
        }
        if kind == .contentAwareFill, session.selection?.isEmpty != false {
            throw CompositorMCPCommandError(code: "selection_required", message: "Content-Aware Fill needs a non-empty selection.")
        }
        guard session.canAdjustColors else {
            throw CompositorMCPCommandError(code: "filter_unavailable", message: "The active layer cannot be filtered while another edit is active.")
        }
        return layer
    }

    /// The Filter menu's whole flow in one call. The caller's settings seed the edit
    /// through `filterSettings` — the panel's own starting point — because the automatic
    /// filters cannot take a later `updateFilter(preview: false)`: `commitFilter` refuses
    /// them until their full-size preview lands, so that preview must already carry the
    /// real settings. Other filters get `updateFilter(settings, preview: false)`, which
    /// pins the caller's values (beginFilter seeds Gradient Map's ends from the palette)
    /// and skips the live preview since only the committed render matters here.
    /// `commitFilter` then persists the settings to `filterSettings`, as the panel's OK does.
    func runFilter(_ kind: FilterKind, settings: FilterSettings, session: EditorSession) async throws -> Outcome {
        // An adjustment edit left open in the panel would swallow the commit below —
        // finishAdjustmentEditing clears filterEdit too — so dismiss it the way clicking
        // away does before the filter edit exists.
        if session.adjustmentEditingID != nil || session.adjustmentOriginal != nil {
            session.finishAdjustmentEditing(commit: false)
        }
        // beginFilter defers itself behind a pending gradient; settling the gradient first
        // keeps the filter edit synchronous so its absence below means a real refusal.
        if session.gradientEdit != nil { await session.commitGradient() }
        let previousSettings = session.filterSettings
        session.filterSettings = settings
        session.brushError = nil
        session.beginFilter(kind)
        session.filterSettings = previousSettings
        guard let edit = session.filterEdit else {
            // A refused begin (guards) leaves no error; a failed FilterEdit init leaves
            // brushError — the same message the app flashes.
            let message = session.brushError
            session.brushError = nil
            throw CompositorMCPCommandError(code: "filter_unavailable",
                message: message ?? "The filter could not be started on the active layer.")
        }
        if !kind.isAutomatic {
            session.updateFilter(settings, preview: false)
        }
        let undoBefore = session.history.undoCount
        await session.commitFilter()
        if let message = session.brushError {
            session.brushError = nil
            discardFilterEdit(session)
            throw CompositorMCPCommandError(code: "filter_failed", message: message)
        }
        if let stillOpen = session.filterEdit {
            // An automatic filter whose preview could not be produced refuses to commit and
            // stays open; the panel's error (no subject, too little source material) is the
            // failure, and the edit is closed the way Cancel would.
            let message = stillOpen.previewError
            discardFilterEdit(session)
            throw CompositorMCPCommandError(code: "filter_failed",
                message: message ?? "The filter could not be applied.")
        }
        // Identity settings (a zero Lens Correction, an unchanged Exposure, amount-0 Grain)
        // close like Cancel upstream: no undo step, and `applied` reports nothing landed.
        let applied = session.history.undoCount > undoBefore
        var value: [String: CompositorMCPJSON] = [
            "applied": .bool(applied),
            "kind": .string(kind.rawValue),
            "layerId": .string(edit.layerID.uuidString),
        ]
        if let layer = session.document?.layers.first(where: { $0.id == edit.layerID }) {
            value["mask"] = .bool(layer.mask != nil)
            value["layer"] = layerValue(layer)
        }
        return Outcome(value: .object(value), mutated: applied)
    }

    /// Closes a filter edit that survived a failed commit. `cancelFilter` first finishes any
    /// pending adjustment edit and returns, so a second call is what actually reaches the filter.
    private func discardFilterEdit(_ session: EditorSession) {
        for _ in 0..<2 where session.filterEdit != nil { session.cancelFilter() }
    }

    // MARK: - Kind and settings builders

    /// Enum arguments match on the upstream raw values ("Hue/Saturation", "Gaussian Blur", …),
    /// case-insensitively like the router's blend-mode lookup.
    func requireAdjustmentKind(_ arguments: [String: CompositorMCPJSON]) throws -> AdjustmentKind {
        let value = try arguments.requiredString("kind")
        guard let kind = AdjustmentKind.matching(value) else {
            throw CompositorMCPCommandError.invalid("Unknown adjustment kind: \(value)")
        }
        return kind
    }

    func requireFilterKind(_ arguments: [String: CompositorMCPJSON]) throws -> FilterKind {
        let value = try arguments.requiredString("kind")
        guard let kind = FilterKind.matching(value) else {
            throw CompositorMCPCommandError.invalid("Unknown filter kind: \(value)")
        }
        return kind
    }

    /// An optional object argument: `parameters` on adjustment.* and `settings` on filter.apply.
    func optionalJSONObject(_ arguments: [String: CompositorMCPJSON], key: String) throws -> [String: CompositorMCPJSON]? {
        guard let raw = arguments[key] else { return nil }
        if case .null = raw { return nil }
        guard let object = raw.object else {
            throw CompositorMCPCommandError.invalid("\(key) must be an object.")
        }
        return object
    }

    /// The catalogue's colour ranges, matched on their upstream raw values.
    func colorRange(_ value: String) -> ColorRange? {
        ColorRange.matching(value)
    }

    func levelsChannel(_ value: String) -> LevelsChannel? {
        LevelsChannel.matching(value)
    }

    /// A `LayerAdjustment` of `kind` with the caller's parameters merged onto `base` (the
    /// layer's current settings for an update, bare defaults for an add). Supplied fields
    /// replace; everything else is kept. The result is checked against `isValid` — the same
    /// gate `updateAdjustment` applies — so bad input fails here rather than silently.
    func buildAdjustment(kind: AdjustmentKind, base: LayerAdjustment?, parameters: [String: CompositorMCPJSON]) throws -> LayerAdjustment {
        var adjustment = base ?? LayerAdjustment(kind: kind)
        adjustment.kind = kind
        switch kind {
        case .hsv:
            adjustment.hsvSettings = try buildHueSaturation(base: adjustment.resolvedHSV, parameters: parameters)
        case .levels:
            adjustment.levels = try buildLevels(base: adjustment.levels, parameters: parameters)
        case .curves:
            adjustment.curves = try buildCurves(base: adjustment.curves, parameters: parameters)
        case .exposure:
            adjustment.exposure = try buildExposure(base: adjustment.exposure, parameters: parameters)
        case .gradientMap:
            adjustment.gradientMap = try buildGradientMap(base: adjustment.gradientMap, parameters: parameters)
        case .grain:
            adjustment.grain = try buildGrain(base: adjustment.grain, parameters: parameters)
        }
        guard adjustment.isValid else {
            throw CompositorMCPCommandError.invalid("parameters are outside \(kind.rawValue)'s limits.")
        }
        return adjustment
    }

    /// The Hue/Saturation parameter union → `HueSaturationSettings`. `range` is applied
    /// first so the flat hue/saturation/lightness sliders write to the range they name,
    /// exactly like the panel's own slider binding.
    func buildHueSaturation(base: HueSaturationSettings, parameters: [String: CompositorMCPJSON]) throws -> HueSaturationSettings {
        var settings = base
        if let value = try parameters.optionalString("range") {
            guard let range = colorRange(value) else {
                throw CompositorMCPCommandError.invalid("range must be one of Master, Reds, Yellows, Greens, Cyans, Blues, Magentas.")
            }
            settings.range = range
        }
        if let value = try parameters.optionalBool("colorize") { settings.colorize = value }
        if let value = try parameters.optionalBool("invertRange") { settings.invertRange = value }
        if let value = try parameters.optionalDouble("hue") { settings.hue = value }
        if let value = try parameters.optionalDouble("saturation") { settings.saturation = value }
        if let value = try parameters.optionalDouble("lightness") { settings.lightness = value }
        if let adjustments = try optionalJSONObject(parameters, key: "adjustments") {
            for (name, raw) in adjustments {
                guard let range = colorRange(name) else {
                    throw CompositorMCPCommandError.invalid("Unknown colour range: \(name)")
                }
                guard let fields = raw.object else {
                    throw CompositorMCPCommandError.invalid("adjustments.\(name) must be an object.")
                }
                var adjustment = settings.adjustments[range] ?? RangeAdjustment()
                if let value = try fields.optionalDouble("hue") { adjustment.hue = value }
                if let value = try fields.optionalDouble("saturation") { adjustment.saturation = value }
                if let value = try fields.optionalDouble("lightness") { adjustment.lightness = value }
                settings.adjustments[range] = adjustment
            }
        }
        if let bands = try optionalJSONObject(parameters, key: "bands") {
            for (name, raw) in bands {
                guard let range = colorRange(name) else {
                    throw CompositorMCPCommandError.invalid("Unknown colour range: \(name)")
                }
                guard let fields = raw.object else {
                    throw CompositorMCPCommandError.invalid("bands.\(name) must be an object.")
                }
                settings.bands[range] = HueBand(
                    falloffStart: try fields.requiredDouble("falloffStart"),
                    rangeStart: try fields.requiredDouble("rangeStart"),
                    rangeEnd: try fields.requiredDouble("rangeEnd"),
                    falloffEnd: try fields.requiredDouble("falloffEnd"))
            }
        }
        return settings
    }

    /// The Levels parameter union → `LevelsSettings`. `ranges` is ordered RGB, Red, Green,
    /// Blue as the schema advertises; each supplied entry merges field-wise onto the stored
    /// range and is normalised, since `isValid` requires stored ranges in normalised form.
    func buildLevels(base: LevelsSettings, parameters: [String: CompositorMCPJSON]) throws -> LevelsSettings {
        var settings = base
        if let value = try parameters.optionalString("channel") {
            guard let channel = levelsChannel(value) else {
                throw CompositorMCPCommandError.invalid("channel must be RGB, Red, Green or Blue.")
            }
            settings.channel = channel
        }
        if let raw = parameters["ranges"] {
            if case .null = raw { return settings }
            guard let values = raw.array, values.count == 4 else {
                throw CompositorMCPCommandError.invalid("ranges must be an array of four channel ranges (RGB, Red, Green, Blue).")
            }
            for (index, raw) in values.enumerated() {
                guard let fields = raw.object else {
                    throw CompositorMCPCommandError.invalid("ranges must contain objects.")
                }
                var range = settings.ranges[index]
                if let value = try fields.optionalDouble("black") { range.black = value }
                if let value = try fields.optionalDouble("gamma") { range.gamma = value }
                if let value = try fields.optionalDouble("white") { range.white = value }
                if let value = try fields.optionalDouble("outputBlack") { range.outputBlack = value }
                if let value = try fields.optionalDouble("outputWhite") { range.outputWhite = value }
                settings.ranges[index] = range.normalized
            }
        }
        return settings
    }

    /// The Curves parameter union → `CurvesSettings`. The catalogue bounds the list shape;
    /// `CurvesSettings.isValid`'s endpoint and ordering rules are checked here so the same
    /// errors surface as invalid_arguments rather than a silently refused update.
    func buildCurves(base: CurvesSettings, parameters: [String: CompositorMCPJSON]) throws -> CurvesSettings {
        var settings = base
        if let value = try parameters.optionalString("channel") {
            guard let channel = levelsChannel(value) else {
                throw CompositorMCPCommandError.invalid("channel must be RGB, Red, Green or Blue.")
            }
            settings.channel = channel
        }
        if let raw = parameters["channels"] {
            if case .null = raw { return settings }
            guard let lists = raw.array, lists.count == 4 else {
                throw CompositorMCPCommandError.invalid("channels must be an array of four point lists (RGB, Red, Green, Blue).")
            }
            settings.channels = try lists.map { raw in
                guard let list = raw.array, (2...32).contains(list.count) else {
                    throw CompositorMCPCommandError.invalid("each channel must be a list of 2 to 32 points.")
                }
                let points = try list.map { raw -> CurvePoint in
                    let point = try parsePoint(raw, message: "channels must contain {x, y} points between 0 and 255.")
                    guard (0...255).contains(point.x), (0...255).contains(point.y) else {
                        throw CompositorMCPCommandError.invalid("channels must contain {x, y} points between 0 and 255.")
                    }
                    return CurvePoint(x: point.x, y: point.y)
                }
                guard points.first?.x == 0, points.last?.x == 255,
                      zip(points, points.dropFirst()).allSatisfy({ $0.x < $1.x }) else {
                    throw CompositorMCPCommandError.invalid("curve points must run from x 0 to x 255 with strictly increasing x.")
                }
                return points
            }
        }
        return settings
    }

    func buildExposure(base: ExposureSettings, parameters: [String: CompositorMCPJSON]) throws -> ExposureSettings {
        var settings = base
        if let value = try parameters.optionalDouble("exposure") { settings.exposure = value }
        if let value = try parameters.optionalDouble("offset") { settings.offset = value }
        if let value = try parameters.optionalDouble("gamma") { settings.gamma = value }
        return settings.normalized
    }

    func buildGradientMap(base: GradientMapSettings, parameters: [String: CompositorMCPJSON]) throws -> GradientMapSettings {
        var settings = base
        if let shadows = try optionalJSONObject(parameters, key: "shadows") {
            settings.shadows = try buildAdjustmentColor(shadows, argument: "shadows")
        }
        if let highlights = try optionalJSONObject(parameters, key: "highlights") {
            settings.highlights = try buildAdjustmentColor(highlights, argument: "highlights")
        }
        if let value = try parameters.optionalBool("reversed") { settings.reversed = value }
        return settings.normalized
    }

    func buildGrain(base: GrainSettings, parameters: [String: CompositorMCPJSON]) throws -> GrainSettings {
        var settings = base
        if let value = try parameters.optionalDouble("amount") { settings.amount = value }
        if let value = try parameters.optionalDouble("size") { settings.size = value }
        if let value = try parameters.optionalDouble("roughness") { settings.roughness = value }
        if let seed = try parameters.optionalInt("seed") {
            guard (0...Int(UInt32.max)).contains(seed) else {
                throw CompositorMCPCommandError.invalid("seed must be between 0 and 4,294,967,295.")
            }
            settings.seed = UInt32(seed)
        }
        return settings.normalized
    }

    /// An `{red, green, blue}` colour in 0–1 channels, the catalogue's `adjustmentColor` shape.
    func buildAdjustmentColor(_ fields: [String: CompositorMCPJSON], argument: String) throws -> AdjustmentColor {
        AdjustmentColor(red: try boundedChannel(fields, "red", argument: argument),
                        green: try boundedChannel(fields, "green", argument: argument),
                        blue: try boundedChannel(fields, "blue", argument: argument))
    }

    private func boundedChannel(_ fields: [String: CompositorMCPJSON], _ key: String, argument: String) throws -> Double {
        let value = try fields.requiredDouble(key)
        guard (0...1).contains(value) else {
            throw CompositorMCPCommandError.invalid("\(argument).\(key) must be between 0 and 1.")
        }
        return value
    }

    /// The catalogue's per-kind `settings` object → `FilterSettings`, merged onto `base`
    /// (the session's persisted settings, as the panel opens with). Unrelated kinds' fields
    /// keep their stored values, exactly as switching filters in the Filter menu does.
    func buildFilterSettings(kind: FilterKind, base: FilterSettings, fields: [String: CompositorMCPJSON]) throws -> FilterSettings {
        var settings = base
        switch kind {
        case .gaussianBlur:
            if let value = try fields.optionalDouble("radius") { settings.radius = value }
        case .motionBlur:
            if let value = try fields.optionalDouble("angle") { settings.angle = value }
            if let value = try fields.optionalDouble("distance") { settings.distance = value }
        case .addNoise:
            if let value = try fields.optionalDouble("amount") { settings.amount = value }
            if let value = try fields.optionalBool("gaussian") { settings.gaussian = value }
            if let value = try fields.optionalBool("monochromatic") { settings.monochromatic = value }
            // Upstream has no seed setting: each FilterEdit owns the random seed it keeps
            // fixed while its panel is open, so the schema's seed is accepted but cannot be
            // honoured through the native pipeline.
            _ = try fields.optionalInt("seed")
        case .lensCorrection:
            if let value = try fields.optionalDouble("distortion") { settings.distortion = value }
        case .removeBackground:
            if let value = try fields.optionalString("backgroundQuality") {
                guard let quality = BackgroundQuality.matching(value) else {
                    throw CompositorMCPCommandError.invalid("backgroundQuality must be Basic or Advanced.")
                }
                settings.backgroundQuality = quality
            }
            if let value = try fields.optionalDouble("refineEdges") { settings.refineEdges = value }
            if let value = try fields.optionalDouble("matteContrast") { settings.matteContrast = value }
            if let value = try fields.optionalDouble("shiftEdge") { settings.shiftEdge = value }
        case .contentAwareFill:
            break
        case .curves:
            settings.curves = try buildCurves(base: settings.curves, parameters: fields)
        case .exposure:
            settings.exposure = try buildExposure(base: settings.exposure, parameters: fields)
        case .gradientMap:
            settings.gradientMap = try buildGradientMap(base: settings.gradientMap, parameters: fields)
        case .grain:
            // Grain is a real settings field, but the committed FilterJob's seed (the
            // edit's own, random per panel) wins over it at run time — same as the UI.
            settings.grain = try buildGrain(base: settings.grain, parameters: fields)
        }
        return settings.normalized
    }
}
