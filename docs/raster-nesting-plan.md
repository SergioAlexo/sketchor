# Sheet nesting rewrite — port of the "Sheet Nesting Calculator" — plan

Status: plan only (2026-10-22). Item IDs `RN-xx` are stable — reference them in commits.

Supersedes the panel part of `docs/sheet-metal-nesting-plan.md` (N-20) and
NF-05/06/08 from `docs/polyline-and-nest-fixes-plan.md`. The raster engine
becomes the default; the existing NFP engine (N-10/11/12/13/14) **stays** as a
"True shape" option (user decision, 2026-10-22). Also keeps what that work
produced and the reference lacks: canvas layers, PDF report, G-code
toolpath/writer, Check nest.

## 1. What the reference is

**Credit:** the reference calculator — its raster engine, DXF-to-part rules,
job setup and parts-list intake — was developed by **Oleksandr Borenko**.
Every file ported from it says so in its header docblock, and the nest panel's
footer and the printed report show "Nesting engine based on the Sheet Nesting
Calculator by Oleksandr Borenko".

A single offline HTML file (two calculators in one shell:
**bar cutting** and **sheet nesting**). Only sheet nesting is in scope; bar cutting
is listed under Later. The sheet calculator has four pieces:

| Piece | What it does |
|---|---|
| **Raster engine** (`NestEngine`, ~310 lines, no DOM) | Rasterises every part × allowed angle onto a grid (cell 0.1 / 0.05 / 0.025 in), dilated by `spacing/2 + cell·√½ + arcTol` so clearance is conservative. Masks are 32-bit word rows pre-shifted 32 ways; placement is first-fit with a per-(part, angle) monotone scan pointer, a per-row "longest free run" pre-filter and a bisecting row probe order. Holes are even-odd empty cells, so small parts drop into big holes for free. Multi-stock: stock types with quantities + an optional unlimited "to purchase" size. Time budget → seeded random restarts (order noise, jitter, top/centre/bottom criterion, 90°-only subset), score = unplaced ≫ purchased ≫ sheet area ≫ last-sheet extent. Stops early at the area lower bound. Streams best-so-far. |
| **DXF → part** (`DXF.parseDxf` + `buildPart`) | LINE/ARC/CIRCLE/LWPOLYLINE/POLYLINE/ELLIPSE/SPLINE/INSERT; helper lines (bends, centerlines) dropped with a note; duplicate primitives removed; endpoint chaining via spatial hash (join 0.002, close 0.01 in); contour depth by containment → outer vs holes; centred on bbox; net area, cut length, hole count; errors for open contours (count + max gap), warnings for multiple outer contours, guessed units. |
| **Job setup** | Material (AL 5052/6061, SS, CS, plastic, plywood, stone, quartz) → default sheet sizes and standard-thickness picker (gauges); machine (laser / waterjet / CNC router / other) → kerf, web, margin, clamp strip, bed size; rotation per part (none, 0/180, every 90/45/30/15/10°, any 1°; stone/quartz default none); accuracy; optimisation time (first / 10 s / 30 s / 2 min); display units (fractional in, decimal in, ft-in, mm, cm, m). |
| **Intake + output** | Manual rows (one DXF = one part) or **groups mode**: a parts list pasted / CSV / screenshot (OCR via tesseract.js) → only `SHEET` material rows → grouped by material + thickness, each group nested separately; files found by part number in a chosen folder (subfolders, `-X5`/`x5`/`(5)` suffix = file holds 5 pieces; OCR digit look-alike repair). Results: KPIs (sheets, to purchase, utilisation, parts, cut length, pierces), stock-usage table, identical sheets collapsed ("Sheets 3–7 ×5"), zoomable sheet view, CNC router checks (holes under bit Ø, sharp inside corners), DXF per sheet (layers CUT_OUTER / CUT_INNER, optional SHEET, origin lower-left, original arcs kept) or all as ZIP, saved HTML report that reopens the job, 6 UI languages. |

## 2. Current Sketchor vs reference

| Area | Sketchor today (`packages/plugin-nest`, `nestPlugin.ts`) | Reference | Take |
|---|---|---|---|
| Engine | NFP via clipper, candidate-vertex placement, ~cubic, capped at 600 instances; Quick/Normal/Thorough = reorderings | Raster bitmask, linear-ish, no practical cap, any-angle cheap, holes free | **Both**: raster default, NFP as "True shape" |
| Part-in-hole | Opt-in `allowInHoles` per part | Automatic | Reference, plus a post-pass that rebuilds `insideOfPlacementIndex` for G-code |
| Rotation | locked / quarter / any (+ mirror) | none / flip / step 90…10 / 1° | Reference set; keep mirror as a flag |
| Stock | Stock rows, shrink last sheet | Stock with qty + unlimited purchase size, clamp strip, bed warning | Reference; keep shrink-last as an option |
| Part source | Canvas selection only | Files, folder + BOM/CSV/OCR groups | Both: selection stays, add files + groups |
| Units | mm internally | inches internally | Engine stays unit-agnostic; plugin works in mm, defaults seeded in inches |
| Output | 4 canvas layers, DXF, PDF/print, G-code | SVG cards, DXF/ZIP, HTML report | Keep ours, add identical-sheet grouping, KPIs, ZIP, reopenable report |

## 3. Decisions (recommended; confirm before RN-1x)

1. **Two engines, one job.** *(Decided 2026-10-22.)* Raster is the default;
   the existing NFP engine (`trueNest.ts`, `nfp.ts`, `search.ts`,
   `polygonOps.ts`, clipper dep) stays as **True shape** — exact clearance,
   explicit part-in-hole control, mirror. Both sit behind one `NestEngine`
   interface (RN-06) that takes the same job and returns the same placement
   type, so intake, results, canvas, DXF, PDF and G-code never know which ran.
   An option one engine can't honour is greyed out in the panel with the
   reason, never silently ignored. `plugin-nest` is only consumed by
   `nestPlugin.ts` + `nestReport.ts`, so the blast radius is one plugin.
2. **Faithful port first, improvements second.** RN-01 is a line-for-line TS
   port that must reproduce the reference's placements exactly for the same
   seed (golden test). Only then tune.
3. **DXF reading uses Sketchor's own `dxf.ts`** (better INSERT, unit
   resolution, encoding) — we port only `buildPart`'s contour rules (dedupe,
   helper-line filter, depth, warnings) into `partExtraction.ts`.
4. **Public repo hygiene:** no part numbers, folder paths or customer
   examples from the reference in tracked files or fixtures (the BOM hint text
   uses real-looking numbers — replace with `PN-0001` style).

5. **Separate plugin (2026-10-22).** New functionality ships as a separate plugin `Sheet Nesting` (`com.sketchor.sheet-nesting`); the old Sheet Metal Nest is left unchanged.

## 4. Work items

### Phase 1 — Engine (packages/plugin-nest/src/raster/)

- **RN-01 Port `NestEngine.nest` to TS** (`raster/engine.ts`). Typed input
  `{ parts:{polys, rots, qty, area}[], sheetTypes, extra, spacing, margin, clamp, cell, arcTol, timeMs, seed, crit }`,
  typed result `{ sheets:{placements:{t,deg,tx,ty}[], w,h,tidx,extra,extentIn}[], unplaced, ms, iterations, lbSheets }`.
  Keep the bit tricks (Uint32 words, 32 pre-shifts, `maxRun` filter, probe order). **M**
- **RN-02 Golden test vs the reference.** A test-only harness evaluates the
  reference engine source (kept outside the repo, path via env var, test
  skipped when absent) and compares placements on ~8 synthetic jobs (rects,
  L-shapes, ring with hole, mixed angles, stock + purchase, clamp). Plus
  in-repo invariants: no two placed polygons closer than `spacing`, all inside
  margin/clamp, counts conserved. **S**
- **RN-03 Cooperative time budget.** The plugin worker can't receive "cancel"
  while a sync loop runs — split the restart loop into slices that `await` a
  macrotask every ~50 ms; `onBest` → `nest-progress` message with the packed
  best-so-far; Stop returns it. **S**
- **RN-04 Adapter to our types.** mm in/out; placement → `{partId, sheet, rotationDeg, translation}`
  matching what `trueLayout.ts`/`metrics.ts`/G-code consume; post-pass sets
  `insideOfPlacementIndex` (placed part's centroid inside another placement's
  hole polygon). Cell choice = reference `chooseCell` (≤ minDim/12, ≤ 9 M cells
  per sheet), accuracy presets 2.5 / 1.25 / 0.6 mm. **S**
- **RN-05 Benchmark.** Same jobs through NFP and raster: sheets,
  utilisation, time; include the 600-identical-parts perf case. Record numbers
  in this file — they become the panel's one-line hint on when to pick True
  shape (e.g. "few large parts, tight kerf"). **S**
- **RN-06 `NestEngine` interface + selector.** `{ id: "raster" | "true-shape", supports(job) → unsupported option list, run(job, hooks) }`;
  both engines take the RN-20 job and return RN-04's placement type with
  streaming best-so-far and cancel. NFP gains what it can cheaply: rotation
  step sets (via `rotationCandidates`), stock qty + purchase size, clamp strip
  as a reduced usable area. The 600-instance cap stays on True shape only and
  is reported up front, not as a failure. **M**

### Phase 2 — Part intake

- **RN-10 Contour rules into `partExtraction.ts`:** duplicate-primitive
  removal, helper-line filter (bend / centerline layers and linetypes, reported
  as a note), close-gap tolerance distinct from join tolerance, "N separate
  outer contours" warning, cut length + pierce count + hole count per part. **M**
- **RN-11 Add files (= NF-06).** "Add files…" (DXF/DWG/SVG), one part per file,
  unit from `resolveUnits`, "Files without units" default, per-row unit
  override. Thumbnails reuse `entitiesToSvg`. **M**
- **RN-12 Host API: folder pick + list + read** (`ui.pickFolder()` →
  `{name, files:[{relPath,size}]}`, `fs.readPicked(relPath)`), web via
  `showDirectoryPicker`, desktop via the existing `scan_drawings`. Additive,
  bump `HOST_API_VERSION` to 0.9.0. Must be called from a click. **M**
- **RN-13 BOM / CSV parser** (pure, tested): port `parseSheetText`,
  `splitCsvLine`/`csvDelim`, header detection, `cleanNum`, `classifyMat`,
  `thickFrom`, repeated numbers summed, missing qty kept as empty. **S**
- **RN-14 File lookup by part number:** exact name, then `<num>[-_ ](x)N(pcs)`
  = file holds N pieces (need = ⌈qty/N⌉), then prefix + separator; never a
  "closest" guess; OCR look-alike repair only when the literal misses. **S**

### Phase 3 — Job model

- **RN-20 Job state + migration** (`nestJob.ts`): material, thickness+unit,
  machine, sheet source (standard | stock + buy-extra), parts[] or groups[],
  params, accuracy, time, output unit. Migrate the current persisted state
  (stock rows, part settings) instead of dropping it. **S**
- **RN-21 Material / thickness / machine tables** as data (`catalog.ts`):
  default sheets per material, gauge lists, machine defaults (laser kerf
  0.012 in, web 1/8, margin 1/4, clamp 3, bed 60×120 …). Shown with an
  "estimate — set your machine's values" tag; user edits persist and win.
  Custom sheet sizes add/remove per material. **S**
- **RN-22 Clamp strip + bed-size warning** (laser only; strip along one long
  edge, drawn hatched on the sheet). **S**
- **RN-23 Length input parser** — fractions (`1 3/16`), ft-in, unit suffixes;
  reuse the command line's parser if it covers fractions, else extend it. **S**

### Phase 4 — Panel (rewrite of `PANEL_HTML`)

- **RN-30 Manual mode:** Job card (material, sheet, thickness picker,
  machine), collapsible Cutting parameters, Parts table (thumb, size, holes,
  warnings, qty, rotation, unit), Add selection / Add files, Calculate
  (disabled until required fields are filled — orange/green field marking),
  Stop, Clear. **M**
- **RN-31 Groups mode:** BOM box (paste / CSV / folder), groups by material +
  thickness each with its own sheet + rotation, item rows red when the file is
  missing, calculation blocked while any are missing; groups nested one after
  another with "Group i of n" progress. **M**
- **RN-32 Results in the panel:** KPI row, stock-usage table, unplaced error,
  per-sheet cards with identical sheets collapsed (signature = size + sorted
  placements), per-sheet DXF button. **S**

### Phase 5 — Output

- **RN-40 Canvas result (= NF-07):** new tab, sheets side by side, existing
  four layers, identical sheets drawn once with "×N". **S**
- **RN-41 DXF:** CUT_OUTER / CUT_INNER (+ optional SHEET) layer names as the
  default preset — the reference's layout is what the shop's CAM expects;
  origin lower-left; original arcs/bulges, not the flattened polygon. One sheet
  or all as **ZIP** (store-only writer, CRC32; tested). **S**
- **RN-42 Report:** extend `nestReport.ts` with KPIs, stock usage, groups;
  "Save job" writes a `.sketchor-nest` JSON (or embeds it in the HTML report)
  that "Open job" restores. **S**
- **RN-43 G-code + metrics adapters:** feed raster placements into the
  existing `toolpath.ts` / `computeJobMetrics`; cut length + pierces now
  match the panel KPIs. **S**

### Phase 6 — Extras

- **RN-50 CNC router checks:** inscribed-circle Ø of every hole vs bit Ø,
  count of unreachable inside corners (> 40° turn), shown per part. **S**
- **RN-51 Screenshot OCR** for BOM lists. tesseract.js + eng data (~10 MB)
  bundled and lazy-loaded (panel CSP forbids the CDN). Optional; see Q3. **M**
- **RN-52 Panel i18n** — string table keyed like the reference
  (en, uk, pl, es, fr, ru). See Q4. **M**

### Phase 9 — Cleanup

- **RN-90 Tidy, don't delete:** remove only what neither engine uses any more
  (the old bbox `nest.ts`/`layout.ts` path if the panel no longer reaches it,
  NFP-only panel code replaced by RN-30); move NFP files under
  `src/trueShape/` next to `src/raster/`; update `sheet-metal-nesting-plan.md`
  and cad-fidelity group 14 checkboxes. **S**

### RN-05 benchmark results (2026-10-22, dev PC, spacing 3 mm, margin 5 mm, raster accuracy "normal" = 1.25 mm cell)

Reproduce: `SKETCHOR_NEST_BENCH=1 npx vitest run packages/plugin-nest/src/raster/rasterBench`.
"NFP quick" = single pass, "NFP normal" = 3 s search; "raster 1-pass" = no budget, "raster 3 s" = 3 s restarts.
Utilisation = net part area / area of sheets used (same stock size for both engines; NFP also shrinks its last sheet).

| Job | NFP quick | NFP normal (3 s) | Raster 1-pass | Raster 3 s |
|---|---|---|---|---|
| 60 rects 100x60, 600x400 | 2 sh, 75.0 %, 19 ms | 2 sh, 3.0 s | 2 sh, 75.0 %, 5 ms | 2 sh, 75.0 % |
| 14 large L 400/150, 1500x1000 | 2 sh, 45.5 %, 2 ms | 2 sh | 2 sh, 45.5 %, 9 ms | 2 sh |
| mixed rect+L+disc (24/30/42), 2000x1000 | 1 sh, 67.7 %, 0.9 s | 1 sh, 3.1 s | 1 sh, 67.7 %, 36 ms | 1 sh |
| 6 rings with hole + 36 plugs, 1500x1000 | 1 sh, 33.9 %, 247 ms | 1 sh | 1 sh, 33.9 %, 9 ms | 1 sh |
| 150 tags 60x25, 400x300 | 3 sh, 62.5 %, 154 ms | 3 sh | 3 sh, 62.5 %, 2 ms | 3 sh |
| 600 identical 80x40, 1500x1000 (NFP cap) | 2 sh, 64.0 %, 12.5 s | 2 sh, 12.5 s | 2 sh, 64.0 %, 8 ms | 2 sh |

Reading (after the candidate fix below): NFP and raster now reach the same sheet count and
utilisation on every job here, so density no longer separates them; raster is still
100-1000x faster (the 600-instance case is ~12 s for NFP, 5-8 ms for raster). NFP's remaining
strengths: exact clearance (no up-to-one-cell extra gap), explicit `allowInHoles` control,
mirroring. Suggested panel hint: "Raster: default - fast, handles any quantity. True shape:
pick for few large parts with tight kerf, or when you need exact clearance or mirroring."

**NFP rectangle gap was a bug, not inherent (found after RN-05).** Before the fix NFP quick
used 4/3/2/1/5/3 sheets (rows in order above) vs 2/2/1/1/3/2 for raster. Cause: `trueNest.ts`
only tried NFP *vertices* (plus the 4 sheet corners) as candidate positions. The "next to the
neighbour, flush with the bottom margin" spot lies mid-edge on the NFP, not on a vertex, so
each row after the first was pushed up to the next vertex (17 of 30 rects per sheet). Fix: also
add the points where each NFP edge crosses the four lines bounding the feasible reference
rectangle (`boundaryCrossings`). Regression test: `trueNestRects.test.ts`.

## 5. Order of work

RN-01 → RN-02 → RN-03 → RN-04 → RN-05 → RN-06 → RN-10 → RN-20/21 → RN-30 →
RN-40/41/43 → RN-11 → RN-12/13/14 → RN-31/32 → RN-42 → RN-22/23 → RN-50 →
RN-90 → RN-51/52.

Phases 1 and 2 (RN-10, RN-13, RN-14) are pure functions with no UI — they can
run in parallel worktrees. The panel (RN-30/31) is one file and should be one
writer.

## 6. Risks

- **Raster clearance is conservative** (up to one cell extra gap). Precise
  accuracy + `minDim/12` cell cap keep it small; the footnote states it.
- **Memory on huge sheets** — cell grows until ≤ 9 M cells; masks are cached
  per (part, angle) and 32 shifts each: 1° rotation × many parts can reach
  hundreds of MB. Build masks lazily (reference already does) and cap total
  mask bytes, falling back to a coarser cell.
- **Worker responsiveness** — RN-03 is required, not optional.
- **Automatic hole filling in raster** might put parts in holes the shop
  doesn't want used. True shape keeps N-12's explicit `allowInHoles`; add a
  raster "don't nest inside" flag if it comes up.
- **Two engines drift apart** — every result/output test runs against both
  (parameterised over `engine.id`), so a feature can't land for one only.

## 7. Open questions

1. ~~Delete the NFP engine?~~ **Decided 2026-10-22: keep it as "True shape".**
2. Bar cutting calculator — separate Sketchor plugin later, or out of scope?
3. Screenshot OCR — worth ~10 MB in the installer, or paste/CSV only?
4. Panel languages — English only for now (strings in a table), or all six
   from the start?
5. DXF layer names — switch defaults to CUT_OUTER / CUT_INNER, or keep
   `Nest Parts` / `Nest Holes` and offer a preset?

## 8. Progress log

One row per landed item, newest last. Agents append in the same commit as the item.

| Item | Commit | Notes |
|---|---|---|
| RN-01 | this commit | `raster/engine.ts`: faithful port as one generator (`nestSteps`) + `nestRasterSync`/`nestRaster` drivers; added `maxIterations` test hook; credit to O. Borenko in header |
| RN-10 | this commit | partExtraction: duplicate removal, helper filter (`ExtractNote`), `closeTolerance` vs `joinTolerance` with gap-closed note, `singlePart` multi-outer note, per-part `cutLength`/`holeCount`/`pierceCount`. Helper filter on by default (`keepHelpers` opts out). Ported from the Sheet Nesting Calculator by Oleksandr Borenko. |
| RN-02 | this commit | `raster/engineGolden.test.ts`: 9 synthetic jobs; golden vs reference via `SKETCHOR_NEST_REFERENCE` (fake per-call clock makes budgeted runs reproducible) - all 9 identical placements/iterations; always-on invariants (clearance >= spacing, margin/clamp, counts, hole fill, purchase order) |
| RN-03 | this commit | cooperative budget: `nestRaster(input,{onBest,onTick,isCancelled,sliceMs})` awaits a macrotask every ~50 ms; cancel resolves with best-so-far; `nestRasterSync` kept. Plugin `nest-progress` wiring is for the panel wave. |
| RN-13 | this commit | `bom.ts`: parseSheetText, splitCsvLine, csvDelim, cleanNum, classifyMat, thickFrom, parseBom, normName + `sumRepeatedRows`; missing qty stays null. Ported from the Sheet Nesting Calculator by Oleksandr Borenko. |
| RN-12 | this commit | `ui.pickFolder()` + `ui.readPickedFile(relPath, as?)`, host API 0.9.0. Both web and desktop use `showDirectoryPicker` (WebView2), like `ui.saveFile`; no Rust command needed. Listing recursive, capped (20k files, depth 16, `truncated` flag); relPath validated against escapes. Named `ui.*` not `fs.*` so no filesystem permission. |
| RN-14 | this commit | `partLookup.ts`: lookupFile/resolveItem/ocrDigits over a `{relPath}[]`; exact > N-pieces (need=ceil) > prefix+separator, never closest; OCR repair only on a literal miss. Ported from the Sheet Nesting Calculator by Oleksandr Borenko. |
| RN-23 | this commit | `units.ts`: parseLen/parseNum (fractions, ft-in, suffixes) + formatLen (in, indec, ftin, mm, cm, m); inches internally. Self-contained: the web command-line `parseLength` has no fractions, returns mm and is in apps/web. Ported from the Sheet Nesting Calculator by Oleksandr Borenko. |
| RN-04 | this commit | `raster/rasterNest.ts`: `nestRasterMm`/`nestRasterMmAsync` (mm in/out, `TrueNestPlacement[]`, translation = rotated-bbox-min like `placementTransform`), `chooseCell` + accuracy presets 2.5/1.25/0.6 mm, `insideOfPlacementIndex` post-pass (all outline vertices inside the innermost hole), `purchased[]` + effective `stock` (purchase size appended, qty null) so metrics index it safely. Mirror ignored with a note. |
| RN-21 | this commit | `catalog.ts`: materials, default sheets, gauge/thickness lists, machine defaults, rotation codes (`rotationAngles`, `defaultRotationFor`), accuracy cells. Inches with `unit: "in"`, `estimate: true` on every table; defaults return fresh copies. Ported from the Sheet Nesting Calculator by Oleksandr Borenko. |
| RN-50 | this commit | `cnc.ts`: inscribedR, cncInfo/cncInfoForPart (hole diameters, unreachable inside corners >40 deg turn), cncWarnings(info, bit) as structured data (UI formats). Ported from the Sheet Nesting Calculator by Oleksandr Borenko. |
| RN-41 | this commit | `zip.ts` (store-only ZIP + `readZip` for the round-trip test, CRC32, UTF-8 flag only for non-ASCII names) and `dxfPreset.ts` (CAM preset: CUT_OUTER/CUT_INNER, optional SHEET, no labels, sheet-local lower-left origin, materialized arcs/bulges kept). **CAM is the default** (plan Q5 recommendation); `msg.preset:"nest"` keeps the old canvas-layer export. Panel unchanged: the existing "All sheets" option now downloads a ZIP of one DXF per sheet; `preset`/`includeSheet` are accepted on the `export-dxf` message for the later panel wave. Ported from the Sheet Nesting Calculator by Oleksandr Borenko. |
| RN-05 | this commit | `raster/rasterBench.test.ts` (env `SKETCHOR_NEST_BENCH=1` prints table; always-on tiny sanity). Results in "RN-05 benchmark results" above. |
| RN-20 | this commit | `nestJob.ts`: `NestJob` (engine, material, thickness, machine, params, sheet source standard/stock+buyExtra, parts, groups, accuracy, time, output unit, true-shape options), tolerant `parseNestJob`, `jobFromLegacyState` (migrates stock rows + part settings; keeps true-shape engine, kerf/spacing -> kerf/web in mm), `jobParamsMm`/`jobSheets`/`jobParts` to feed engines. nestPlugin.ts NOT touched yet (PersistedState -> job wiring belongs to the panel wave). |
| RN-40 | this commit | `sheetGroups.ts`: `groupIdenticalSheets` (size + sorted placements rounded to 1e-3, mirrors `sigOf`/`groupSheets`), `describeGroup`, `buildSideBySideLayout` (groups left to right on the four existing layers, "Sheets 3-7 x5" in the title). Host API 0.10.0: additive `app.openDocumentTab(name, commands?)` (needs `write-document`; new tab, one undo step, fit view). The nest plugin now draws its result there instead of stacking sheets in the source drawing; `clearPreviousLayout` is still used by "Clear". Ported from the Sheet Nesting Calculator by Oleksandr Borenko. |
| RN-06 | this commit | `nestEngine.ts`: `NestEngine {id, label, supports(req)->Unsupported[], run(req,hooks)}` for `raster` and `true-shape` over `NestRequest {job: NestJob, parts}`; both return `RasterNestResult` (superset of `TrueNestResult`: effective `stock`, `purchased[]`, notes). True shape gains stock qty + purchase size (appended qty-null row) and clamp (short side reduced, placements shifted back). 600-instance cap reported by `supports` (`quantity`), not as a failure. NFP engine untouched. Tests run every case against both ids. |
| True shape fix | this commit | NFP candidates now include NFP-edge x sheet-boundary crossings; 60 rects 4 -> 2 sheets, bench table updated. |
| RN-06/20 wiring | this commit | New plugin `sheetNestingPlugin.ts` (id `com.sketchor.sheet-nesting`, command `sheet-nesting.open`, toolbar button, rebindable `app.sheetNesting`): state is a `NestJob` (fresh storage; `jobFromLegacyState` not used), Nest runs `engineFor(job.engine)` with `nest-progress` streaming and a working Stop, result opens in a canvas tab (RN-40), G-code + DXF/ZIP kept. `sheetNesting.ts` holds the pure helpers (readiness, `combineResults`, KPIs, stock usage, job file). |
| RN-43 | this commit | `computeJobMetrics` takes `opts.cut` (partExtraction cut length + pierces per part), so panel KPIs and report agree. |
| RN-30/11/32/22 | this commit | Panel: job card (material, sheet per material incl. custom add/remove, stock on hand + buy extra, thickness + gauge picker, machine), engine selector with unsupported options greyed + reason, collapsible cutting parameters (fraction input), parts table (thumb, size, holes, notes, CNC router checks, qty, rotation, per-file unit), Add selection / Add files (DXF, DWG; SVG not readable in the plugin worker - no DOMParser), Calculate/Stop/Clear with orange/green fields; results: KPI row, stock usage, unplaced names, identical sheets collapsed, per-sheet DXF, ZIP, G-code; clamp strip hatched on the canvas + bed-size warning. |
| RN-31 | this commit | Groups mode in the Sheet Nesting plugin: BOM textarea / Load CSV / Choose folder (`ui.pickFolder`), Groups from the list (`parseSheetText` + `groupsFromRows` by material + thickness), per-group material / thickness / sheet / rotation, item rows red when the file is missing or unusable (`resolveItem`), Calculate blocked until all resolve, groups nested one after another (`nest-progress` shows Group i of n) and merged with `combineResults`. DXF only in groups mode. |
| RN-42 | this commit | Report: KPIs, stock usage, group names and the Oleksandr Borenko credit in the HTML and PDF (`LastNest.summary` / `footer`, optional - the old panel's report is unchanged). Save job / Open job: `.sketchor-nest` JSON via `ui.saveFile` / a file input in the panel, carrying the job, added drawing files and custom sheets (`serializeJobFile` / `parseJobFile`). Done earlier in the wiring commit: RN-32 results block and RN-22 clamp hatching; see the RN-30/11/32/22 row. |
| RN-fix-purchase | this commit | Standard-sheet mode no longer reports "To purchase"/Buy: `stockUsage` counts purchases only for stock source, `resultKpis` gains `showPurchase`; panel and report show "Sheets used" and drop the Buy column/KPI in standard mode. |
