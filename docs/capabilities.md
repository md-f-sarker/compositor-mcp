# Capability reference

_Generated from `packages/protocol/src/capabilities.ts` by `scripts/generate-capability-docs.mjs`._
_Do not edit by hand — run `npm run docs:capabilities` and commit the result._

62 operations: 62 implemented, 0 planned.
`execute` rejects `planned` operations with `operation_not_implemented` until the bridge implements them.

**Risk** — `read`: no mutation; `write`: mutates the document; `destructive`: requires
`confirmDestructive: true`; `filesystem`: reads or writes inside authorised roots.
**Txn** — `yes`: participates in atomic `execute` batches; `no`: excluded from atomic rollback.
Parameters in `code` are required; a trailing `?` marks optional arguments.

## app

| Operation | Title | Status | Risk | Txn | Parameters | Aliases & tags |
| --- | --- | --- | --- | --- | --- | --- |
| `app.ping` | Ping Compositor | implemented | read | no | – | aliases: health, status, connect; tags: diagnostics, bridge |
| `app.getState` | Get editor state | implemented | read | no | `includeLayers`? | aliases: inspect, snapshot, current state; tags: state, projects, layers |

## workspace

| Operation | Title | Status | Risk | Txn | Parameters | Aliases & tags |
| --- | --- | --- | --- | --- | --- | --- |
| `workspace.list` | List projects | implemented | read | no | – | aliases: list tabs, open projects; tags: tabs, projects |
| `workspace.select` | Select project | implemented | write | no | `projectId` | – |

## document

| Operation | Title | Status | Risk | Txn | Parameters | Aliases & tags |
| --- | --- | --- | --- | --- | --- | --- |
| `document.create` | Create document | implemented | write | no | `width`, `height`, `resolution`? | – |
| `document.open` | Open Compositor project | implemented | filesystem | no | `path` | aliases: load project; tags: file, comp |
| `document.save` | Save project | implemented | filesystem | no | `path`? | aliases: save as, write project; tags: file, comp |
| `document.importImages` | Import images | implemented | filesystem | no | `paths`, `x`?, `y`? | aliases: add image, place images; tags: import, layers, file |
| `document.export` | Export flattened image | implemented | filesystem | no | `path`, `format`?, `quality`?, `background`? | aliases: render, save png, save jpeg; tags: export, file, png, jpeg |
| `document.resizeCanvas` | Resize canvas | implemented | write | yes | `width`, `height`, `anchor`? | aliases: canvas size, expand canvas, change canvas size; tags: canvas, resize, anchor |
| `document.resizeImage` | Resize image | implemented | write | yes | `width`, `height`, `resolution`? | aliases: resample image, scale image, change image size; tags: image size, resample |
| `document.crop` | Crop document | implemented | destructive | yes | `x`, `y`, `width`, `height` | aliases: crop, trim canvas; tags: crop, canvas, bounds |
| `document.flip` | Flip canvas | implemented | write | yes | `axis` | – |

## history

| Operation | Title | Status | Risk | Txn | Parameters | Aliases & tags |
| --- | --- | --- | --- | --- | --- | --- |
| `history.undo` | Undo | implemented | write | no | – | aliases: revert last edit |
| `history.redo` | Redo | implemented | write | no | – | – |

## layer

| Operation | Title | Status | Risk | Txn | Parameters | Aliases & tags |
| --- | --- | --- | --- | --- | --- | --- |
| `layer.list` | List layers | implemented | read | no | `projectId`? | aliases: inspect layers, layer tree |
| `layer.select` | Select layers | implemented | write | yes | `layerIds`, `target`? | – |
| `layer.addBlank` | Add blank layer | implemented | write | yes | `name`? | – |
| `layer.duplicate` | Duplicate layer | implemented | write | yes | `layerId`? | – |
| `layer.rename` | Rename layer | implemented | write | yes | `layerId`, `name` | – |
| `layer.delete` | Delete layer | implemented | destructive | yes | `layerId` | aliases: remove layer |
| `layer.setVisibility` | Set layer visibility | implemented | write | yes | `layerId`, `visible` | – |
| `layer.setOpacity` | Set layer opacity | implemented | write | yes | `layerId`, `opacity` | aliases: change transparency, make transparent, half transparent, set alpha; tags: opacity, transparent, transparency, alpha |
| `layer.setBlendMode` | Set blend mode | implemented | write | yes | `layerId`, `blendMode` | – |
| `layer.move` | Move layer in stack | implemented | write | yes | `layerId`, `offset` | – |
| `layer.group` | Group selected layers | implemented | write | yes | `name`? | – |
| `layer.ungroup` | Ungroup layer folder | implemented | write | yes | `layerId` | aliases: dissolve group, ungroup layers; tags: group, folder |
| `layer.merge` | Merge layers | implemented | destructive | yes | `layerId`? | – |
| `layer.flip` | Flip layer | implemented | write | yes | `axis` | – |
| `layer.transform` | Transform layer | implemented | write | yes | `layerId`, `x`?, `y`?, `width`?, `height`?, `rotation`?, `flipX`?, `flipY`?, `sampling`? | tags: move, scale, rotate |
| `layer.distort` | Free distort layer | implemented | write | yes | `layerId`, `corners` | aliases: free distort, perspective transform, warp corners; tags: transform, distort, perspective |

## mask

| Operation | Title | Status | Risk | Txn | Parameters | Aliases & tags |
| --- | --- | --- | --- | --- | --- | --- |
| `layer.addMask` | Add layer mask | implemented | write | yes | `layerId`, `mode`? | – |
| `layer.deleteMask` | Delete layer mask | implemented | destructive | yes | `layerId` | – |
| `layer.setMaskLinked` | Link or unlink mask | implemented | write | yes | `layerId`, `linked` | – |
| `layer.setClippingMask` | Set clipping mask | implemented | write | yes | `layerId`, `enabled` | – |
| `layer.featherMask` | Feather layer mask | implemented | write | yes | `layerId`, `radius` | aliases: soften mask, feather mask edge, blur mask; tags: feather, mask |

## selection

| Operation | Title | Status | Risk | Txn | Parameters | Aliases & tags |
| --- | --- | --- | --- | --- | --- | --- |
| `selection.get` | Get selection | implemented | read | no | – | – |
| `selection.all` | Select all | implemented | write | yes | – | – |
| `selection.none` | Deselect | implemented | write | yes | – | aliases: deselect |
| `selection.invert` | Invert selection | implemented | write | yes | – | – |
| `selection.fromLayer` | Select layer pixels | implemented | write | yes | `layerId` | – |
| `selection.fromMask` | Select mask areas | implemented | write | yes | `layerId` | – |
| `selection.rectangle` | Rectangular selection | implemented | write | yes | `x`, `y`, `width`, `height`, `mode`? | aliases: marquee, rectangular marquee, select rectangle; tags: marquee, rectangle |
| `selection.ellipse` | Elliptical selection | implemented | write | yes | `x`, `y`, `width`, `height`, `mode`? | aliases: elliptical marquee, select ellipse, circular selection; tags: marquee, ellipse |
| `selection.polygon` | Polygonal selection | implemented | write | yes | `points`, `mode`? | aliases: lasso, polygonal lasso, select polygon; tags: lasso, polygon |
| `selection.magicWand` | Magic Wand selection | implemented | write | yes | `x`, `y`, `tolerance`?, `contiguous`?, `sampleSize`?, `sampleAllLayers`?, `mode`? | aliases: wand, select similar, select by colour; tags: wand, tolerance |
| `selection.expand` | Expand selection | implemented | write | yes | `pixels` | – |
| `selection.contract` | Contract selection | implemented | write | yes | `pixels` | – |

## pixels

| Operation | Title | Status | Risk | Txn | Parameters | Aliases & tags |
| --- | --- | --- | --- | --- | --- | --- |
| `pixels.fill` | Fill pixels | implemented | write | yes | `target`? | – |
| `pixels.clear` | Clear pixels | implemented | destructive | yes | – | – |
| `pixels.invert` | Invert pixels or mask | implemented | write | yes | – | – |
| `pixels.contentAwareFill` | Content-aware fill | implemented | write | yes | – | aliases: content aware fill, fill selection, generative fill; tags: fill, retouch |

## paint

| Operation | Title | Status | Risk | Txn | Parameters | Aliases & tags |
| --- | --- | --- | --- | --- | --- | --- |
| `paint.brushStroke` | Paint brush stroke | implemented | write | yes | `mode`?, `points`, `diameter`?, `hardness`?, `opacity`?, `color`? | aliases: brush, paint, draw, erase; tags: brush, stroke, draw |
| `paint.spotHeal` | Spot-heal stroke | implemented | write | yes | `points`, `diameter`?, `hardness`?, `opacity`?, `mode`? | aliases: heal, spot healing, remove blemish; tags: retouch, heal |
| `paint.clone` | Clone-stamp stroke | implemented | write | yes | `source`, `points`, `aligned`?, `sampleAllLayers`?, `diameter`?, `hardness`?, `opacity`? | aliases: clone stamp, clone source, stamp; tags: retouch, clone |
| `paint.blur` | Blur or liquify stroke | implemented | write | yes | `mode`?, `points`, `diameter`?, `hardness`?, `strength`? | aliases: smudge, liquify, blur brush, smear; tags: warp, smudge, liquify |
| `paint.gradient` | Apply gradient | implemented | write | yes | `start`, `end`, `shape`?, `style`?, `stops`?, `reversed`?, `opacity`? | aliases: gradient fill, draw gradient; tags: gradient, fill |
| `paint.shape` | Draw shape | implemented | write | yes | `kind`?, `x`, `y`, `width`, `height`, `cornerRadius`?, `color`?, `name`? | aliases: draw shape, rectangle, ellipse, rounded rectangle; tags: shape, vector |

## adjustment

| Operation | Title | Status | Risk | Txn | Parameters | Aliases & tags |
| --- | --- | --- | --- | --- | --- | --- |
| `adjustment.add` | Add adjustment layer | implemented | write | yes | `kind`, `name`?, `parameters`? | aliases: new adjustment, adjustment layer; tags: non-destructive, colour, levels, curves |
| `adjustment.update` | Update adjustment layer | implemented | write | yes | `layerId`, `kind`, `parameters` | aliases: edit adjustment, change adjustment; tags: non-destructive, colour |

## filter

| Operation | Title | Status | Risk | Txn | Parameters | Aliases & tags |
| --- | --- | --- | --- | --- | --- | --- |
| `filter.apply` | Apply image filter | implemented | write | yes | `kind`, `settings`? | aliases: apply filter, gaussian blur, remove background; tags: filter, blur, noise, background |

## preview

| Operation | Title | Status | Risk | Txn | Parameters | Aliases & tags |
| --- | --- | --- | --- | --- | --- | --- |
| `preview.render` | Render preview | implemented | filesystem | no | – | aliases: screenshot, thumbnail; tags: render, inspect |

## Argument conventions

- `layerId` accepts a layer UUID or `active`; `projectId` accepts a UUID or `current`.
- Points, rects and sizes are document pixels; colours are `#RRGGBB` hex or 0–1 RGB channels.
- `adjustment.*` and `filter.apply` pair a `kind` constant with a typed `parameters`/`settings`
  object via `oneOf` — each kind accepts only its own fields.
