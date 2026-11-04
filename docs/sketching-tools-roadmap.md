# Sketching Tools Roadmap

**Goal:** bring Sketchor's sketching toolset up to the level a user of AutoCAD, LibreCAD or Onshape expects — picking the best version of each tool from those three, and implementing it the way *this* codebase wants it built (pure geometry in `packages/core`, undoable `Command[]` through the bus, tool interaction in `apps/web`).

This document is the gap analysis + build order. Each item has an ID (`T-xx`) so it can be referenced from issues/PRs, a priority, a size estimate, dependencies, which app's behaviour to copy, and implementation notes anchored in the current code.

Status as of 2026-09-11 (`main` @ v0.14.4).

### Progress log

| Date | Items | Notes |
| 2026-11-04 | **T-17** chamfer on curves | Chamfer between lines, arcs and circles (`chamferCurves`, distances measured along the curves from where they meet; circles are not trimmed). Closes the T-17 leftover; ellipse/spline chamfer and constraints are not done. |
| 2026-11-04 | **T-27** vertex grip menu | Hover a polyline vertex grip: Add vertex / Remove vertex / Convert to arc (or line) via `gripMenu.ts`; drag still stretches. No touch equivalent yet; line/arc grips have no menu. |
| 2026-11-04 | **T-08** quick edit | The open item from T-08 is done for line, circle and arc: after the tool commits one, a box beside it shows the length/radius (F2 or click to type, Enter applies). Pure logic in `quickEdit.ts`; Sketch mode additionally leaves a D-02b driving dimension. Polyline/rectangle are not offered. |
| 2026-11-04 | **T-00** done | select, measure, text, mtext, image, straighten and pan moved onto the `tools/` framework (see the fidelity-plan log for the hooks added); `Viewport.tsx` no longer has a tool switch. |
| 2026-11-02 | **T-35** array along a path | `pattern.ts` gains `PathPattern` + `pathPatternStations` / `pathPatternCommands` / `pathPatternCopyCount` (pure, 12 tests): copies of the selection at stations along a line / arc / circle / polyline / ellipse / spline (`pathOf`), either `count` stations over the whole path (open: first-to-last inclusive; closed: divided by the count so none stacks on the start) or one every `spacing` from the start; arc length is exact for lines and arcs (chain approximation for ellipse/spline), `startOffset`, `basePoint` (default the selection's centroid) rides the path, `align` turns each copy by how far the path direction has turned since the first station, `replaceSource` deletes the originals; capped at 10 000 stations. Kept out of the `PatternSpec` union on purpose (the pattern plugin mirrors that union over the public API). Tool `arraypath` (`apps/web/src/tools/arrayPathTool.ts`, alias `arpath`): select, type `8` (count) or `25mm` (spacing) plus `align/noalign` `keep/replace`, click the path; one undo step, copies end up selected. *Not done:* panel UI in the Pattern panel, associative (live) path arrays, 3D / item-count readout, not exercised in the running app. |
| 2026-11-02 | **T-21** parallel snap + apparent intersection | `snapping.ts`: new kind **apparent** (`apparentIntersections`, tested) - where two straight pieces would cross if extended, for pairs that do not really touch (nearly parallel pairs and crossings further than 3 lengths before / 4 after a piece are ignored); tiered feature > midpoint > **apparent** > nearest > extension, so it beats the extension guides it sits on but never a real endpoint / intersection. `Snap.refLine` names the straight piece behind a nearest-point snap. `objectTracking.ts`: `acquireLine` (hovered lines, three deep) + `parallelTrack` (cursor pulled onto the ray from the tool's anchor that runs parallel to an acquired line, either way along it, nearest ray wins; a line the anchor sits on is ignored). In `resolvePick` parallel sits with object tracking (after ortho/polar, before point alignments, same TRACK toggle, only while no feature snap is touched) and draws the dashed guide from the anchor. Both have SNAP-popover switches (`apparent`, `parallel`, persisted) and marker glyphs (square with a cross, two slashes). Lines only (arcs/circles do not take part in apparent intersection). *Unverified:* the canvas feel in the running app (marker drawing, guide, hover acquisition) - pure parts are tested. |
| 2026-11-02 | **T-29** zoom selected | Command-line `zs` / `zoomselected` (app command `zoomSelected`, reports "nothing is selected"); `F` and `ZE` with a selection already framed it. T-29 is now complete. |
| 2026-11-02 | **T-16** fence trim | `packages/core/src/trimFence.ts` (tested): `trimByFence` applies `trimAt` at every crossing of the stroke with an entity (in stroke order, each against the original drawing as cutters). Framework gets an optional `Tool.fence(ctx, path)`: a press-drag with such a tool draws the fence and hands it over on release (a click is still a pick; Shift still extends). Trim tool implements it. |
| 2026-11-02 | **T-15** through-point + round gap | `offsetThroughPoint` and an `OffsetGap` ("extend"/"round", AutoCAD OFFSETGAPTYPE) argument on `offsetEntity`/`offsetPath`: round keeps raw legs at outer corners and joins them with an arc about the original vertex (tested on a rectangle). Offset tool: Tab toggles distance/through, Shift+Tab toggles round/extend corners. |
| 2026-11-02 | **T-17** (arcs/circles) | Core was already `filletCurves` (C-08, nearest-to-picks solution). New: `filletCurveConstraints` (associative.ts) — T-46 coincident + tangent (+ radius) for every line/arc/circle pair (point-on-curve on a circle), wired into the Fillet tool; solver test confirms they are satisfied. Chamfer stays lines-only. |
|---|---|---|
| 2026-09-22 | **T-41** constraint tools | Five new constraint types — **concentric, midpoint, symmetric, collinear, point-on-curve** — with solver residuals and end-to-end solve tests; `PointRef` grew a `vertex` + `index` form so a polyline's middle vertices and an arc's ends can be named. `constraintBuilder.ts` (pure, tested) is selection-driven, Onshape style: `constraintOptions(selection)` decides which buttons light up and what a disabled one should say, `buildConstraints` makes them, `nearestPair` picks the ends a user meant. `constraintDisplay.ts` (pure, tested) places the glyphs. UI: **Constraints panel** (`Ctrl+2`) with apply buttons + the sketch's constraint list (conflicts red, redundant italic, ✕ to remove, click a row to select its geometry), canvas **glyphs** with a visibility switch — click one to select what it holds, double-click to remove it. *Open:* T-42 driving dimensions (today distance/radius/angle lock the current value), T-43 inference, T-44 DOF colouring. |
| 2026-09-22 | **T-40** constraint solver | **Built rather than bound:** planegcs would have meant a 1.5 MB LGPL wasm, async init, its own primitive model and tests that can't run in this repo's node vitest — so `packages/core/src/solver/` is a Levenberg–Marquardt least-squares solver in pure TS, behind `solveSketch` so the engine stays replaceable. `num.ts` sparse forward-mode AD (residuals read like the constraint; the Jacobian falls out right, which is what makes a constraint on an arc's *endpoint* work). `model.ts` parameter mapping, `fix` freezes rather than adds rows. `residuals.ts` all 11 constraint types, normalised to mm/radians. `solve.ts` LM with **uniform** damping (per-entry damping returns huge null-space steps), DoF = free params − Jacobian rank, conflict + redundancy naming. Wired as **bus middleware**: solve after each command, moves join the same undo entry; redo re-solves, undo re-diagnoses. **Drag-solve** on grips via `solveSilently` + `gripPointRef`, two passes (pull, then project) so hard constraints stay hard. Status-bar readout: `4 DOF` / `fully constrained` / `⚠ 2 conflicting`. *Open:* T-41 tools to create constraints (today they come from the bus), T-42 driving dimensions, T-43 inference, T-44 DOF colouring. |
| 2026-09-22 | **T-08** command line + relative zero | `apps/web/src/tools/commandLine.ts` (tested): AutoCAD alias table (`l`, `pl`, `rec`, `co`, `mi`, `o`, `tr`, `f`, `cha`…), app commands (`u`, `e`, `j`, `x`, `fit`, `rz`…), coordinates passed through to the active tool, prefix completion and shell-style history. `CommandBar.tsx` docks it at the foot of the drawing area (`Ctrl+9` / **CMD**), with an echo log, Tab completion, ↑/↓ recall and Enter-repeats-last. A tool argument is fed to the tool's `typed()`, so `o 5` starts the offset tool with the distance already set. **Relative zero** (LibreCAD): the last point placed, drawn as a crossed circle; `@dx,dy` falls back to it when the tool has no anchor, so the *first* point of an entity can be relative. *Open from T-08:* the post-commit quick-edit box (becomes a driving dimension under T-42). |
| 2026-09-22 | **T-20** object snap tracking | `apps/web/src/viewport/objectTracking.ts` (tested): hovering a feature point acquires it (three deep, newest first); `trackAlignment` projects the cursor onto an acquired point's ortho/polar alignment, or onto the **crossing** of two of them when both are in the aperture — "directly above this corner and level with that one". Dashed guides back to each acquired point, a plus marker on each, **TRACK** toggle in the status bar (`F11`, on by default). Pipeline order in `resolvePick`: feature snap > ortho/polar from the anchor > object tracking > raw. *Open:* parallel snap and apparent intersection (T-21), auto-constraints from inference (T-43, needs the solver). |
| 2026-09-22 | **T-29** (lasso, fence, select similar, Quick Select, layer lock) | `packages/core/src/polygonSelect.ts` (tested): `entityInPolygon` / `entitiesCrossedByFence` over sampled entity outlines (curves included), plus `simplifyPath` so a freehand drag stays a few dozen edges. `selectFilter.ts` (tested): `matchesFilter` / `selectSimilar` / `describeFilter`. **Alt-drag** lassos (left→right window, right→left crossing), **Ctrl+Alt-drag** fences, **clicking the same spot again** cycles through overlapping entities with a list popover, **Ctrl+Shift+A** selects similar, and the status bar's **SELECT** popover is Quick Select by type / layer / colour / construction with a live match count. **Layer lock** (padlock in the Layers panel): visible but dimmed and unselectable — every selection path now goes through `selectableEntities()`. *Open from T-29:* trim-by-fence (T-16), zoom selected. |
| 2026-09-22 | **3D selection + measure** (outside the T-xx list) | `apps/web/src/model3d/topology.ts` (tested) recovers the B-rep from the tessellation — faces from `brep_faces`, edges from triangle edges shared by two different faces (chained, then fitted to a line/circle/arc), vertices from chain ends — plus per-face area/perimeter/normal/planarity and per-part area/volume. `picking.ts` (tested) does the screen-space search (vertex > edge > face, depth-capped so a click can't reach through a solid) against a projector the viewer supplies; `measure.ts` (tested) turns a selection into the bottom-right readout — one pick gives length / diameter / area / volume, two give distance and angle. `viewerStore.ts` shares selection/hover/hidden between the canvas and the new **Structure** panel, which takes the Layers slot in a model tab. `LAYOUT_VERSION` bumped to 3. |
| 2026-09-21 | **T-25** polyline edit | In the properties panel: per-vertex insert (midpoint of the next leg, arc legs split into two half-sweep arcs), remove (the two legs merge straight), straight ↔ arc toggle, and Reverse (bulges re-indexed and negated). Together with vertex grips this covers PEDIT's everyday use. |
| 2026-09-21 | **T-18** stretch, **T-07** construction line | `packages/core/src/stretch.ts` (tested): every defining point inside the crossing box moves, the rest stay; circles/text/images move with their insertion point; an arc with one end inside keeps its radius and gets a new center. **Stretch** tool (`Shift+E`): two box corners, base, destination (typed `@dx,dy` works). `LineEntity.infinite` (T-07): the line tool's Tab mode draws an infinite dashed construction line — clipped to the viewport, snaps and trims like the whole line, skipped by DXF/SVG export, flag kept through sketch-code edits. |
| 2026-09-21 | **T-27** grips, **T-28** properties, **T-24** align, **T-23** lengthen, **T-26** match | `packages/core/src/grips.ts` (tested): `gripsOf` / `applyGrip` — end and vertex grips stretch, mid/center/insert grips move, quadrant sets radius, arc end changes its angle, image corners resize; the select tool drags them with snapping (the entity itself excluded) and a dashed preview, one `update-entity`. **Properties panel** (`properties/PropertiesPanel.tsx`, Ctrl+1): layer / colour / construction for any selection; for one entity every geometric field editable in the display unit plus read-only length / area / circumference / sweep; polyline vertices editable. `alignLengthen.ts` (tested): **Align** tool (two source → two target points, Ctrl scales), **Lengthen** tool (`+5`, `-5`, `40`, `150%`), **Match** tool (layer / colour / construction). |
| 2026-09-21 | **T-22** join/explode, **T-19** divide, **T-29** (part) | `packages/core/src/joinExplode.ts` (tested): `joinEntities` chains lines/arcs/open polylines end-to-end (either orientation) into polylines with bulged legs, closing when the ends meet; `explodePolyline` back to lines/arcs; `pointsAlong` for divide/measure. `J` joins the selection, `Ctrl+E` explodes it. **Divide** tool: type a count or a spacing, click the entity → point entities. `Ctrl+A` select all, `Ctrl+I` invert, `Z` zoom window (two corners), `Shift+Z` zoom previous (20-deep history). *Open from T-29:* select similar / by layer, lasso, fence, selection cycling, layer lock. |
| 2026-09-21 | **T-02**, **T-04**, **T-05**, **T-06** | `packages/core/src/shapes.ts` (tested): `circleFrom2Points/3Points`, `circleTangentToTwo` (TTR via the intersection lib's offset loci, side by the picks), `rectFromCenter`, `rectFrom3Points`, `regularPolygon` (inscribed/circumscribed) + `regularPolygonByEdge`, `straightSlot`, `arcSlot` (closed polylines with bulged caps). Circle tool: Tab cycles center-radius / center-diameter / 2-point / 3-point / tangent-tangent-radius (typed radius, click two entities). Rectangle tool: Tab cycles corners / center / 3-point. New **Polygon** (type sides, Tab: inscribed / circumscribed / by edge) and **Slot** (straight or arc, width typed or picked) tools. T-07 XLINE still open. |
| 2026-09-21 | **T-11** clipboard, **T-10** nudge | `packages/core/src/clipboard.ts` (tested): the selection serialises as sketch code **plus** a `# sketchor {json}` line that keeps layers/colours/bulges/images/groups; paste reads the JSON when present, else parses plain code (an AI's or an editor's). Fully-contained groups paste as new groups. `Ctrl+C` / `Ctrl+X` / `Ctrl+V` (at the cursor, bottom-left of the copy under it) / `Ctrl+Shift+V` (in place) / `Ctrl+D` (duplicate one grid step away); an in-app copy backs up the system clipboard when reading it is refused. Arrow keys nudge the selection by a grid step, Shift ×10. |
| 2026-09-21 | **T-21** object snaps | `viewport/snapping.ts` now works on the intersection library's curves: intersections between any two curves (line/arc/circle/polyline legs), nearest-point on arcs and circles, **perpendicular** and **tangent** from the tool's anchor, **extension** along a line past its end (dashed guide from that end), **node** for point entities. Per-kind switches persisted (`tools/snapSettings.ts`) behind a **SNAP** popover in the status bar; AutoCAD-style marker glyphs per kind. Tiering: feature (incl. perpendicular/tangent) > midpoint > nearest > extension > grid. *Not done:* parallel snap, apparent intersection, object snap tracking (T-20). |
| 2026-09-21 | **T-16** (trim / extend / split), **T-17** (fillet / chamfer), **T-15** (offset) | Intersection library `packages/core/src/intersect.ts`: every entity as a `Path` of segment/arc curves, `intersectCurves` (seg/seg, seg/arc, arc/arc, with unbounded variants), `cutParams`, `trimAt`, `splitAt`, `extendTo`, `entityFromPath` (lone segment → line, lone arc → arc, full turn → circle, else polyline with bulges). `fillet.ts`: `filletLines` (radius 0 = corner join; the clicked halves stay), `chamferLines`, `filletPolylineCorner` / `filletAllCorners` (bulges in place). `offset.ts`: signed left-offset per curve, neighbours re-joined at their intersection, round join where offset arcs don't reach, inverted legs and swallowed slot walls dropped, collinear seams merged. Tools in `apps/web/src/tools/editTools.ts`: **Trim** (quick trim, everything visible cuts; Shift-click extends), **Split**, **Fillet** (typed radius remembered; polyline corner click; Enter rounds all corners of selected polylines), **Chamfer** (one typed distance), **Offset** (typed distance, entity, side — live preview). Bindings Shift+T / Shift+B / Shift+F / — / Shift+O. *Not done:* fillet between arcs/circles, trim fence-drag, offset "through point", `OFFSETGAPTYPE=1` (round) as an option. |
| 2026-09-21 | **T-10**, **T-11** (tool only), **T-12**, **T-13**, **T-14** | `apps/web/src/tools/modifyTools.ts` on the framework: Move (base → destination or typed `@dx,dy`/distance, Ctrl-click copies), Copy (repeats until Enter/Esc), Rotate (pivot → reference direction → new direction, or a typed angle after the pivot; Ctrl copies), Scale (typed factor, or reference length → new length picked or typed; Ctrl copies), Mirror (two axis points, Shift/F8 for H/V; Ctrl-click deletes the source). With nothing selected, the first click selects. Core: `packages/core/src/mirror.ts` (`mirrored`, tested) — arcs flip sweep, bulges negate, text/images move by position only. Not done from T-11: Ctrl+C/X/V clipboard via sketch code, Ctrl+D duplicate, group-aware copies; from T-10: arrow-key nudge. Copies come back ungrouped. |
| 2026-09-18 | **T-00** (partial), **T-08** (core), **T-09**, **T-01**, **T-03** | Tool framework in `apps/web/src/tools/` (`tool.ts` interface, `index.ts` registry, `drawTools.ts`); line/polyline/rectangle/circle/point migrated, select/measure/text/image/fill/straighten/dim/pan still on the legacy switch in `Viewport.tsx`. Typed input: floating box (digits/`@`/`-`/`.` open it), grammar `100`, `100<45`, `x,y`, `@dx,dy`, unit suffixes and feet-inches (`typedInput.ts`, tested); no docked command line, no post-commit quick-edit, no relative-zero yet. Ortho/polar: F8/F10, Shift = temporary ortho, status-bar toggles, dashed guide + angle (`tracking.ts`, tested). Arc tool: 3-point / center-start-end / tangent, Tab cycles (`packages/core/src/arcs.ts`, tested). Polyline `A`/`T`/`L` arc legs stored as bulges. T-21 not started. |

---

## 0. What exists today (baseline)

Don't rebuild these; extend them.

| Area | Present |
|---|---|
| **Entities** (`packages/core/src/entities.ts`) | `line`, `circle`, `arc`, `point`, `polyline` (per-segment bulge → true arcs, `closed`), `text`, `image`. Per-entity `layer`, `color`, `fill`, `dashed` (= construction). |
| **Draw tools** (`ToolId` in `state/store.ts`, interactions in `viewport/Viewport.tsx`) | Line (chained), Polyline (Enter/dbl-click finish, `C` close, Backspace undo vertex), Rectangle (2 corners), Circle (center + point), Point, Text, Image, Fill/Hatch (solid colour on closed shapes). |
| **Annotate / inspect** | Measure (`M`; point-to-point, Alt = whole entity, Ctrl = reference edge, arc length, area+perimeter, pin up to 5, Ctrl+C copy). Linear dimension tool (`dim`) — built from plain lines + text in a group, **not** a dimension entity, not associative. |
| **Modify** | Drag-move (with feature-anchor snapping), Straighten (rotate about a picked edge), Group/Ungroup (nested registry), Construction toggle (`Shift+C`), Delete, Rectangular + circular **Pattern** (array), Delete-duplicates (overkill), Heal (merge near-coincident endpoints, join collinear, close gaps), line-crossing detector (report only). |
| **Selection** | Click, Shift-add, window (L→R) / crossing (R→L) box, filled-interior hit for closed+filled shapes, drag-together of multi-selection. |
| **Snapping** (`viewport/snapping.ts`) | endpoint, midpoint, center, quadrant, intersection, on-line (nearest), origin, grid — priority tiers. Ctrl (rebindable) disables. |
| **Infrastructure** | Serializable `CommandBus` with undo/redo + batch; layers panel; rebindable keybindings (`keybindings.ts`, action ids like `tool.circle`); command palette; sketch-code DSL (`sketchtext.ts`, `param`/`constraint`/`dim` keywords reserved); `constraints.ts` **data model only** (no solver); `regions.ts` closed-loop finder; `dimension.ts` linear layout; `crossings.ts` line/line intersection scan; DXF/SVG import/export; plugin host; vitest in `packages/core`. |

### What is missing, in one sentence

Sketchor can *draw* the basic primitives but has almost **no modify tools** (no trim/extend/offset/fillet/mirror/rotate/scale/copy), **no precision input** (no typed lengths/angles/coordinates, no ortho/polar), **no arc tool**, **no grips or properties editing**, and **no solver** behind the constraint model. Those four gaps are the roadmap.

---

## 1. Feature gap matrix

Legend: ✅ have · 🟡 partial · ❌ missing. "Ref" = whose behaviour to copy.

### 1.1 Draw

| Tool | AutoCAD | LibreCAD | Onshape | Sketchor | Ref |
|---|---|---|---|---|---|
| Line (chained) | ✅ | ✅ | ✅ | ✅ | — |
| Line by angle / horizontal / vertical / tangent to circle / perpendicular / bisector | 🟡 (via osnap) | ✅ dedicated tools | 🟡 (inference) | ❌ | Onshape inference + AutoCAD osnap (**T-20**, **T-21**), not LibreCAD's 12 line sub-tools |
| Infinite construction line / ray (XLINE) | ✅ | ❌ | ❌ | ❌ | AutoCAD (**T-07**) |
| Polyline | ✅ | ✅ | 🟡 | ✅ | — |
| Polyline arc segments while drawing | ✅ (`A` in PLINE) | ✅ | n/a | ❌ | AutoCAD (**T-03**) |
| Rectangle: 2-corner | ✅ | ✅ | ✅ | ✅ | — |
| Rectangle: center-point, 3-point (rotated) | ✅ | ✅ | ✅ | ❌ | Onshape (**T-05**) |
| Circle: center-point | ✅ | ✅ | ✅ | ✅ | — |
| Circle: 2-point, 3-point, tan-tan-radius, center-diameter | ✅ | ✅ | 🟡 (3-pt) | ❌ | AutoCAD (**T-02**) |
| **Arc** (3-point, center-start-end, tangent continuation) | ✅ | ✅ | ✅ | ❌ (entity exists, no tool) | Onshape (**T-01**) |
| Ellipse / elliptical arc | ✅ | ✅ | ✅ | ❌ (imports as polyline) | (**T-30**) |
| Spline (fit-point, control-point) | ✅ | ✅ | ✅ | ❌ (imports as polyline) | Onshape (**T-31**) |
| Regular polygon (N sides, inscribed/circumscribed) | ✅ | ✅ | ✅ | ❌ | Onshape (**T-04**) |
| Slot (straight, arc) | ❌ | ❌ | ✅ | ❌ | Onshape (**T-06**) |
| Point | ✅ | ✅ | ✅ | ✅ | — |
| Divide / Measure (points along an entity) | ✅ | ✅ | ❌ | ❌ | AutoCAD (**T-19**) |
| Text | ✅ | ✅ | ✅ | ✅ | — |
| Multi-line text (MTEXT) | ✅ | ✅ | ❌ | ❌ | (**T-33**) |
| Hatch: solid fill | ✅ | ✅ | ❌ | ✅ | — |
| Hatch: line patterns (ANSI31…) / boundary detection | ✅ | ✅ | ❌ | ❌ | AutoCAD (**T-32**) |
| Image | ✅ | ✅ | ✅ | ✅ | — |
| Blocks / symbols (definition + instances) | ✅ | ✅ | n/a | ❌ (INSERT expanded on import) | AutoCAD (**T-34**) |
| Construction geometry | ✅ | ✅ | ✅ | ✅ | — |

### 1.2 Modify

| Tool | AutoCAD | LibreCAD | Onshape | Sketchor | Ref |
|---|---|---|---|---|---|
| Move (base point → target, typed displacement) | ✅ | ✅ | ✅ (Transform) | 🟡 drag only | AutoCAD (**T-10**) |
| Copy / Copy-multiple / Ctrl+C-V / Duplicate | ✅ | ✅ | ✅ | ❌ | AutoCAD (**T-11**) |
| Rotate (base, angle, reference, copy) | ✅ | ✅ | ✅ | 🟡 straighten only | AutoCAD (**T-12**) |
| Scale (base, factor, reference) | ✅ | ✅ | ✅ | ❌ | AutoCAD (**T-13**) |
| Mirror (2-pt axis, keep source) | ✅ | ✅ | ✅ | ❌ | AutoCAD/Onshape (**T-14**) |
| Stretch (move only enclosed endpoints) | ✅ | ✅ | n/a | ❌ | AutoCAD (**T-18**) |
| **Offset** (distance / through point, both sides, polylines w/ arcs) | ✅ | ✅ | ✅ | ❌ | AutoCAD (**T-15**) |
| **Trim / Extend** (click segment to remove; Shift toggles; fence) | ✅ | ✅ | ✅ | ❌ | AutoCAD 2021+ quick-trim (**T-16**) |
| **Fillet / Chamfer** (radius/distance, polyline corners, r=0 corner-join) | ✅ | ✅ | ✅ | ❌ | AutoCAD (**T-17**) |
| Break / Break-at-point / Split | ✅ | 🟡 | ✅ | ❌ | Onshape Split (**T-16**) |
| Join (lines/arcs → polyline) | ✅ | ✅ | n/a | 🟡 heal joins collinear only | AutoCAD JOIN (**T-22**) |
| Explode (polyline → segments, group → entities) | ✅ | ✅ | n/a | ❌ | AutoCAD (**T-22**) |
| Lengthen (delta / total / percent) | ✅ | ✅ | n/a | ❌ | LibreCAD (**T-23**) |
| Align (2 source pts → 2 target pts) | ✅ | ✅ (Move+Rotate) | n/a | 🟡 straighten | AutoCAD ALIGN (**T-24**) |
| Array (rect/polar) | ✅ | ✅ | ✅ | ✅ | — |
| Array along path | ✅ | ❌ | ❌ | ❌ | (**T-35**) |
| Polyline vertex edit (add/remove vertex, seg↔arc, reverse) | ✅ PEDIT | ✅ | 🟡 | ❌ | (**T-25**) |
| Delete duplicates (OVERKILL) | ✅ | ❌ | n/a | ✅ | — |
| Match properties | ✅ | ✅ | n/a | ❌ | (**T-26**) |

### 1.3 Precision, input and selection (cross-cutting)

| Capability | AutoCAD | LibreCAD | Onshape | Sketchor | Ref |
|---|---|---|---|---|---|
| **Typed input while drawing** (length, angle, `x,y`, `@dx,dy`, `@len<ang`) | ✅ DYN + command line | ✅ command line | ✅ inline dimension boxes | ❌ | AutoCAD DYN + Onshape (**T-08**) |
| **Ortho (F8) / Polar tracking (F10)** | ✅ | ✅ (restrict H/V/ortho) | 🟡 Shift | ❌ | AutoCAD (**T-09**) |
| Object snap tracking / alignment guides | ✅ OTRACK | ❌ | ✅ inference lines | ✅ | Onshape (**T-20**) — done 2026-09-22 |
| Osnaps: perpendicular, tangent, extension, parallel, node, apparent-intersection | ✅ | ✅ | ✅ | ❌ | AutoCAD (**T-21**) |
| Osnap on/off per kind + snap-override key | ✅ | ✅ | ❌ | 🟡 all-or-nothing | AutoCAD (**T-21**) |
| Relative zero / temporary origin | ❌ | ✅ | ❌ | ❌ | LibreCAD (**T-08**) |
| **Grips** (drag endpoint / midpoint / center / radius / vertex) | ✅ | ✅ | ✅ | ❌ | AutoCAD (**T-27**) |
| **Properties panel** (numeric edit of coords, length, radius, layer, colour, linetype) | ✅ | ✅ | 🟡 | ❌ | AutoCAD (**T-28**) |
| Selection: Ctrl+A, invert, select-similar, by layer/type, lasso, fence, cycling | ✅ | ✅ | 🟡 | ❌ | AutoCAD (**T-29**) |
| Nudge with arrow keys | ✅ | ❌ | ❌ | ❌ | (**T-29**) |
| Linetype (continuous/dashed/center/hidden) + lineweight per entity/layer | ✅ | ✅ | n/a | 🟡 `dashed` boolean | AutoCAD (**T-36**) |
| Zoom window / zoom selected / zoom previous | ✅ | ✅ | ✅ | 🟡 fit only | (**T-29**) |

### 1.4 Parametric (Onshape's core strength)

| Capability | Onshape | Sketchor | Ref |
|---|---|---|---|
| Constraint solver | ✅ | ❌ (data model only) | planegcs WASM (**T-40**) |
| Constraints: coincident, H, V, parallel, perpendicular, tangent, equal, fix | ✅ | 🟡 in model, no tools | (**T-41**) |
| Constraints: concentric, midpoint, symmetric, collinear, normal | ✅ | ❌ not in model | (**T-41**) |
| Driving dimensions (linear/aligned, angular, radial, diametral) | ✅ | ❌ (dim tool draws lines) | (**T-42**) |
| Inference while drawing → auto-constraints | ✅ | ❌ | (**T-20** + **T-43**) |
| DOF colouring (blue=under, black=fully, red=over) | ✅ | ❌ | (**T-44**) |
| Variables / expressions (`param w = 100`, `dim = w/2`) | ✅ | ❌ (grammar reserved) | (**T-45**) |
| Constraint visibility / delete / conflict diagnosis | ✅ | ❌ | (**T-44**) |
| Sketch mirror with symmetric constraint, associative offset/pattern | ✅ | ❌ | (**T-46**) |

---

## 2. Build order

Four phases, ordered by leverage. Phase 1 is the foundation every later tool sits on — do not skip it, or every modify tool re-implements typed input and its own state machine inside `Viewport.tsx` (already 1,287 lines).

```
Phase 1  Foundation (2–3 weeks)   T-00 tool framework · T-08 typed input · T-09 ortho/polar · T-21 osnaps
Phase 2  Core draw+modify (4–6 wk) T-01 arc · T-02 circles · T-10..T-17 move/copy/rotate/scale/mirror/offset/trim/fillet
Phase 3  Precision editing (3–4 wk) T-27 grips · T-28 properties · T-29 selection · T-18..T-26 · T-04..T-07
Phase 4  Parametric (6–8 wk)       T-40 solver · T-41 constraints · T-42 dims · T-43 inference · T-44 DOF · T-45 params
Later    T-30..T-36 ellipse/spline/hatch patterns/mtext/blocks/path array/linetypes
```

Sizes: **S** ≤ 2 days · **M** ≤ 1 week · **L** 1–3 weeks. Estimates assume one developer familiar with the codebase.

---

## 3. Phase 1 — Foundation

### T-00 · Tool framework refactor — **P0, M** — ✅ 2026-11-04 (framework + draw tools 2026-09-18; legacy tools migrated 2026-11-04)

**Why first:** every tool below is a small state machine (prompt → pick → pick → commit). Today they live as `case "line"` / `case "circle"` branches inside `Viewport.tsx`'s pointer handlers plus an `interaction` union. Twenty more tools that way is unmaintainable.

**Do:**
- `apps/web/src/tools/` with one file per tool implementing
  ```ts
  interface Tool {
    id: ToolId;
    onActivate(ctx): void; onDeactivate(ctx): void;
    onPointerDown/Move/Up(ctx, snappedPoint, rawEvent): void;
    onKey(ctx, e): boolean;               // return true if consumed
    onInput(ctx, value: TypedInput): void; // from T-08
    preview(ctx): PreviewPrimitive[];      // dashed geometry drawn by renderer
    prompt(): string;                      // status-bar text, e.g. "Specify second point or [Undo]"
  }
  ```
- `ctx` exposes `doc`, `bus.execute`, `selection`, `snap()`, `setPrompt()`, and `commit(commands: Command[])` which wraps in a batch → one undo step.
- Migrate the existing line/polyline/rectangle/circle/measure/dim/straighten/fill tools onto it (no behaviour change; that's the regression test). Keep `ToolId`/`tool.*` keybinding action ids stable.
- Renderer gets a generic `previewPrimitives` pass (lines, arcs, circles, points, text) so tools never touch the canvas directly.

**Rules for every new tool** (put in `CLAUDE.md`):
1. Geometry math is a pure function in `packages/core` with a vitest test. The tool only collects picks and calls it.
2. The tool emits `Command[]` through `ctx.commit` — never mutates entities.
3. Every new entity *type* touches the five exhaustive spots listed in the existing CLAUDE.md landmine note (`dxf.ts` ×2, `svg.ts`, `Viewport.tsx` hitTest, `renderer.ts`, `snapping.ts`, `boxSelect.ts`, `sketchtext.ts`, `pattern.ts`).
4. Esc always cancels; Enter/Space repeats the last tool (AutoCAD habit); right-click = Enter while a tool is active.

### T-08 · Dynamic input / command line — **P0, M** — ✅ floating box + grammar 2026-09-18; command line + relative zero 2026-09-22; quick-edit 2026-11-04

**Ref:** AutoCAD DYN (floating boxes next to cursor, Tab cycles length↔angle) + Onshape's "type a number right after placing" + LibreCAD's command line for absolute/relative coordinates.

**Behaviour:**
- While any tool waits for a point, typing digits opens an input box at the cursor. Accepts: `100` (length along current cursor direction), `100<45` (polar), `50,20` (absolute), `@50,20` (relative to last point), `@100<45`. Tab switches between length and angle fields; Enter commits; Esc closes.
- After a shape is committed (Onshape style) a quick-edit box shows the primary size (radius, length) for immediate override — this becomes a driving dimension once T-42 exists.
- Unit-aware: uses the tab's `displayUnit` (`in`, `mm`, …) and accepts suffixes (`4in`, `2'6"`, `1200mm`).
- **Relative-zero** (LibreCAD): a key sets a temporary origin the next `@` input is measured from; shown as a small marker.
- Docked command line (toggleable, bottom): echoes prompts, accepts full commands (`L`, `C`, `OFFSET 5`), keeps history (↑/↓). This is also the natural place for the AI assistant later.

**Where:** `apps/web/src/tools/typedInput.ts` (parser, pure + tests) · `TypedInputBox.tsx` overlay · tools receive `onInput`.

### T-09 · Ortho and polar tracking — **P0, S** — ✅ 2026-09-18

**Ref:** AutoCAD F8/F10.

- Ortho: constrain cursor to 0/90/180/270° from the last point. Polar: snap to angle increments (configurable 15/30/45/90 + custom list) with a dashed tracking ray and an angle readout.
- Shift held = temporary ortho (Onshape/AutoCAD habit). Toggle keys rebindable (`view.ortho`, `view.polar`).
- Implement as a stage in the snapping pipeline: `snap()` returns the raw snap; `applyTracking(last, raw)` projects onto the nearest allowed ray, unless the raw snap was a higher-tier feature snap (endpoint/intersection beats tracking, as in AutoCAD).

### T-21 · Complete object snaps — **P0, M** — ✅ 2026-11-02

Add to `snapping.ts`: **perpendicular** (foot of perpendicular from last point onto line/arc/circle), **tangent** (from last point to circle/arc — two candidates, pick nearest cursor), **extension** (along a line's direction past its endpoint, dashed guide), **parallel** (AutoCAD PAR: hover a line, then a ray of the same direction from last point), **node** (point entities), **apparent intersection** (extended lines). Existing intersection snap should gain line/circle, line/arc, circle/circle, arc/arc, and polyline-segment cases (see `T-16` intersection library — shared).

Snap settings popover: checkbox per kind, persisted in `localStorage` like keybindings; status-bar indicator shows the active snap kind + a marker glyph per kind (square endpoint, triangle midpoint, circle center, ⟂ perpendicular, ⌒ tangent — AutoCAD glyphs are the standard people know).

---

## 4. Phase 2 — Core draw and modify tools

### T-01 · Arc tool — **P0, S** — ✅ 2026-09-18

`ArcEntity` already exists (`center, radius, start, end, ccw`). Tool modes (dropdown on the tool button, or sub-keys): **3-point** (start, end, point-on-arc — Onshape default), **center–start–end**, **tangent arc** (continues from the end of the last drawn line/arc tangentially — Onshape's most-used mode; also auto-triggered when the polyline tool is in arc mode). Core: `arcFrom3Points`, `arcFromCenterStartEnd` in `geometry.ts` + tests. The sketch-code DSL already has an `arc` statement, so no grammar work is needed.

### T-02 · Circle variants — **P1, S** — ✅ 2026-09-21

Modes: center–radius (typed radius via T-08), center–diameter, 2-point (diameter ends), 3-point, **tan-tan-radius** (pick two entities + radius; core: `circleTangentToTwo` — solve the 4 candidate circles and pick the one nearest the two click points). Sub-mode key while the tool is active; persists per tool.

### T-03 · Polyline arc segments — **P1, S** — ✅ 2026-09-18

In the polyline tool, `A` switches to arc mode (tangent-continuation, or 3-point via a second key), `L` back to line. Stores as `bulges[]` on the existing `PolylineEntity` — no model change. This is how AutoCAD PLINE works and it's what makes slots/rounded outlines drawable in one entity.

### T-10 · Move — **P0, S** — ✅ 2026-09-21 (nudge too)

Base point → second point (or typed displacement `@dx,dy`). Emits existing `move-entity` commands in a batch. `Ctrl` while placing = copy instead (AutoCAD habit). Also: **nudge** (arrow keys move selection by 1 grid step; Shift = ×10) — implemented here since it's the same command.

### T-11 · Copy / clipboard — **P0, S** — ✅ 2026-09-21

- **Copy-with-base-point** tool (AutoCAD COPY, repeats until Esc; `M` = multiple mode by default).
- `Ctrl+C` / `Ctrl+X` / `Ctrl+V`: serialize the selection with the **sketch-code DSL** (`toCode` on a sub-document) onto the system clipboard as `text/plain`. Paste parses with `parseCode`, re-ids, offsets to cursor, works across tabs and even into a text editor/AI chat. `Ctrl+Shift+V` = paste in place. `Ctrl+D` = duplicate offset by one grid step.
- Fix: groups copy as groups (copy the group registry entries too).

### T-12 · Rotate — **P0, S** — ✅ 2026-09-21

Base point, then angle by cursor or typed; `R` = reference mode (pick two points defining the current angle, then the new angle — how you square up an imported drawing); `C` = copy. Core: existing `rotated()` on entities. Straighten stays as the shortcut it is.

### T-13 · Scale — **P0, S** — ✅ 2026-09-21

Base point + factor or `R` reference (pick a known length, type what it should be — the standard way to fix a DXF imported in the wrong unit). Core: existing `transformed()`. Non-uniform scale is *not* supported (circles/arcs can't express it — same rule as the DXF INSERT importer).

### T-14 · Mirror — **P0, S** — ✅ 2026-09-21

Two points define the axis (with ortho/polar from T-09 for H/V axes); option keep/delete source (default keep, as AutoCAD `MIRROR`). Text is mirrored by position only, never mirrored as glyphs (AutoCAD `MIRRTEXT=0`). Core: `mirrored(entity, p1, p2)` in `entities.ts` — for arcs, swap `ccw` and reflect start/end; for polylines negate bulges (same trick `dxf.ts` uses for negative INSERT scale — reuse it).

### T-15 · Offset — **P0, M** — ✅ 2026-11-02

Distance (typed) or **through point**; then click entities, side by cursor; repeats until Esc. Core `offsetEntity(entity, d, side)`:
- line → parallel line; circle/arc → concentric (reject if `r+d ≤ 0`);
- polyline → offset each segment (line or bulge arc), then join consecutive offsets: intersect adjacent line/line, insert a bulge arc at convex corners (AutoCAD `OFFSETGAPTYPE=1` behaviour is round; 0 = extend to intersection — offer both, default extend), and **drop segments that invert** (this is the hard part — a simple "remove segments whose direction flipped + re-intersect neighbours" pass covers 95 % of real outlines). Tests on a rectangle, a rounded rectangle, a concave L-shape, and a closed outline where inner offset collapses a short edge.
- Closed polyline result stays closed. Layer/colour copied from source.

### T-16 · Trim / Extend / Split — **P0, L** — ✅ 2026-11-02

**Ref:** AutoCAD 2021+ *quick trim* mode (no boundary selection — just click or drag across the pieces to remove) plus Shift = extend; Onshape `Split`.

Needs the **intersection library** first (`packages/core/src/intersect.ts`): pairwise `line/line`, `line/circle`, `line/arc`, `circle/circle`, `circle/arc`, `arc/arc`, plus polyline decomposed into segments (with bulge arcs). Return parameters `t` along each curve so callers can split. Shared with T-21 intersection snap, T-17 fillet, T-32 hatch boundaries.

- **Trim:** compute all intersection params on the clicked entity against *everything visible* (AutoCAD's quick mode uses all objects as cutting edges), find the piece under the cursor between its two neighbouring params, delete that piece: line → up to 2 lines; arc/circle → arc(s) (circle becomes an arc); polyline → split into polylines. Drag-across (fence) trims every piece the cursor crossed.
- **Extend:** Shift-click near an endpoint: extend the line/arc along its own path to the nearest intersection with any other entity's *extension*, (AutoCAD `EDGEMODE=Extend`). No intersection → no-op with a status message.
- **Split** (Onshape): click a point on an entity → split there (uses the split primitive from trim; no delete).
- **Break at point / Break** (AutoCAD): thin wrappers over split.
- All emit `delete-entity` + `add-entity` in one batch. Preserve `name`? — no: new pieces get new names; the DSL diff treats it as replace.

### T-17 · Fillet / Chamfer — **P0, M** — ✅ 2026-11-04 (fillet: lines, arcs, circles + polyline corners; chamfer: lines, arcs, circles)

Pick two entities (lines, arcs, circles, or two adjacent polyline segments), radius typed or remembered. Core `fillet(e1, e2, r)`: offset both by `r` on the side of the click points, intersect the offsets → center, drop perpendiculars/radial points → tangent points, trim/extend both inputs to the tangent points, add the arc. **Radius 0 = corner join** (extends/trims two lines to their intersection — hugely useful for cleaning DXFs; AutoCAD users do this constantly). Polyline mode: fillet *all* corners of a closed polyline at once (`P` option) — writes bulges into the polyline instead of adding arcs. Chamfer: same flow with two distances or distance+angle. Onshape adds a tangent constraint here; do that in T-46 when the solver exists.

---

## 5. Phase 3 — Precision editing and remaining tools

### T-27 · Grips — **P1, M** — ✅ 2026-09-21 drag grips; 2026-11-04 multifunction polyline vertex menu

**Ref:** AutoCAD. When one or a few entities are selected, draw small squares at endpoints, midpoint, center, quadrants, polyline vertices, arc ends/mid, text insertion, image corners. Drag an endpoint grip → move only that point (`update-entity`); drag a midpoint grip → move the whole entity; drag a circle's quadrant → change radius; polyline midpoint grip (AutoCAD's ▭ multifunction grip) → hover menu: *Stretch / Add vertex / Convert to arc / Remove vertex*. Grips participate in snapping (dragging an endpoint onto another endpoint is the manual "coincident"). This replaces most of LibreCAD's polyline sub-tools in one gesture.

### T-28 · Properties panel — **P1, M** — ✅ 2026-09-21

Right-side panel (sibling of Layers/Code) showing the selection: common section (layer, colour, linetype, lineweight, construction), then per-type fields: line `a.x a.y b.x b.y length angle`, circle `cx cy r d circumference area`, arc `+ start end sweep length`, polyline `vertex count closed length area`, text `content height rotation`. Every field editable → `update-entity` command; multi-select edits the common fields on all. Read-only computed fields (length/area) are the AutoCAD "Quick Properties" people miss most. *Match properties* (T-26): a tool that samples one entity and applies its common properties to clicked ones — trivial once this panel exists.

### T-29 · Selection and view upgrades — **P1, S each** — ✅ 2026-11-02

- `Ctrl+A` select all (visible, unlocked layers); `Ctrl+I` invert; **Select similar** (same type + layer + colour); **select by** dialog (type / layer / colour / construction); **lasso** (freehand polygon, Alt-drag); **fence** (polyline crossing, used by trim too); **selection cycling** (Ctrl+click on overlapping entities cycles, with a small list popover — AutoCAD `SELECTIONCYCLING`).
- Zoom window (`Z` then drag), zoom selected, zoom previous (view history stack), middle-button double-click = fit.
- Lock layers (existing layers panel: lock = non-selectable, drawn dimmed).

### T-18 · Stretch — **P1, M** — ✅ 2026-09-21

Crossing box, then base → target: endpoints *inside* the box move, endpoints outside stay, entities entirely inside move whole. Arcs recompute from moved endpoints keeping the radius (AutoCAD keeps the center displacement — either is acceptable; document it). This is the AutoCAD tool that makes "lengthen this bracket by 20" a two-click job.

### T-19 · Divide / Measure-points — **S** ✅ · T-22 · Join / Explode — **S** ✅ · T-23 Lengthen ✅ · T-24 Align ✅ · T-25 Polyline edit ✅ · T-26 Match ✅ (all 2026-09-21) · T-23 · Lengthen — **S** · T-24 · Align — **S** · T-25 · Polyline edit — **M** · T-26 · Match properties — **S**

- **Divide/Measure:** N equal points or a fixed spacing along a line/arc/circle/polyline (`pointAlong(entity, s)` helper on core). Optionally place blocks later (T-34).
- **Join:** selected connected lines/arcs → one polyline (chain via `connectivity.ts`; `heal.ts` already joins collinear lines — generalise). **Explode:** polyline → lines + arcs; group → members; text → polylines (via `font.ts` strokes — that's how the DXF export already handles text).
- **Lengthen:** delta / total / percent / dynamic drag at the picked end; works on lines and arcs.
- **Align:** two source points → two target points = move + rotate (+ optional scale). Straighten becomes a special case.
- **Polyline edit:** fold into grips (T-27) + a context menu: add/remove vertex, seg→arc/arc→seg, reverse direction, open/close, decurve, fit-arc-through-vertices. Don't build a PEDIT modal.

### T-04 · Polygon, T-05 · Rectangle modes, T-06 · Slot, T-07 · Construction line — **S each** — ✅ all four 2026-09-21

- Polygon: N sides, center + vertex (inscribed) or center + edge-midpoint (circumscribed), or edge–edge. Emits a closed polyline.
- Rectangle: `center-point` mode and `3-point` (rotated) mode on the existing tool; typed `W×H` via T-08.
- Slot: straight (two centres + width) and arc slot (center, radius, two angles, width). One closed polyline with bulges. Once T-42 exists the slot carries its own dimensions.
- XLINE/RAY: infinite construction lines. Needs a tiny model decision: either a new `xline` entity (rendered clipped to viewport, never exported — construction only) or a line with `infinite: true`. Recommend the flag on `LineEntity` + `dashed` forced on, to avoid a new entity type. Hugely useful for layout work (centre lines, mirror axes) and for the solver phase.

---

## 6. Phase 4 — Parametric sketching (Onshape parity)

This is the roadmap's north star and the reason the DSL reserved `param`/`constraint`/`dim`. Do it *after* Phase 2, because the solver has nothing to constrain until arcs/offset/fillet produce real geometry, and because the T-08 typed-input UX is what makes dimensions usable.

### T-40 · Solver integration — **P1, L** — ✅ 2026-09-22 (own LM solver, not planegcs — see the progress log)

- `planegcs` (FreeCAD's solver, WASM, on npm: `@salusoft89/planegcs`). Wrap in `packages/core/src/solver/` behind an interface so the solver can run in a worker; document ↔ solver mapping keeps a stable `EntityId ↔ param index` table.
- Solve step runs as a **bus middleware**: after each command batch that touches constrained entities, solve, and append the resulting `update-entity` moves *to the same undo step*. Degrees of freedom and conflict list come back with each solve.
- Dragging a constrained entity = drag-solve (the solver's "temporary fix" on the dragged point), which is what makes Onshape sketches feel alive.

### T-41 · Constraint tools — **P1, M** — ✅ 2026-09-22

Extend the `Constraint` union with **concentric, midpoint, symmetric, collinear, point-on-curve**, then one tool per constraint (or one "Constrain" tool with a sub-mode strip, Onshape style): pick entities/points → `add-constraint` command. Constraint glyphs drawn next to their geometry; click a glyph to select/delete; toggle visibility. `PointRef` needs to grow beyond `a | b | center` to cover polyline vertices and arc ends.

### T-42 · Driving dimensions — **P1, L**

Replace the current "dim draws lines" with a real `DimensionEntity` (linear/aligned, horizontal, vertical, angular, radial, diametral, arc-length) that is *both* an annotation and a `distance/angle/radius` constraint. Double-click the value to edit (opens the T-08 box) → solver moves geometry. Renders with the existing `dimension.ts` layout; exports to DXF `DIMENSION` (or exploded lines for R12). A *driven* (reference) toggle shows the value in parentheses without constraining — needed when the sketch is already fully defined.

### T-43 · Inference / auto-constraints while drawing — **P1, M**

Builds on T-20/T-21: when a snap fired while placing a point (endpoint → coincident, midpoint → midpoint, on-line → point-on-curve, ortho/polar 0/90 → horizontal/vertical, tangent snap → tangent, parallel/perpendicular guide → parallel/perpendicular), add that constraint with the geometry in the same batch. Show the inference glyph at the cursor before the click, exactly as Onshape does. Toggle to turn auto-constraints off (AutoCAD `AUTOCONSTRAIN`, Onshape's "Ctrl to suppress inference").

### T-44 · DOF feedback and conflict diagnosis — **P2, S**

Colour by state (Onshape: blue under-defined, black fully defined, red over/conflicting). Status bar shows remaining DOF. A conflicts panel lists the constraints the solver rejected, with "delete this one" buttons.

### T-45 · Parameters and expressions — **P2, M**

`param width = 100` in the DSL, a Variables panel, and dimension values that accept expressions (`width / 2 + 5`). Evaluate with a tiny expression parser (no `eval`). This is what makes the AI-assistant story work ("make it 20 % wider" = edit one param).

### T-46 · Associative tools — **P2, M**

Mirror → adds symmetric constraints; Offset → adds an offset constraint (planegcs has `distance` per point; approximate with per-vertex distances); Fillet → adds tangent constraints; Pattern → linear/circular pattern constraints. Optional but this is what Onshape users mean by "sketch mirror".

---

## 7. Later / nice-to-have

| ID | Item | Notes |
|---|---|---|
| T-30 | Ellipse / elliptical arc | New entity type (touches all exhaustive switches). Until then, the importer's polyline approximation is acceptable for fab work. |
| T-31 | Spline (interpolated + control-point) | New entity (cubic B-spline / Catmull-Rom). DXF `SPLINE` round-trip. Onshape users will ask for it; laser/CNC users mostly don't need it. |
| T-32 | Hatch patterns + boundary detection | `regions.ts` already finds closed loops. Add ANSI31-style line patterns clipped to the region (render + DXF `HATCH` export). |
| T-33 | Multi-line text / leaders | Word-wrapped text box; leader = polyline + arrowhead + text. |
| T-34 | Blocks (definition + instance entity) | Keep DXF `INSERT` as instances instead of expanding; a symbol library panel; "make block" from selection. Pairs with T-19 (divide with blocks). |
| T-35 | Array along path | ✅ 2026-11-02 - extends `pattern.ts` (`pathPatternCommands`). |
| T-36 | Linetypes and lineweights | Replace `dashed: boolean` with `linetype: "continuous" \| "dashed" \| "center" \| "hidden" \| "phantom"` + `lineweight` mm, per entity with layer defaults; DXF `LTYPE` round-trip. Keep `dashed` reading as a migration alias. |

Explicitly **not** on the roadmap: 3D, dynamic blocks, sheet/paper-space layouts (print already covers one-sheet output), AutoLISP-style scripting (the plugin host + DSL are the equivalents).

---

## 8. Definition of done for any tool

1. Pure core function in `packages/core` with vitest coverage of the geometric edge cases (zero-length, collinear, tangent, inverted offset, etc.).
2. Tool class in `apps/web/src/tools/`, registered in the toolbar with a default keybinding action id, prompt text, and preview.
3. Accepts typed input (T-08) wherever AutoCAD would.
4. One undo step per user-visible operation.
5. Works on all entity types it claims to (arcs and bulged polylines are the usual omission).
6. Round-trips through DXF/SVG and the sketch-code DSL if it created a new kind of data.
7. Verified live in the dev server (`window.sketchor` + real pointer events), screenshot in the PR.

---

## 9. Suggested assignment

| Track | Items | Skills |
|---|---|---|
| A · Framework + input | T-00, T-08, T-09, T-21, T-29 | React/zustand, canvas, UX |
| B · Geometry core | intersect lib, T-15, T-16, T-17, T-14, T-18, T-22–T-25 | 2D geometry, tests |
| C · Draw tools | T-01–T-07, T-10–T-13, T-19 | quick wins after A lands |
| D · Parametric | T-40–T-46 | WASM, solver theory, DSL |
| E · Editing UX | T-27, T-28, T-26, T-36 | React panels |

Track A must land its T-00 framework before C starts; B can begin immediately in `packages/core` with tests only, then wire tools once A is in.
