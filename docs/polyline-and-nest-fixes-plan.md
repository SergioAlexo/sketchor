# Polylines + Sheet Metal Nest fixes — plan

Status: Phase 1 shipped (2026-09-25, commit `1641b69`). Phase 3 (2026-11-04): NF-05 done (true-shape engine), NF-06 done (Sheet Nesting "Add files"), NF-07 done (result in a new tab, RN-40), NF-08 partial (job name, notes, autosave folder; report still built from the nest result rather than the canvas layers). Item IDs are stable — reference them in commits.
Decisions from the user: nest result opens in a **new tab** (NF-07); adding a
whole file makes **one part per file** (NF-06).
`P-xx` = polyline fidelity, `NF-xx` = nesting fixes. Follows on from
`sheet-metal-nesting-plan.md` (N-xx) — this is a bug-and-usability pass on
top of it, not a new engine.

## What the user reported

1. Polylines don't look like real polylines: Sketchor shows **many points**
   where another CAD program opening the same file shows **far fewer**.
2. Nesting: can't add a **whole file** as a part.
3. Nesting: selecting some lines, adding them, then adding another selection
   **deletes the first one**.
4. Nesting: the nest **failed**, and so did Print report.
5. Nesting should put the result **on the workspace** and **print a PDF**,
   the way the Truck Load Planner does.

## Root causes found in the code

### Polylines (1)

Every curve that isn't a line, circle, arc or bulged polyline is
**tessellated on import and the original curve is thrown away**:

| Source | Where | What it becomes |
|---|---|---|
| DXF `SPLINE` | `packages/core/src/dxf.ts` `splinePoints()` | polyline of `min(200, max(16, 12 × controlPoints))` points |
| DXF `ELLIPSE` | `dxf.ts` `ellipseToLines()` | polyline of up to 128 points |
| SVG `C/S/Q/T` curves | `svg.ts` path parser | straight segments (curve lost entirely, with a warning) |

So a spline another program draws from 6 control points arrives as a
~72-point polyline. It then:

- shows a **grip on every vertex** when selected (`grips.ts` → `polyline`
  returns one grip per point), which is the "so many points" the user sees;
- **exports** as a 72-vertex `LWPOLYLINE` (`dxfExport.ts`), so the file
  gets heavier every round-trip and other programs now also see the dots;
- feeds 72+ vertices per curve into nesting's NFP maths (see NF-05).

Also lossy today: the sketch-code view drops polyline bulges (pinned by a
test as intended), and the native thumbnailer (`native/dxf-parse`) flattens
curves on its own — both need checking once curves are real.

### Nest parts disappearing (3) — confirmed bug

The panel (`nestPlugin.ts` `PANEL_HTML`) keeps its **own copy** of the whole
persisted state from `init`, including `workingParts` (empty at that
point). Every edit on the Sheets or Settings tab calls `persist()`, which
posts `{type:"persist", state}` — and the plugin does
`state = asState(msg.state)`, **replacing its `workingParts` with the
panel's stale copy**. So: add parts → change spacing, kerf, a sheet size,
anything → the parts list is wiped on the next refresh.

### Nest "failed" + no report (4)

Most likely a knock-on of the bug above: with `workingParts` wiped, Nest
answers "Add one or more parts first.", no `lastNest` is stored, and Print
answers "Nothing to print — nest some parts first." Two other ways to fail
that need handling regardless:

- DXF lines that *almost* meet (gap larger than `joinEntities`' tolerance)
  never close, so `extractParts` finds no part → "Select one or more closed
  shapes first." with no hint which gap is open.
- Dense tessellated curves (above) multiply the NFP work per rotation; on
  "Any" rotation a spline-heavy part can make a search time out or throw,
  and the thrown message is shown raw.

## Plan

### Phase 1 — Nest bugs (ship first, small) — **DONE, commit `1641b69`**

- **NF-01 Stop the panel wiping parts. DONE.** Root cause confirmed: the
  panel's `persist` message carried its own stale copy of `workingParts`
  (set once at init, before any part existed, never updated after). The
  plugin's `persist` handler now keeps its own live `workingParts` and only
  takes stock/spacing/settings from the panel's message.
- **NF-02 Adding is always additive. DONE.** Was already non-destructive in
  effect (matches by `stableKey`, updates in place or appends); now also
  reports "N added, M refreshed — T part(s) in the job" so it's visible.
  *(Not done this pass: a canvas highlight for parts already in the job —
  small follow-up, not a bug.)*
- **NF-03 Open-contour help. DONE (partial), commit `c80dfcf`.** Shipped:
  `extractPartsWithDiagnostics()` (`packages/plugin-nest/src/partExtraction.ts`)
  reports every open chain (gap size + location, including lone
  unconnected pieces); "Add selection" names what's wrong instead of a
  flat "select closed shapes", and still adds whatever *did* close; the
  live selection hint shows an open count before Add is even clicked; a
  new **Join tolerance** setting (Settings tab, 0–0.5mm, blank = exact)
  actually closes small real gaps, threaded through `resolvePart` so a
  part that needed it keeps resolving later. **Not done**: marking the
  open ends on the *canvas* (violet markers, like the crossings detector)
  — there's no host capability for a plugin to draw an ephemeral overlay
  today (`PluginHostApi` has no `ui.highlight`/selection-set method; the
  crossings markers are core-app state, not something a sandboxed plugin
  can reach). That needs a small additive host API bump
  (`ui.highlight(points)` + host-side render wiring) — worth doing as its
  own follow-up rather than folding into this pass.
- **NF-04 Never fail silently. DONE (first pass).** Nest now: names parts
  that no longer resolve on the drawing and prunes them instead of
  blocking Nest forever; flags a part bigger than every stock sheet
  (accounting rotation mode and edge margin) before running the search
  instead of a silent "0 placed"; prefixes a thrown engine error with
  "Nesting failed:" instead of showing it bare. Not yet done: per-part
  problem markers on the part's own row (still only a summary message),
  and the instance-cap / search-timeout-specific wording.

### Phase 2 — Real polylines (P-xx)

- **P-01 `spline` entity type.** Keep the curve as data —
  `{controlPoints, knots, weights?, degree, fitPoints?, closed}` — and
  tessellate **only for drawing/hit-testing**, adaptively by screen
  tolerance, so it's smooth at any zoom. Follow CLAUDE.md's "new entity
  type" checklist (transforms, sketch code, DXF + SVG round-trips, the five
  if/else chains noted in v0.6.0, renderer, snapping, box select, grips).
- **P-02 Grips show the real handles. DONE as a side effect of P-03.**
  `grips.ts`'s polyline case already puts one grip per real vertex — the
  clutter was always the point *count*, not the grip logic. Running
  Simplify now gives that fewer-points result directly; no separate work
  needed. Still true for later: once P-01 lands, a spline needs its own
  control/fit-point grips (that part of P-02 is still open).
- **P-03 "Simplify polyline" + fit arcs. DONE, commit `564adb8`.**
  `packages/core/src/simplify.ts`: Ramer–Douglas–Peucker first, then a
  pass that fits maximal runs of the survivors onto a common circle
  (closed-form least-squares) and replaces them with one bulge-arc
  segment. Two false positives found and fixed while building it (both
  pinned by regression tests): concyclic-but-sparse polygon corners (a
  square's 4 corners fit a circle exactly, but its straight edges don't
  trace one — guarded by a chord/radius and total-sweep plausibility
  check) and a run wrapping back over points an earlier run already
  claimed (corrupted that segment's circle fit outright). Wired up as
  **Shift+P** / command-line `simplify`, next to Join/Explode. Fixed
  0.1mm tolerance for now, no settings UI. **Not done this pass**: the
  import-time option ("Simplify dense polylines" during DXF import) —
  the command exists and can be run right after import instead, but
  isn't yet offered inline in the import report the way the plan
  describes.
- **P-03b DONE (2026-11-04).** Tolerance is now a setting (`simplifySettings.ts`: default 0.1 mm, `simplify 0.5` on the command line sets it, remembered per viewer) and the import banner offers Simplify with an editable tolerance plus an "always on import" preference (`countSimplifiable` in core counts what would shrink). Both run as ordinary batch commands (one undo step).
- **P-04 DXF export writes what came in.** A spline exports as `SPLINE`,
  not a 72-vertex `LWPOLYLINE`. Round-trip test: import → export → import
  gives the same control points; vertex/entity counts match the source.
- **P-05 Ellipses and SVG curves.** `ELLIPSE` → either a real `ellipse`
  entity or a bulge-arc approximation (4–8 arcs, not 128 points); SVG
  `C/S/Q/T` → spline (cubic Bézier is exactly a degree-3 spline) instead of
  a straight line.
- **P-06 Display audit.** Check the native thumbnailer, the file-browser
  thumbnails, sketch code and print/PDF all show the same curve.
  Acceptance: the user's own file opens with the **same vertex/control-point
  count as the program they compare against**.

### Phase 3 — Whole files + workspace view + PDF (like the Load Planner)

- **NF-05 Nest on simplified geometry.** Parts are flattened from the real
  curves at the nester's chord tolerance, then simplified (P-03's
  Douglas–Peucker) before NFP — fewer vertices, faster and steadier search.
  Output still uses the original entities (N-02 transform-per-instance).
- **NF-06 Add whole files.** "Add files…" button (multi-select DXF / DWG /
  SVG / `.sketchor`), plus "Send to Nest" from the file browser's
  multi-select bar, plus "Add everything on this layer / drawing". Each
  file becomes **one part** named after the file (all closed loops →
  outer + holes, N-01 rules), quantity editable. File parts aren't on the
  canvas, so `WorkingPartEntry` becomes a union:
  `{kind:"doc", sourceIds}` | `{kind:"file", name, entities}` (entities
  stored in plugin storage). Needs a small SDK capability for picking files
  from a plugin (`ui.openFiles`, host API bump, additive).
- **NF-07 Result on the workspace.** After Nest: sheets drawn side by side
  (as now), parts numbered, a summary block on the canvas, and the view
  **zooms to fit the result**. Option to put the nest in a **new tab**
  ("Nest – <job>") so the source drawing stays clean.
- **NF-08 Print / PDF like the Load Planner.** Job name + notes fields,
  the same autosave-folder control (`ui.printFolder` / `ui.pickPrintFolder`),
  and the report rendered **from the Nest layers on the canvas** ("one
  drawing, three renderings", as the planner does), so a manual drag after
  nesting shows up in the PDF too. Cover page + one page per sheet with the
  numbered part table (already built in N-30 — reuse it).

## Order and size

| Order | Items | Size | Why this order |
|---|---|---|---|
| 1 | NF-01, NF-02, NF-04 | S | Confirmed data-loss bug; unblocks Nest + Print today |
| 2 | NF-03 | S | Most likely remaining "failed" cause on real DXFs |
| 3 | P-03, P-02 | M | Fixes existing dense files and grip clutter without a new entity type |
| 4 | P-01, P-04, P-05, P-06 | L | Real splines end to end |
| 5 | NF-05 … NF-08 | M | Whole-file nesting and the Load-Planner-style output |

## Open questions for the user

1. Send one DXF that shows the "too many points" problem, and name the
   program you compare it in — that becomes the P-06 acceptance test.
2. Nest result: in the **same drawing** (current behaviour) or a **new tab**?
3. Whole-file parts: should every closed loop in a file be one part (outer +
   holes), or should a file with several separate shapes become several parts?
