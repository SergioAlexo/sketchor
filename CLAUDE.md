# CLAUDE.md

Sketchor — parametric 2D CAD sketcher. Web-first (React + Vite + Canvas2D),
desktop via Tauri 2, designed for AI integration. `README.md` is thorough — read
it for features, file formats, controls, and the roadmap. This file captures what
isn't obvious from the README: how things are wired and how to build/run them.

## Repo layout (npm workspaces)

```
packages/core        framework-free document model, command bus, DXF/SVG/DWG IO, geometry analysis (pure TS)
apps/web             React UI + custom Canvas2D viewport
apps/web/src/model3d STEP/IGES viewer: OpenCascade wasm in a worker pool, three.js, IndexedDB cache
apps/web/src-tauri   Tauri 2 desktop shell (Rust); same UI as a native app
native/dxf-parse     dependency-free Rust DXF parser + fit-to-box projection (shared)
native/step-wire     dependency-free STEP wireframe extractor (B-rep edges + assembly transforms, no kernel)
native/dxf-thumbnailer   Windows Explorer thumbnail COM shell extension for DXF + STEP/IGES (Rust)
native/dxf-quicklook     macOS Finder Quick Look thumbnail extension (.appex; Rust FFI + Swift)
```

## The one architectural rule

The document is **only ever mutated through serializable `Command` values**
(`add-entity`, `move-entities`, `add-constraint`, `batch`, …). `CommandBus`
(`packages/core/src/commands.ts`) applies them, derives inverses for undo/redo,
and notifies subscribers. Tools, the future constraint solver, and the future AI
assistant are all just command producers — none get privileged access. Anything
that changes the drawing must go through a Command.

AI-facing surface: the two-way sketch text (`packages/core/src/sketchtext.ts`),
reachable at runtime as `window.sketchor.toCode()` / `applyCode(text)`.
`param`/`constraint`/`dim` keywords are reserved for the not-yet-built
parametric layer (`packages/core/src/constraints.ts` is a data-model scaffold; no
solver yet).

## Entity kinds (`packages/core/src/kinds/`)

Every entity `type` is one registered `EntityKind` (Z-01). Generic code — bounds,
selection, hit testing, snapping, grips, drawing, SVG/PDF/DXF-R12 export — asks
the registry, and a kind needs only `tessellate` to work everywhere
approximately; `bounds`/`transform`/`path`/`snaps`/`hitDistance`/`grips` make it
exact. The seven built-ins live in `kinds/builtin.ts`. **Adding a type: follow
`docs/new-entity-checklist.md`.**

## Dimensions and text styles (`packages/core/src/dimensions/`, plan §7)

`DimensionEntity` (9 kinds) stores `defPoints` (always valid) plus optional
associative `refs`/`target`/`targets`; `dimensions/layout.ts` is the one pure
layout (strokes, filled arrow polygons, centred text) that the canvas draws and
`explode.ts` turns into ordinary lines/polylines/TEXT for every writer without
a DIMENSION record (R12/2018 DXF, SVG, PDF, EPS). Registry methods only see the
entity, so references resolve against the *active document*
(`dimensions/context.ts`, set by `CommandBus` next to `setActiveBlocks`; bare
documents use `withDimHost`); placed block copies drop `refs` (ids are
definition-local) and block-definition dimensions export through
`styleOnlyHost`. Styles: `DimStyle` in the `dimStyles` table (ISO-25/ANSI/GOST
presets in `style.ts`); text styles (`textStyle.ts`, `textStyles` table) give
`TextEntity` `style/halign/valign/widthFactor/oblique`, and the DXF STYLE table
round-trips. New entity fields that sketch code cannot express must be carried
in `diffToCommands`. Dimension *creation* is pure too (`dimensions/build.ts`:
smart-DIM classification, baseline/continue, QDIM); `tools/dimTools.ts` only
collects picks (tool `dim` = smart DIM; DLI/DAL/DAN/DRA/DDI/DAR/DOR/DJO/DBA/DCO/QDIM
on the command line). D-10: DXF writes real DIMENSION + `*D` block + DIMSTYLE (`dxfDim.ts`, `dxfVars.ts`), exact data in the SKETCHOR record. D-03: `DimStyle` is the full DIMVAR set (`style.ts`; the manager form is data in `styleFields.ts`, edits go through `styleOps.ts` + `put-table-record`; `dimstyle`/`ddim` opens `dimstyles/DimStyleManager.tsx`); child styles via `dimStyleOf(rec, overrides, kind)`.

## MTEXT (`packages/core/src/mtext/`, plan D-04)

`MTextEntity.text` holds the MTEXT inline codes verbatim; `parse.ts` (`parseMtext`/`serializeMtext`, never throws) is the grammar, `layout.ts` (`layoutMText`) the one pure word-wrap layout (text measured by `setMTextMetrics`, default = stroke-font estimate) that the canvas draws and `explode.ts` turns into TEXT runs + rules + solid HATCH background. `explodeDimensions` also explodes MTEXT, which is how R12 DXF, SVG, PDF and EPS show it; AC1032 writes a real MTEXT (`dxfw/entities.ts`). The web editor (`apps/web/src/mtext/`) is a contentEditable bridged by `domCodec.ts` - the DOM is a view of the codes, never the source of truth.

## Hatching (`packages/core/src/hatch/`, plan §6)

`HatchEntity {loops, paint, style}`: loops are chains of exact edges
(line/arc/ellipse/spline, tessellated through the kind registry by
`loops.ts`); `paint` is `pattern | solid | gradient` — named `paint`, not
`fill`, because generic code reads `entity.fill` as a colour string. A pattern
is a list of `.pat`-style line families (`pat.ts` parse/write); `fillLines.ts`
(`hatchFill`) clips them to the loops under the island style with dash phase
anchored to the family origin, and returns a density-guard result
(`truncated`/`inkPerArea`) instead of strokes when a region would need more than
200k — the renderer then draws a tint (`viewport/hatchRender.ts`). The built-in
library (`hatch/library/*.ts`, 70 patterns) is authored clean-room through the
`fam()`/`dots()` DSL — never paste acad.pat/LibreCAD pattern numbers (licence,
plan §0.9). `boundary.ts` (`detectBoundary`, `boundaryFromObjects`) finds the
region under a click with a planar-graph face search and returns loops with
exact edges; the Hatch tool (`tools/hatchTool.ts`, key H, panel
`fill/HatchPanel.tsx`) is its only caller. Sketch code: `hatch H1 pattern
ANSI31 scale 1 angle 0 boundary (x, y) … | …` (`loops N` for curved boundaries).

## Blocks (`packages/core/src/blocks/`, plan §5)

A `BlockDefinition` is a record of the `blocks` table (`types.ts`: base point,
local `entities`, `attributeDefs`, `explodable`, …); an `InsertEntity` names it
and carries `insert/scale{x,y}/rotation/attributes/array`. `evaluate.ts`
(`evaluateInsert`) is the one place a placement is computed — translate ·
rotate · scale · translate(-base), arrays along the rotated axes, nested inserts
cycle-/depth-guarded, layer "0"/BYBLOCK inherited from the insert. **Registry
methods only receive the entity**, so `kinds/insert.ts` resolves the block table
from the *active document* (`context.ts`: `CommandBus` sets it on construct,
execute, undo and redo; code on a bare `SketchDocument` wraps calls in
`withBlocks(doc, fn)`) — a test that builds an insert without a bus must do the
same or it evaluates to a marker cross. Editing a definition (`update-block`)
changes `tablesRevision`, which invalidates every cached evaluation, so all
instances update live. The block commands (`define-block`, `update-block`,
`rename-block`, `delete-block`, `explode-insert`) are macros in `ops.ts` that
expand into table/entity commands. Writers take the definitions as an option
(`entitiesToDxf2018({blocks})`, `entitiesToDxf(..., blocks)`, SVG
`{blocks}` → `<symbol>`/`<use>`); `io/drawingFile.ts serialize()` keeps blocks for DXF 2018, plain SVG and "DXF R12 (keep blocks)" (`dxf-r12-blocks`); print renders them as SVG `<use>`; plain R12, laser SVG and EPS pass entities through `flattenInserts` on purpose. `parseDxf` keeps BLOCKS/INSERT by default
(`{blocks:"explode"}` for callers with no block host: thumbnails, overlays);
a unit rescale must use `scaleEntityKeepingInserts` + `scaleBlockDefinition`,
never `transformed` on an insert (its scale is a ratio). Any new field that names a
block must register a `registerEntityRefRewriter("blocks", …)`.

**Block editor (B-04):** editing a definition opens a `DocSession` with
`blockEdit` set (tab "Block: NAME") whose document is `blockEditDocument()` — the
local entities plus the drawing's other tables. Every change on its bus is
mirrored straight into the parent's definition *without history*
(`liveSyncBlock`, `CommandBus.notify()`), so instances are live; Save restores
the old body then runs one `update-block`, Discard/closing restores it. Code that
treats "a tab" as a file (save, `isSessionBlank`) must respect `session.blockEdit`. Opened from an instance (double-click), the session also carries `contextInsert`: `blockEditBackdrop()` (core `inPlaceBackdrop`) maps the rest of the drawing through the inverse placement and `render` draws it faded behind the definition (REFEDIT view; toggle in `BlockEditBar`).

## Document tables and settings (`packages/core/src/tables.ts`)

`SketchDocument` also holds named **tables** (`layers`, `blocks`, `dimStyles`,
`textStyles`, `linetypes`, `hatchPatterns`, `layouts`, `params`) and
**settings** (`$INSUNITS`, current styles, `LTSCALE`, annotation scale) — all
changed only by `put-table-record` / `delete-table-record` /
`rename-table-record` / `set-settings`. An entity refers to a record by name;
`rename-table-record` rewrites every reference in one undo step through the
rewriters a feature registers (`registerEntityRefRewriter` — a new entity field
that names a table record must register one). The format is **v3**
(`toJSON`/`fromJSON`; v1/v2 load unchanged; unknown tables are kept). Layers
live in the `layers` table: the store's `layers` array is a projection
(`layerList(doc)`) refreshed after every command, so layer toggles are undoable
and saved with the drawing.

## DXF writers

Two, on purpose. `dxfExport.ts` writes R12 (AC1009) — flat geometry, no
handles, what CAM/laser shops want. `dxfw/` (X-01) writes AC1032 ("DXF
2018") — handles + owner pointers on every record, the TABLES/BLOCKS/OBJECTS
skeleton modern CAD expects, and `SKETCHOR` XDATA carrying each entity's
sketch-code name, so a file this writer wrote round-trips names through
Sketchor's own parser (`dxf.ts`'s `sketchorXdataName`) where R12 export
never could. `apps/web/src/io/drawingFile.ts` picks AC1032 for a new save
and R12 only for a tab that was *opened* from an R12/earlier file (or an
explicit "Save As DXF R12"), tracked per-session in `dxfSourceVersions`.
`tools/dxf-audit/` runs the AC1032 writer's output through ezdxf's auditor
(`npm run dxf:audit`) — a local/manual check, not wired into CI;
`npm run dxf:scorecard` writes a drawing corpus, audits it and re-imports it
(`docs/dxf-fidelity-scorecard.md`).

**Sketchor-only data (X-05/X-08/X-09, `sketchorData.ts`, `foreign.ts`).**
Per entity, `1001 SKETCHOR` XDATA carries name (untagged first string),
`id=`, `fill=`, `construction=1`; ids are restored on import (duplicates get
fresh ids; add-imports re-id collisions and drop id-keyed extras). Per
document, one `SKETCHOR_DATA` XRECORD in the root dictionary holds JSON
(groups, constraints, `params`, per-block extras). Groups are also real DXF
`GROUP` objects (members carry the `ACAD_REACTORS` back-reference). A new
field that a DXF cannot express must join one of these carriers, with a
round-trip test in `dxfw/sketchorRoundTrip.test.ts`. Unmodelled ENTITIES
records land in the `foreign` table and are re-emitted by the AC1032 writer
(only when the output unit equals the source's). Binary DXF is converted to
ASCII text in `dxfBinary.ts` before parsing.

## Theming

`packages/core/src/theme.ts`'s `ThemeTokens` (`ui`/`canvas`/`model3d`/`code`)
is the one place colour is defined; `DEFAULT_DARK` is byte-identical to what
used to be hard-coded three separate times (`styles.css`'s `:root`,
`viewport/renderer.ts`'s `COLORS`, `model3d/modelScene.ts`'s
`STAGE_BACKGROUND`/`EDGE_COLOR`/`SELECT_COLOR`). `apps/web/src/theme/themeStore.ts`
(zustand, Dark/Light/System, `localStorage` `sketchor.theme.v1`) resolves a
mode and pushes it to all three: CSS custom properties on `:root`, the
renderer's mutable `COLORS` via `setCanvasTheme`, and the 3D viewer's mutable
colour exports via `setModel3dTheme` (lazy-imported so three.js doesn't load
until something actually sets a theme touching it). A part's own 3D colour
is baked into its mesh at import time and isn't re-themed — `model3d` tokens
are deliberately identical in both themes. `Viewport.tsx`'s and
`ModelViewport.tsx`'s redraw effects both depend on the resolved theme so a
switch repaints immediately.

## Linetypes, lineweight and construction (Z-04)

`dashed: boolean` is gone — split into `linetype?: string` (a name into
`packages/core/src/linetypes.ts`'s nine built-ins: CONTINUOUS, DASHED,
HIDDEN, CENTER, PHANTOM, DOT, DASHDOT, BORDER, DIVIDE, authored clean-room
from ISO 128; a custom/imported name is kept verbatim and just renders solid
via `builtinLinetype`'s fallback), `lineweight?: number` (mm), and
`construction?: boolean` (excluded-from-export-weight, independent of
linetype now). Absent `linetype`/`lineweight` means BYLAYER:
`layerTable.ts`'s `resolveLinetype`/`resolveLineweight` walk entity → the
`LayerRecord`'s own default → CONTINUOUS. `entities.ts`'s
`migrateDashedEntity` (called from `document.ts`'s `fromJSON` and
`clipboard.ts`'s paste) turns an old document's `dashed: true` into both
`construction: true` and `linetype: "DASHED"`, since the one old field meant
both at once.

The renderer (`viewport/renderer.ts`) turns a resolved linetype into real
screen dashes via `linetypes.ts`'s `screenDashPattern` (world mm × `$LTSCALE`
× zoom, with an LOD fallback to solid once the pattern would be sub-pixel
noise) — `drawEntity`'s BYLAYER resolution only happens in the main render
loop, which has a document to resolve against; transient previews (tool
preview, grip drag, measure) just use the entity's own `linetype`. SVG/PDF
export (`svg.ts`, `entitiesPdf.ts`) use the same real mm pattern, scaled to
each format's own units. Both DXF writers (`dxfExport.ts`, `dxfw/`) write a
real `LTYPE` table (CONTINUOUS + every linetype actually used) and groups 6
(name, BYLAYER when absent)/370 (lineweight, hundredths of a mm); `dxf.ts`
reads both back (`rawLinetype`/`rawLineweight`), preferring neither over a
layer default it has no way to resolve at parse time. Layer *colour* is
still unmodeled (X-04 is entity colour only).

A new entity field that sketch code can't express (this trio, plus colour/
fill) must be carried through `sketchtext.ts`'s `diffToCommands` by hand when
it reconstructs an entity from a parsed code edit — it doesn't happen for
free, and a gap here silently strips the field on the next code-panel edit
(a real bug this way, found and fixed while building Z-04).

## SVG (`svg.ts`, `svgStyle.ts`; SV-03..SV-09)

Import resolves style the way a viewer would, minus a CSS engine: presentation
attributes < `<style>` rules (ordered by `specificity`, matched with the DOM's
own `Element.matches`) < `style=""`, inherited through `<g>`; `stroke` →
colour (black = automatic, so it never becomes a literal black on a dark
canvas), `fill` → `fill` on closed shapes, `stroke-width` → `lineweight` mm,
`stroke-dasharray` → nearest builtin linetype. `<defs>`/`<symbol>`/gradients
are never drawn in place; `<use>` of a `<symbol>` imports as an insert of a real block with
`parseSvgText(text, {blocks:"keep"})` (default `"explode"` expands geometry on the use's layer). Layers come from `data-layer`, Inkscape
`groupmode="layer"`, or Illustrator top-level `<g id>`. Anything that walks the
DOM must use `elementChildren` (sibling links, not the live `children`
collection — quadratic in jsdom), respect `MAX_NESTING`, and the result is
filtered to finite numbers. Export writes Inkscape layers, exact `A` arcs and
`mode: "laser"` (hairline, one colour per layer, no fills/text). New SVG
behaviour gets a fixture in `src/fixtures/svg/` + `svgFixtures.test.ts`.

## EPS import (`packages/core/src/eps/`, plan F-01)

No Ghostscript: `interp.ts` is a restricted PostScript interpreter (stack, dict
stack, control, matrices, path/paint/colour/text operators; `Interp` takes the
raw bytes + an origin and returns entities in mm). **Illustrator's AGM/CoolType
prolog is never executed** — `importEpsParts` starts the interpreter at
`%%EndPageSetup` (when the header names `Adobe_AGM_Core`) and the AGM
shorthands (`mo li cv cp clp f ef @ ct lw cmyk sepcs sep add_res get_res img nf
msf sh …`) are native ops. Unknown operators are counted (`unsupported`) and
skipped; every loop ticks an op budget, the operand stack is capped, and
non-finite coordinates are rejected, so hostile input terminates. `paint.ts`
turns subpaths into entities (all-line run → polyline, all-curve → exact cubic
spline, four quarter-turn Béziers → circle, compound fill → one solid hatch;
fill-then-stroke of the same path becomes one entity). Colours: black stays
"automatic" (no colour field), spot colours name the layer. `dsc.ts` strips the
DOS binary header (`C5D0D3C6`) and sniffs the creator (Photoshop → the TIFF
preview becomes an image entity; PDF-based `.ai` → a message, no crash).
`apps/web/src/io/epsImport.ts` reads files in **ranges** (`RangeReader`; Rust
`read_file_range`) — never `arrayBuffer()` a whole EPS: Photoshop ones reach
260 MB. Real customer files are never copied into the repo; tests use inline
synthetic fixtures (`eps.test.ts`). `export.ts` writes EPS (`entitiesToEps`, and `entitiesToEpsFile` with an optional DOS header + TIFF preview): geometry is translated to the lower-left corner and `%%SketchorOrigin x y mm` carries the offset so the importer restores absolute positions — `export.test.ts` pins the 0.001 mm round trip; keep it green when touching either side.

## Build & run

```bash
npm install
npm run dev        # web app at http://localhost:5173
npm run build      # build @sketchor/core then @sketchor/web
npm run desktop    # Tauri dev window (needs Rust toolchain)
```

Rust: if `cargo` isn't on PATH in a shell, `source "$HOME/.cargo/env"` first.

### Desktop release build (macOS, local)

The committed config sets `createUpdaterArtifacts: true`, which needs the
minisign signing key. For a local build without the key, disable it:

```bash
cd apps/web
npx tauri build --bundles app --config '{"bundle":{"createUpdaterArtifacts":false}}'
# -> apps/web/src-tauri/target/release/bundle/macos/Sketchor.app
```

`tauri.conf.json` is cross-platform. Windows-only bundle settings (NSIS target,
the `.dll` resource, the PowerShell `beforeBuildCommand`) live in
`tauri.windows.conf.json`, which Tauri auto-merges on Windows. macOS-specific
Info.plist keys live in `apps/web/src-tauri/Info.plist` (Tauri merges it).

The Rust shell (`src-tauri/src/main.rs`) is fully cross-platform: it emits opened
files to the UI (DXF/SVG as text, DWG and STEP/IGES as base64) and exposes
`list_drawings_in_dir` / `read_drawing_file` / `write_drawing_file` commands.

## 3D model tabs (`apps/web/src/model3d/`)

A STEP/IGES file opens as a *view-only* tab: `DocSession.model` is set (with
`modelLoading`/`modelError` while it isn't yet) and `App.tsx` swaps the
`Viewport` for the lazily-loaded `ModelViewport`. Nothing goes through the
command bus — there is no document behind a model tab and nothing to save.

The pipeline is built for one fact measured on real Onshape exports:
**reading the STEP dominates and tessellation density barely matters**
(0.7 MB → ~0.7 s, 3 MB/1,700 parts → ~3 s, 6 MB/3,000 parts → ~4.5 s in
wasm). Those numbers are with **Sketchor's own build of occt-import-js**
(`apps/web/vendor/occt-import-js/`, reproducible from
`native/occt-import-js-build/`): the upstream npm package looked up every
face's colour with a linear scan of all labels, O(faces × parts), which
made the same files take 28 s and 93 s. Don't reinstall the npm package —
the worker imports the vendored `.mjs`/`.wasm` directly. So:

- `occt.worker.ts` runs occt-import-js; `stepImport.ts` is a pool of up to
  three workers with a queue where *opens* preempt *thumbnails*, and requests
  for identical bytes share one parse.
- `buildModel.ts` (pure, tested) merges every mesh into **one** vertex/index
  buffer plus a part table of ranges, and bakes vertex colours. Hiding works
  on those ranges — two draw calls for any assembly, and picking is
  box-prefiltered + `drawRange`-scoped raycasts.
- `topology.ts` (pure, tested) recovers the **B-rep** from the tessellation:
  `brep_faces` tags give faces; a welded triangle edge shared by two
  *different* faces is a B-rep edge; those segments chain into edges (a
  junction or an open end ends a chain), each chain is fitted to a line,
  circle or arc, and chain endpoints become vertices. Faces carry
  area/perimeter/centroid/normal/planarity, parts carry area and volume.
  Everything is flat typed arrays (`FaceTable`/`EdgeTable`/`VertexTable`),
  so a model still structured-clones out of the worker and into IndexedDB.
- `modelCache.ts` persists models and thumbnails in IndexedDB keyed by
  `LAYOUT_VERSION:sha256(bytes)`; bump `LAYOUT_VERSION` whenever `Model3D` or
  the extraction changes. LRU-evicted past 768 MB.
- `modelThumbnail.ts` renders the file-browser's isometric PNG through one
  shared offscreen WebGL context (browsers cap live contexts).
- Z is up *as displayed*. View presets live in `modelScene.ts`. A STEP file's
  own up axis is detected from its FILE_NAME header (`upAxis.ts`:
  SolidWorks/SwSTEP → Y-up; the worker stamps `Model3D.detectedUp`, and
  `native/step-wire` `is_y_up` mirrors the rule for Explorer's wireframe).
  The user can override per file (toolbar "Z up / Y up", `view.toggleUpAxis`,
  saved in localStorage `sketchor.modelUpAxis.v1` by hash). The turn is
  applied to the **model data** — `reorientModel()` returns a copy with every
  coordinate array rotated — not to a scene matrix, so picking, measure,
  overlays, fit and thumbnails all agree without each needing the matrix.
  If you add a coordinate-bearing field to `Model3D`, add it to
  `reorientModel` (its test lists what must move).
- Files over `COARSE_THRESHOLD_BYTES` (30 MB) tessellate coarser, get no
  thumbnail parse (`THUMBNAIL_MAX_BYTES`), and hold back thumbnail workers
  while they open.
- **Selection is Onshape's**: a click picks the topology under the cursor —
  vertex, then edge, then the face the ray hit (`picking.ts`, pure: the
  viewer passes a world→pixel projector, so the search is testable without a
  camera). Shift/Ctrl adds, up to 8. `measure.ts` (pure, tested) turns the
  selection into the bottom-right readout: one pick gives length, diameter,
  area or volume, two give distance and angle. `viewerStore.ts` (zustand)
  holds selection/hover/hidden so the canvas and the Structure panel drive
  the same state; `StructurePanel.tsx` is the assembly tree, which replaces
  the Layers panel in a model tab (layers mean nothing to a STEP file).
  Highlighting: faces/parts repaint the shared colour attribute, edges and
  vertices go into overlay `LineSegments`/`Points` with `depthTest: false`.
- **There is no separate measure tool** — selecting *is* measuring, and
  `measure3d.ts` (the old free-point one) is gone. `measureSelection`
  returns `{ rows, segment }`: the segment is the two points the distance
  was actually taken between, so every pair measurement also yields
  ΔX/ΔY/ΔZ *from the same two points the line is drawn between* — the
  picture and the numbers cannot disagree. The viewer draws it as a
  screen-space SVG overlay (direct span + three dashed axis legs, a leg
  under 3 px suppressed), re-projected in the `afterRender` hook and also
  synced immediately when the selection changes, so a measurement never
  appears a frame late.
- **Isolate**: `viewerStore.isolate(parts, partCount)` hides everything
  else and bumps `fitRequest`, which the viewer answers with a fit — the
  point of isolating a screw is to see it. Reachable from the Structure
  panel's right-click menu (a part row, or a whole sub-assembly node,
  which isolates its subtree), the toolbar, or `I`. Show all reverses it.
- **Explorer previews** (Windows): every rendered thumbnail is also mirrored
  via the `write_thumbnail_cache` command to `%LOCALAPPDATA%\Sketchor\thumbs\<sha256>.png`; `native/dxf-thumbnailer` (`src/model.rs`) hashes the file
  and serves that PNG, else falls back to `native/step-wire` — a text-level
  B-rep edge extractor that resolves NAUO/CDSR/ITEM_DEFINED_TRANSFORMATION
  placements and MAPPED_ITEMs (both rep_1/rep_2 orderings seen in the wild
  are handled by matching against the child's representations). The DLL
  registers `.dxf .step .stp .iges .igs .eps .ai` (`EXTENSIONS` in lib.rs; `.eps`/`.ai` read the DOS-EPS TIFF preview directly — `eps.rs` — and their HKLM markers are created only when missing, so Illustrator's handler is never overwritten). Verify
  end-to-end with `cargo run --release --example verify_shell_thumb -- file.step out.png`;
  the shell caches by path+mtime, so test a fresh copy after changing a sidecar.
- **Two Explorer gotchas that cost a release (0.14.2):** (1) Explorer keeps
  the DLL mapped, so an installer can't overwrite it — the NSIS pre-install
  hook renames it to `.old` first; `DllCanUnloadNow` counts live instances so
  Explorer can drop the idle old module. (2) **Windows 11 Explorer only
  consults a thumbnail handler for an extension if
  `HKLM\Software\Classes\<ext>\ShellEx\{E357FCCD-…}` exists** (value may even
  be empty; the CLSID resolves from HKCU). `IShellItemImageFactory` and the
  `LocalThumbnailCache` service from any other process do NOT have this
  rule, which is why every probe passed while Explorer showed icons. DXF
  only worked on the dev PC because eDrawings had left that key. The
  per-user installer asks for elevation once (skipped when silent), and
  `desktop/explorerPreviews.ts` asks at launch when the markers are missing
  (on by default; declines respected for a week; never mid-update) via the
  `explorer_previews_status` / `enable_explorer_previews` commands — one
  `regedit /s` import of a generated .reg file, so the UAC dialog reads
  "Registry Editor". To see what Explorer
  actually asks the DLL, create an empty `%LOCALAPPDATA%\Sketchor\thumb-debug.log`
  — every request is appended (opt-in trace in lib.rs).

**Mesh formats (F-05).** STL/OBJ/PLY/3MF/glTF/GLB are read by pure parsers in
`packages/core/src/mesh/` (`parseAnyMesh`) inside the same worker
(`handleMesh` in `occt.worker.ts`), then `segmentMesh` fakes a B-rep: faces =
connected triangle regions under a 20° dihedral, each with its own vertices, in
the occt-import-js result shape — so `buildModel`/`topology.ts` are unchanged.
Mesh files carry no unit (mm assumed; glTF is metres, 3MF has a `unit`).

Debug: `window.sketchor.openModel(name, arrayBuffer)` / `getModel()`.

## Printing and autosave (`apps/web/src/print/`, `io/autosaveFolder.ts`)

`printHtml(bodyHtml, { fileName, pdf })` is the one print path — the
toolbar's Print, and every plugin's `sketchor.ui.print` (host API 0.7.0
carries `fileName` and the optional `pdf`). It renders an in-page preview
rather than a popup, because popup blockers and the desktop webview both eat
`window.open`.

Its bar also **autosaves**: a folder the user picks once is kept as a
`FileSystemDirectoryHandle` in IndexedDB (a path string wouldn't carry the
browser's grant with it), and each printed sheet is written there on the
Print click — as the caller's `pdf` when there is one, otherwise as a
standalone HTML document. A plugin can offer that same folder inside its own
panel through `ui.printFolder` / `ui.pickPrintFolder` (the load planner
does); picking a folder is itself the request to file copies there, so there
is no second checkbox to find. Two rules that are easy to get wrong:

- The write must happen **inside the click** that starts the print. A
  restored handle comes back in the `prompt` permission state, and
  `requestPermission` is only granted during a user gesture — and
  `window.print()` blocks, so anything after it has missed the window.
- A remembered folder can be renamed, unmounted or revoked. Every call
  fails soft and reports why in the bar, rather than throwing into the
  middle of printing.

Chromium only (`showDirectoryPicker`); the controls are simply absent
where the API isn't there, and printing behaves as before.

**The PDF is written here, not by the OS dialog** (`packages/core/src/pdf.ts`,
`entitiesPdf.ts`): a hand-rolled PDF 1.4 writer — paths, solid fills and the
base-14 Helvetica, no dependency — because `window.print()` can only reach a
PDF through the dialog, where the user picks the folder every time, which is
the whole thing autosave exists to avoid. `PdfBuilder` takes page points with
Y **down** from the top-left and flips once on the way into the content
stream; `drawEntitiesToPdf` fits an entity list into a box, mirroring
`entitiesToSvgDocument`. Any change there needs `pdf.test.ts`'s structural
assertions to still hold — a wrong xref offset produces a file that opens as
"damaged" weeks later, when the load it recorded is long gone.

### One drawing, three renderings

The load planner's sheet is **not** a second drawing of the plan. It renders
the entities on the "Load Plan" layer — the same list `entitiesToDxf` writes
— so the printed sheet, the filed PDF and the exported DXF cannot drift
apart. `forPaper()` (in `plugin-truck-nesting/src/layout.ts`) is the only
thing between them, and it only *re-inks*: the dark-workspace lettering goes
black, the white clearance guides and the on-canvas summary block drop out.
Geometry, positions and pallet colours are never touched. The plan's own
lettering is light (`DEFAULT_ANNOTATION_COLOR`) because the workspace is
dark, and the panel lets the user change it — as it does each drop's colour,
which defaults to the Okabe–Ito set (distinct for colour-blind readers and
in grayscale).

## Tools (`apps/web/src/tools/`)

Drawing tools are state machines on the framework in `tools/tool.ts`
(`Tool`: `prompt/busy/anchor/cancel/pick/doubleClick?/key?/preview`), one
instance each in `tools/index.ts`; `Viewport.tsx` decodes input (object
snap → ortho/polar tracking → typed coordinates → touch deferral) and hands
the tool finished `Pick`s, draws `preview()` dashed, and shows `prompt()`
in the status bar. Tools not yet migrated (select, measure, text, image,
fill, straighten, dim, pan) still run as `case`s in `Viewport.tsx`'s
pointer handlers — `getTool()` returns null for those. Migrating one means
moving its case into a class and deleting its `interaction` kind.

## The constraint solver (`packages/core/src/solver/`, roadmap T-40)

Constraints move geometry. The engine is **Sketchor's own**, not planegcs:
a Levenberg–Marquardt least-squares solve over constraint residuals, a few
hundred lines of pure TS, tested like the rest of the core. `solver/index.ts`
exports only `solveSketch` so the engine stays replaceable.

- `num.ts` — scalars that carry their own derivatives (sparse forward-mode
  AD). Residuals are written the way they read; the Jacobian falls out
  correct. This is what lets a constraint on an *arc's endpoint* reach
  through the centre, radius and angle without anyone deriving that by hand.
- `model.ts` — the document ↔ parameter mapping (line 4, circle 3, arc 5,
  point 2, polyline 2·n; text/image none, so they add no phantom DoF).
  `fix` **freezes** parameters rather than adding equations, so a fixed
  entity removes degrees of freedom instead of fighting for them.
- `residuals.ts` — one constraint → its equations, all in mm or radians.
  Parallel/perpendicular divide by the lengths (a bare cross product is mm²
  and grows with the drawing, which quietly biases least squares).
- `solve.ts` — LM with **uniform** damping (λ·max diag). Per-entry damping
  leaves rank-deficient directions barely damped and returns a huge step
  through the null space: the line comes back parallel *and* three times
  longer. Uniform damping gives the minimum-norm step, which is also what a
  user means by "satisfy this constraint". DoF = free params − Jacobian
  rank; a violated row names its constraint (conflict), and dropping a
  constraint without changing the rank names it as redundant.
- **Bus middleware** (`commands.ts`): `execute` solves after applying, and
  the resulting `update-entity` moves join the *same* undo entry — one
  Ctrl+Z, or you'd undo to a sketch satisfying nothing. `redo` re-solves
  for the same reason; `undo` only re-reads the verdict (`maxIterations: 0`)
  because the geometry it restored was already solved. `bus.lastSolve`
  feeds the status-bar DoF readout.
- **Drag-solve**: `bus.solveSilently({ drag })` runs without touching
  history — the viewport's grip drag uses it when the sketch has
  constraints (`gripPointRef` maps a grip to a `PointRef`), so dragging a
  corner drags everything tied to it. A drag is solved in **two passes**:
  once with the cursor's pull as an equation, then again without it.
  Weighting the pull as one soft equation among hard ones is the obvious
  approach and the wrong one — it leaves every constraint slightly
  violated in proportion to how hard the user pulls.

- **Foot parameters** (`footCurves.ts`, C-09): a constraint with no closed
  form (point on a spline, an ellipse/spline tangent to a line/circle) gets one
  extra unknown `t` — the contact point's curve parameter — appended after the
  entity parameters (`SketchModel.aux`, started at the nearest contact each
  solve, never written back). A new curve kind joins by adding a `curveEval`
  case (point + derivative as `Num`s); `solve.ts` calls `addFootParams` once.

**Creating them** (T-41) is selection-driven, as in Onshape: select the
geometry, then press the constraint. `constraintBuilder.ts` (pure, tested)
decides what applies — `constraintOptions(selection)` for which buttons
light up and *why* a disabled one doesn't, `buildConstraints(kind, …)` for
the constraints themselves. Where a constraint needs points and the
selection only names entities, `nearestPair` picks the ends nearest each
other, which is what the user was looking at when they asked.
`constraintDisplay.ts` (pure, tested) says where each constraint's glyph
hangs; `constraints/ConstraintPanel.tsx` is the panel (Ctrl+2) and owns
the glyph characters. In the viewport a glyph click selects the geometry a
constraint holds and a double-click removes it.

**Driving dimensions** (D-02b): a `DimensionEntity` with `driving: true` and a
`value` *is* a constraint — `dimensions/driving.ts` derives it (`distance`
with optional `axis`, `radius`, `angle`) and `SketchDocument.solverConstraints()`
(explicit + derived) is what the bus gives the solver; there is no second
record. Editing `value` moves the geometry in the same undo step. Not yet
built: the value-edit UI.

**Inference and DOF feedback** (T-43/T-44): `inference.ts` (`inferConstraints(added, existing)`) reads the
relationships a finished drawing already has to 1e-6 mm (coincident, horizontal/vertical, midpoint, point-on-curve,
perpendicular, tangent, parallel) rather than tracking snap provenance; `tools/autoConstrain.ts` appends them to the
drawing tools' `execute/commit` batch when the AUTOCON toggle is on (Ctrl on the click suppresses). `SolveResult.underDefined`
+ `dofState.ts` give each constrained entity a state the renderer tints (`canvas.dofUnder`/`dofConflict` tokens).

## Typed input and the command line

Typed input has two front ends and one back end: the floating coordinate
box (digits open it) and the docked command line (`tools/commandLine.ts`
parses, `tools/CommandBar.tsx` types, `runCommand` in `Viewport.tsx`
executes). Both commit through `commitTypedText`, which asks the tool to
read the string itself (`typed()` — an angle for rotate, a factor for
scale) before resolving it as a coordinate against the tool's anchor, or
against the **relative zero** (the last point any tool placed) when the
tool has none.

Where a point lands is a pipeline, and its order is load-bearing:
object snap (`viewport/snapping.ts`) → ortho/polar from the tool's anchor
(`tools/tracking.ts`) → object snap tracking (`viewport/objectTracking.ts`,
T-20) → raw cursor. A feature snap the cursor actually touched always wins,
as in AutoCAD; tracking only replaces the fall-through result. Hovering a
feature point acquires it (three deep, newest first), and `trackAlignment`
returns the projection — or, when two acquired alignments cross near the
cursor, their intersection. All three stages are pure and tested;
`resolvePick` in `Viewport.tsx` is the only place that sequences them.

Selection lives in `packages/core` too, so the rules are testable without a
canvas: `boxSelect.ts` (window/crossing rectangles), `polygonSelect.ts`
(lasso polygons, fence strokes, entity outlines, path thinning) and
`selectFilter.ts` (select-similar and Quick Select). `Viewport.tsx` only
supplies the gesture and the candidate list. Every selection path — click,
box, lasso, fence, Ctrl+A, select-similar — goes through
`selectableEntities()` in `state/store.ts`, which drops hidden **and locked**
layers; a new path that calls `doc.all()` directly is a bug (it would let a
click grab geometry the user locked).

Geometry the editing tools stand on, all in `packages/core` and tested:
`intersect.ts` (entity → `Path` of segment/arc curves, `intersectCurves`,
`trimAt`/`splitAt`/`extendTo`, `entityFromPath`), `fillet.ts`, `offset.ts`
(signed left-offset per curve + re-joining; the join heuristics — drop
inverted legs, drop anti-parallel slot walls, bridge collinear seams —
are the 95 % case, not a full self-intersection cleanup). Tools in
`tools/editTools.ts` only pick and commit `delete + add` batches.

Rules for a new tool (roadmap T-00):
1. Geometry math is a pure function in `packages/core` with a test
   (`arcs.ts` is the model). The tool only collects picks and calls it.
2. Emit `Command`s through `ctx.execute`/`ctx.commit` — never mutate entities.
3. `anchor()` is what relative typed input (`@dx,dy`, a bare length) and
   ortho/polar measure from; return null for a pick that must not be
   constrained (a 3-point arc's on-arc pick).
4. Tool-local keys go in `key()`, which runs before the global bindings —
   but only consume a key while `busy()`, or you steal a tool shortcut
   (polyline's A/T/L are only live mid-polyline; the arc tool cycles modes
   with Tab for the same reason). Digits, `@`, `-`, `.` open the typed
   coordinate box (`typedInput.ts`) and are never tool keys.
5. `cancel()` must leave the tool idle; Esc calls it, then falls back to
   the select tool as before.

`docs/sketching-tools-roadmap.md` is the backlog (T-xx ids); its progress
log at the top says what's done.

## Touch (`apps/web/src/touchMode.ts`)

Gestures work everywhere, regardless of the setting: in the 2D viewport one
finger is the tool (its pointerdown is *deferred* until the finger moves,
lifts, or is joined — a pinch always starts with one finger down, and the
tools act on pointerdown), two fingers pan/pinch-zoom from any tool and keep
a half-drawn entity like a middle-drag pan does, double-tap fits. The 3D
viewer's touch handling is OrbitControls plus tap/double-tap/long-press.
**Touch mode** is only layout: a persisted preference (default: the
`pointer: coarse` media query, toggle in the topbar) that puts `.app.touch`
on the root — the tool rail moves to the bottom as big labelled buttons, and
so does the model toolbar. A "pan" tool exists so one finger can pan too.
## Usage statistics (`apps/web/src/metrics/`)

Opt-out PostHog analytics; `README.md` says what is sent. The rules that
matter when touching it: events go through `track()` only, `actions.ts` is a
*whitelist* — `TRACKED_BUTTONS` for fixed `data-testid`s, `TRACKED_PREFIXES`
for the runtime-built ones, where the suffix is kept only if it is an app
constant checked against the real list (a tool id, a snap or constraint kind)
and dropped when it is the user's words or a plugin id (`layer-<name>`,
`structure-part-<name>`, `install-<plugin id>`); a family with no rule stays
uncounted. A button and the shortcut, command-line command or palette entry
that do the same thing report the **same** action id and differ only by
`source` (`COMMAND_LINE_ACTIONS` maps the command line's bare words onto
them), so don't invent a second id for a second path. `app_launched` goes out
once per tab (`shouldCountLaunch`, marked in *session* storage): a reload is
not a launch, and `npm run dev` forces one by itself the first time Vite
optimizes a lazily imported dependency. File events carry an
extension and a `magnitudeBucket`, never a
name, errors go through `reportError(err, context)` (window `error` /
`unhandledrejection` are already hooked) and every exception message passes
`scrubText` in `before_send`, and anything new must survive
`setMetricsEnabled(false)` — see `metrics.test.ts`. `POSTHOG_KEY` empty or a dev build without
`VITE_METRICS_DEV=1` makes the module inert, which is what tests run against.

## Testing

```bash
npm test                                        # vitest, whole workspace
npx vitest run packages/core/src/dxf.test.ts    # one file
npx vitest                                      # watch
```

Tests live next to the code they cover (`foo.ts` -> `foo.test.ts`), never in a
separate tree. `vitest.config.mts` aliases `@sketchor/core` and
`@sketchor/plugin-sdk` to their TypeScript *sources*, so tests exercise exactly
what the app builds; both tsconfigs are `include: ["src"]`, so `npm run build`
typechecks the tests too.

The environment is `node`. Code touching a browser API opts in per file with a
`// @vitest-environment jsdom` docblock on line 1 — only `svg.test.ts` does, for
`DOMParser`. Don't switch the global environment to accommodate one test.

`docs/testing-plan.md` is the running survey: what is covered, what isn't, and
which tier each gap sits in. Update its status when you close one out.

### What a new feature has to cover

- **A new `Command` type** must be added to the `CASES` table in
  `commands.test.ts`. That table drives the execute/undo/redo round-trip across
  every command type, and a command missing from it is a command whose inverse
  nothing checks — the one failure mode that corrupts a drawing silently.
- **A new entity field** (e.g. `LineEntity.infinite`) has to be considered in
  `renderer.ts`, `intersect.ts`'s `pathOf`, both exporters, and `sketchtext.ts`'s
  `diffToCommands` (the DSL can't express it, so an edit must carry it over).
- **A new entity type** needs `translated`/`rotated`/`transformed` preserving
  id/name/layer/colour/fill, a sketch-code round-trip (`toCode` -> `parseCode` ->
  `diffToCommands` updating in place with the same id), and DXF + SVG round-trips.
- **Any change to an IO module** (`dxf`, `dxfExport`, `dxfw`, `svg`) needs a *round-trip*
  test, not a golden string: write it, read it back, compare geometry. Assert on
  file text only for what a round-trip can't see — header variables, the layer
  table, the numeric formatting convention.
- **A scan-and-fix module** (`heal`, `duplicates`, ...) needs the idempotence
  property: apply every fix, rescan, get nothing, and a second pass must not
  oscillate. Also assert that undoing the fix batch restores the document.
- **Anything parsing a user-supplied file** must be tested against empty,
  truncated and structurally malformed input. It has to return a result — never
  throw, never fail to terminate. Both defects this suite has uncovered so far
  were this shape — an unbounded loop in an SVG path, a stack overflow on a
  group cycle — and neither was reachable from the UI's happy path.

### Conventions

- Open each test file with a short docblock saying *why this code is worth
  testing* — what breaks in a user's drawing if it regresses, not what the
  functions are named.
- Compare document state order-insensitively (sort by id). Undoing a delete
  re-inserts the entity at the end of the `Map`, so insertion order is not an
  invariant; identity and content are.
- Prefer a property to a literal: "every point moved by the same offset", "the
  curve is unchanged", "the rescan is empty". Literals are for pinning a format
  (a DXF group code, an SVG attribute), not geometry.
- Give `toBeCloseTo` a precision you can justify. DXF coordinates round to six
  decimals *in file units*, so the millimetre tolerance depends on the drawing's
  declared unit — assert against that bound rather than guessing an epsilon.
- When a test pins behaviour that is lossy or surprising (sketch code drops
  polyline bulges; SVG export renders a point as a dot; a clockwise DXF arc comes
  back counterclockwise), say so in the test name and a comment, so the next
  reader knows it is intended and not a bug to "fix".

## Native geometry-thumbnail extensions

Both platforms preview DXF geometry on the file icon, sharing one renderer:

- `native/dxf-parse` is the single source of truth: `parse(&str) -> Vec<Shape>`
  (Line + Circle; arcs/polylines flattened to segments) and
  `project(shapes, size, pad)` (fit-to-box, Y-flip). Colors match everywhere:
  background `#1E1F22`, stroke `#C7D0DC`/`#dfe1e5`, ~10% padding.
- **Windows** (`native/dxf-thumbnailer`): a Rust COM `IThumbnailProvider` DLL,
  built/staged by `native/build-shell-extensions.ps1`, installed per-user via
  `install-thumbnailer.ps1`. Standalone crate; path-depends on `dxf-parse`.
- **macOS** (`native/dxf-quicklook`): a `QLThumbnailProvider` `.appex`. Rust FFI
  (`ffi/`, a `staticlib` over `dxf-parse`) does parse+project; Swift
  (`Sources/`) strokes with Core Graphics. Built **without Xcode** (swiftc +
  codesign) by `build-quicklook-macos.sh`; see `native/dxf-quicklook/README.md`.

### macOS Quick Look: build → embed → test

Tauri can't bundle an `.appex`, so it's embedded after `tauri build`:

```bash
native/dxf-quicklook/build-quicklook-macos.sh              # -> build/DxfThumbnail.appex
native/embed-quicklook-macos.sh /path/to/Sketchor.app     # inject + re-sign
```

Gotchas that cost real time:
- **Not testable via `tauri dev`.** Quick Look only discovers an extension inside
  a Launch-Services-registered app — so build, embed, put the app in
  `/Applications`, launch once.
- **Exact-UTI match required.** macOS has no built-in DXF type; the host app
  exports `com.sketchor.dxf` (`src-tauri/Info.plist`) and the extension lists that
  exact string in `QLSupportedContentTypes`. Verify with
  `mdls -name kMDItemContentType file.dxf`.
- **Retina:** the drawing context is `maximumSize × scale` pixels. `DxfRender`
  sizes from `ctx.width`/`ctx.height` and flattens the CTM so it fills the whole
  thumbnail (getting this wrong renders it small in the bottom-left corner).
- **Stale extension:** after re-embedding, `qlmanage -r && qlmanage -r cache`,
  then `pkill -f DxfThumbnail; killall quicklookd Finder` — macOS caches the old
  extension binary otherwise.
- Inspect the renderer without registering anything:
  `native/dxf-quicklook/render-sample.sh drawing.dxf out.png 512`.

Status: macOS support is arm64-only and ad-hoc signed. Universal (`lipo`) build,
Developer ID signing + notarization, and a spacebar `QLPreviewProvider` are
follow-ups. The Windows crate can only be compiled on a Windows target — verify
`dxf-thumbnailer` there (CI `release.yml`) after touching `dxf-parse`.
