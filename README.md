# Sketchor

Modern parametric 2D sketching — web-first, desktop-capable, designed for AI integration from day one.

## Run it

```bash
npm install
npm run dev        # web app at http://localhost:5173
npm run desktop    # native desktop window via Tauri (needs Rust toolchain)
```

## Controls

| Action | Input |
|---|---|
| Line tool | `L` — click points to chain, `Esc` to finish |
| Polyline tool | `W` — click each vertex; `A` makes the next leg an arc (through-point, then end), `T` a tangent arc, `L` back to straight; `Enter` or double-click finishes, `C` closes the shape, `Backspace` undoes a vertex |
| Circle tool | `C` — click center, then a point on the circle (or type the radius); `Tab` cycles center-diameter, two-point, three-point and tangent-tangent-radius (type the radius, click two entities) |
| Rectangle tool | `R` — two corners; `Tab` cycles center + corner and three-point (rotated) |
| Polygon / Slot tools | Polygon: type the number of sides, center + vertex (`Tab`: circumscribed — across flats — or by edge). Slot: two centres then the width, or `Tab` for an arc slot (center, start, end, width) |
| Arc tool | `A` — three-point (start, end, point on the arc); `Tab` cycles to center-start-end and tangent-continuation |
| Move / Copy / Rotate / Scale / Mirror | `Shift+M` / `Shift+D` / `Shift+R` / `Shift+S` / `Shift+I` — select first (or click the object), then follow the status-bar prompt: base point and destination, pivot and angle (typed or two directions), base and factor or reference length, two axis points. `Ctrl`-click the last point to copy instead of modify (mirror: to delete the source) |
| Trim / Split | `Shift+T` click the piece to remove (everything visible cuts); `Shift`-click near an end to extend it to the next boundary · `Shift+B` click where to cut |
| Fillet / Chamfer / Offset | `Shift+F` type a radius (0 = sharp corner join), click two lines on the halves to keep, or click a polyline corner (`Enter` rounds every corner of the selected polylines) · Chamfer: type a distance, two lines · `Shift+O` type a distance, click the entity, click the side |
| Typed coordinates | while drawing, type `100` (length toward the cursor), `100<45`, `50,20`, `@50,20` — units like `4in`, `2'6"` accepted |
| Ortho / polar | `F8` / `F10` (or the status-bar toggles); `Shift` held is temporary ortho |
| Select tool | `V` — click (Shift adds), drag to move, `Del` deletes; click the same spot again to cycle through whatever overlaps there |
| Measure tool | `M` — see below (2D drawings; in a 3D tab, selecting is measuring) |
| Pan | middle- or right-button drag, the Pan tool, or two fingers |
| Zoom | mouse wheel (at cursor), or pinch |
| Save / Save As | `Ctrl+S` overwrites the tab's own file; the Save menu names that file and offers Save As / Save a Copy |
| Close tab | `Ctrl+W` (desktop only — browsers reserve it for their own tab) |
| Undo / Redo | `Ctrl+Z` / `Ctrl+Y` |
| Copy / Cut / Paste | `Ctrl+C` / `Ctrl+X` / `Ctrl+V` (at the cursor) / `Ctrl+Shift+V` (in place) / `Ctrl+D` (duplicate) — the clipboard holds readable sketch code, so a copy pastes into a chat or editor too |
| Nudge | arrow keys move the selection one grid step; `Shift` = ten |
| Select all / invert | `Ctrl+A` / `Ctrl+I` |
| Lasso / fence | `Alt`-drag a freehand loop (left → right takes only what's inside, right → left also what it touches); `Ctrl+Alt`-drag an open stroke that takes everything it crosses |
| Select similar / by | `Ctrl+Shift+A` takes everything of the same type, layer and colour as the selection; the **SELECT** button in the status bar picks by type / layer / colour / construction, with a live count |
| Command line | `Ctrl+9` or the **CMD** button — type tool aliases (`l`, `c`, `rec`, `o 5`, `f 2.5`), commands (`u`, `e`, `j`, `x`, `fit`, `rz`) or coordinates (`100,50`, `@30<45`); `Tab` completes, `↑`/`↓` walk the history, `Enter` on an empty line repeats the last command |
| Ortho / polar / tracking | `F8` constrains to 0/90/180/270° from the last point (`Shift` = temporary), `F10` snaps to an angle increment, `F11` toggles object snap tracking — see below |
| Lock a layer | the padlock in the Layers panel — the layer stays on screen, dimmed, but nothing on it can be clicked, boxed, lassoed or deleted |
| Join / Explode | `J` chains the selected lines and arcs into one polyline (closed when the ends meet); `Ctrl+E` explodes selected polylines back into lines and arcs |
| Divide | Divide tool: type a count (or a spacing like `25mm`), click an entity — points mark the divisions |
| Zoom window / previous | `Z` then two corners / `Shift+Z` |
| Grips | with something selected, drag a square handle: ends and vertices stretch, hollow midpoint/center handles move, a circle's quadrant sets the radius |
| Properties panel | `Ctrl+1` — edit the selection's layer, colour, construction flag, and (for one entity) every coordinate, radius, angle, text or vertex numerically; a polyline's vertices can be inserted, removed, made arcs, and the order reversed |
| Stretch | `Shift+E` — two corners of a crossing box around the ends to move, then base point and destination: endpoints inside move, the rest stay |
| Construction line | `L` then `Tab` — two points fix an infinite dashed line that snaps and trims like geometry but never exports |
| Align / Lengthen / Match | `Shift+A` two source points → two targets (Ctrl-click the last to scale) · `Shift+L` type `+5`, `-5`, `40` or `150%` then click near an end · Match: click a source, then the entities that should take its layer/colour |

Snapping is automatic, in priority order: **the origin**, endpoints, centers,
quadrants, **intersections** (any two curves), nodes, and — measured from the
point you just placed — **perpendicular** feet and **tangent** points; then
midpoints; then the nearest point **along** a line, arc or circle; then a
line's **extension** past its end (with a dashed guide); then the grid. The
**SNAP** button in the status bar switches kinds on and off.

**Object snap tracking** (the **TRACK** button, `F11`, on by default) is the
one that places points nothing can snap to. Hover a corner or a centre and
it is *acquired* — marked with a small plus. From then on, whenever the
cursor lines up with it horizontally or vertically (or along the polar
increment), the cursor is pulled onto that alignment and a dashed guide is
drawn back to the point. Line up with two acquired points at once and you
get their crossing: directly above this corner **and** level with that one,
exactly, with no construction lines to draw and erase.

**Relative zero** is the last point you placed, marked with a small crossed
circle. `@dx,dy` measures from the tool's own last point while it has one,
and from the relative zero when it doesn't — so a line can start "20 right
and 100 up from that corner" without drawing anything to measure from. `rz`
on the command line (or a shortcut you bind to *Set relative zero*) moves it
to the cursor.

### Constraints (the parametric layer, in progress)

A drawing can carry **constraints** — coincident, horizontal, vertical,
parallel, perpendicular, tangent, equal, distance, radius, angle, fix — and
Sketchor solves them. Adding one moves the geometry that has to move; so
does editing anything the constraints reach, in the same undo step. The
status bar says how many **degrees of freedom** are left, turns green at
*fully constrained*, and names the constraints that conflict when they
can't all hold at once. Dragging a corner of a constrained sketch drags
everything tied to it, live.

**Applying one** works the way Onshape does: select the geometry, then
press the constraint in the **Constraints** panel (`Ctrl+2`). Buttons
light up for what the selection can take and a disabled one says what it
would need — *"Two or more lines"*, *"A circle or arc, and a line, circle
or arc"*. Where a constraint needs points and you selected whole entities,
the nearest pair of ends is used, which is the one you were looking at.

Constraints are drawn as small marks beside the geometry they hold (the
**Glyphs** switch turns them off). Click a mark to select what it holds;
double-click it to remove it. The panel lists everything the sketch has,
greys out the ones that are merely implied by the others, and turns the
conflicting ones red.

`distance`, `radius` and `angle` currently *lock the value the geometry
already has* — editable driving dimensions are the next roadmap item.

The solver is Sketchor's own — least squares by Levenberg–Marquardt over
the constraint equations, pure TypeScript, no WASM (see
`packages/core/src/solver/`).

The world origin is drawn as a crosshair with labelled +X / +Y stubs (and a
muted marker clamped to the edge when it's panned off-screen), so `0, 0` is
always locatable and there's something to aim at when snapping.

**Moving snaps the geometry, not the cursor.** Dragging a selection with the
select tool aligns the selection vertex nearest where you grabbed onto
whatever snap target you drag near — so grabbing a corner and dropping it by
the origin lands it exactly on `0, 0`. Hold `Alt` while dragging for a free,
unsnapped move. The grid is deliberately excluded, since quantising every
drag would make free positioning impossible.

### Patterns

The pattern panel repeats the current selection in a **grid** (columns/rows
plus spacing) or **around a circle** (count, sweep angle, centre, and whether
copies rotate to follow the arc). A full 360° sweep divides by the instance
count rather than count−1, so it doesn't stack a duplicate on the original.

Copies are ordinary independent entities added in a single undoable step —
there's no live array object linking them back to the source, so each copy is
editable afterwards like anything else.

### Measure tool

A plain click measures point-to-point using the snaps above. The modifiers
cover whole-entity and reference measurements:

| Action | Input |
|---|---|
| Distance between two points | click, then click |
| Whole length / radius of one entity | `Alt`-click it (arcs also report arc length) |
| Running total across lines *and* arcs | `Shift`+`Alt`-click each one |
| Area **and perimeter** of a closed region | click inside it |
| Angle relative to a chosen edge | `Ctrl`-click a line to set the reference |
| Keep a measurement on screen | `Enter` (up to 5 pinned) |
| Copy the readout | `Ctrl+C` |

## Architecture

```
packages/core     framework-free document model + command bus (TypeScript)
apps/web          React + Vite UI, custom Canvas2D viewport
apps/web/src-tauri  Tauri 2 shell -> same UI as a local desktop app
```

The one rule that everything else hangs on: **the document is only ever
mutated through serializable `Command` values** (`add-entity`,
`delete-entities`, `move-entities`, ...). The `CommandBus` applies them,
derives inverses for undo/redo, and notifies subscribers. Tools, the future
constraint solver, and the future AI assistant are all just command
producers — none of them get special access.

Try it in the browser console: `window.sketchor.bus.execute({...})`.

## Sketch code (the text view)

The right-hand panel is a **two-way text representation** of the drawing.
Drawing on the canvas regenerates the code; editing the code and pressing
**Apply** (or `Ctrl+Enter`) turns your edit into ordinary undoable commands.

```
sketch v1

line L1 from (0, 0) to (100, 0)
line L2 from (100, 0) to (100, 60)
circle C1 at (50, 30) r 15
polyline PL1 pts (0, 0) (40, 0) (40, 30) closed
```

Code doesn't express a polyline's per-segment arc bulge (just as it doesn't
express layers) — both are preserved through an edit rather than lost, but a
bulged segment reads as straight in the text.

Every entity has a stable handle (`L1`, `C1`, `PL1`, ...). Editing is a *diff*:
matching names are updated in place (keeping their identity and undo
history), new names are added, and dropped names are deleted — so an edit
that changes one number moves exactly one entity.

This is the surface designed for AI agents. Instead of manipulating opaque
objects, an agent reads `window.sketchor.toCode()` and writes back with
`window.sketchor.applyCode(text)`, which returns line-level parse errors
(`[{ line, message }]`) if the text is invalid and leaves the drawing
untouched. Same grammar for humans and models.

The grammar reserves three keywords for the parametric layer, already
rejected with a clear message so files stay forward-compatible:

```
param width = 40           # named variable
constraint tangent L1 C1   # geometric relationship
dim L1 length = width      # driven/driving dimension
```

## File formats

Sketchor has no proprietary file format — everything is a standard interchange
format:

- **DXF** — read/write (`packages/core/src/dxf.ts` + `dxfExport.ts`). Reads
  LINE, CIRCLE, ARC, POINT, ELLIPSE, LWPOLYLINE/POLYLINE (including bulged
  arc segments), SPLINE, **HATCH** (boundary paths, pattern definitions, solid, gradient, associativity; written as real HATCH records in DXF 2018, exploded to lines in R12), TEXT/MTEXT, and **INSERT** — block references are
  expanded with their insertion point, scale, rotation and row/column arrays,
  including blocks nested inside other blocks. Geometry drawn on layer `0`
  inside a block inherits the layer the block was placed on, as CAD expects.
- **SVG** — read/write, dimensionally accurate 1:1 world units; hatches export as exact stroke segments, flat fills or real gradients (PDF: shadings); import resolves stroke/fill/dashes/weights from attributes, `style=` and `<style>` CSS, reads text, Inkscape layers and `<use>`; export writes Inkscape layers, exact arcs and a "for laser / CAM" mode; fixture corpus + hostile-input tests
  (`packages/core/src/svg.ts`).
- **EPS / AI (Illustrator EPS)** — import only: an own PostScript-subset interpreter (`packages/core/src/eps/`) reads Illustrator and plain-PostScript EPS into exact splines, polylines, circles, solid hatches, text and images (CMYK → RGB, spot colours → layers, points → mm); Photoshop raster EPS and PDF-based `.ai` are handled gracefully (embedded preview / a clear message). Files are read in ranges, so a 260 MB raster EPS opens instantly. A core EPS writer (exact Béziers, optional TIFF preview header) round-trips within 0.001 mm; its Save-as UI is still to come.
- **DWG** — read-only, via a GPL-3.0 WebAssembly build of GNU LibreDWG (see
  `apps/web/src/browser/dwgImport.ts` and `/NOTICE.md`). There is no DWG
  export.
- **STEP / IGES** — 3D models, **view-only**, in their own tab. Read by
  OpenCascade compiled to WebAssembly (Sketchor's own build of
  `occt-import-js`, LGPL — see `/NOTICE.md` and
  `native/occt-import-js-build/`) and drawn with three.js. A 3,000-part
  assembly opens in a few seconds. See *3D models* below.

Use the **Open** button (or `Ctrl+O`) to load any of these; **Save**
(`Ctrl+S`) offers a choice of DXF or SVG. The File System Access API is used
in the browser and in Tauri's WebView2, with a download / file-input fallback
elsewhere. Opening a file that's already open in a tab switches to that tab
(and reloads it) instead of opening a duplicate.

- **BREP / 3DM** - OpenCascade `.brep`/`.brp` (same wasm as STEP) and Rhino
  `.3dm` (rhino3dm, MIT - see `/NOTICE.md`). A 3dm shows its Breps through
  the render meshes Rhino saved (each Brep face stays one pickable face),
  plus meshes and extrusions; curves, points, blocks and SubD are not drawn yet.
- **2D from 3D** - select a flat face in a model tab and press *To 2D*: its
  outline (lines, arcs, circles at true size, at the origin) opens in a new
  2D tab, ready to save as DXF for the laser.

### 3D models (STEP / IGES)

Opening a `.step`/`.stp` (or `.iges`/`.igs`) file gives a 3D viewer tab
instead of a drawing: shaded parts in the colours the file carries, B-rep
edges drawn as dark outlines, orbit with the left mouse button, pan with the
right or middle, wheel to zoom toward the cursor. Double-click frames what
is under the cursor, `H` hides the selected part, `I` isolates it and
`Shift+H` shows everything again; `E` toggles edges, `F` fits, and `1`–`4` jump to
isometric / top / front / right.

**Which way is up?** The viewer draws Z up (Onshape's convention), but
SolidWorks exports Y-up. Sketchor reads the STEP header and stands a
SolidWorks file upright by itself; if it guesses wrong for a file, the
**Z up / Y up** toolbar button (or `Shift+U`, rebindable) turns it, and the
choice is remembered for that file. Measurements read in the displayed
frame, so ΔZ is always the height you see.

**Clicking picks geometry, the way Onshape does** — the vertex, edge or
face under the cursor, in that order of preference, so aiming at a corner
gets the corner and not the edge it sits on. The bottom-right readout says
what it measures:

| You picked | You get |
| --- | --- |
| A vertex | X / Y / Z |
| A straight edge | Length, ΔX ΔY ΔZ |
| A circle or arc | Diameter, radius, centre, arc angle |
| A face | Area, perimeter, normal (and diameter, for a cylindrical one) |
| A part (from the Structure panel) | Size, surface area, volume, face and edge counts |
| Two of anything | Distance, ΔX / ΔY / ΔZ — and the angle, where one means something |

Shift- or Ctrl-click adds to the selection (up to eight); `Esc` or a click
on empty space clears it.

**There is no separate measure mode** — selecting is measuring. Whatever the
readout reports, the viewer *draws*: a solid dimension line between the two
points the distance was actually taken between (the foot of the
perpendicular, for a distance to a plane; the nearest points, for two
edges), the length on it, and three dashed legs showing the ΔX, ΔY and ΔZ
that make it up — red, green, blue. Pick one straight edge and the line runs
along it; pick a circle and it shows the radius. The drawing stays attached
to the geometry while you orbit.

**Isolate** — right-click a part in the Structure panel (or a whole
sub-assembly, which isolates everything under it) and choose *Isolate*:
everything else is hidden and the view fits what's left. The toolbar button
and `I` do the same for the current selection, and **Show all** brings
everything back. The same menu offers Hide and Zoom to.

The panel on the right is the **Structure** tree for a model tab — the
assembly hierarchy, with a filter, per-part hide/show and double-click to
frame — in the slot layers occupy for a drawing.

On a touch screen: one finger orbits, two fingers pinch-zoom and pan, tap
picks (with a wider aperture, so fingers can still hit an edge), double-tap
frames, and a long-press hides the part under your finger (Show all brings
it back). Buttons grow to finger size, and the readout moves clear of the
bottom toolbar.

### Touch mode

The hand button in the top bar turns on **touch mode**: the drawing tools
move to a row of big labelled buttons along the bottom of the screen (where
a thumb can reach them), and the 3D viewer's buttons do the same. It's on
by default on devices that report a touch pointer and remembered either
way. Independently of the setting, the 2D canvas understands fingers: one
finger works the current tool (tap = click, drag = drag), two fingers pan
and pinch-zoom from any tool without losing a half-drawn line, and a
double-tap fits the drawing (or the tapped entity). The **Pan** tool makes
one finger pan instead.

The file browser lists model files next to drawings and previews each one as
an **isometric thumbnail**.

What to expect for speed: reading a STEP file is the slow part (it's a B-rep
that has to be tessellated — a few hundred KB opens in about a second, a
3 MB assembly of ~1,700 parts in under half a minute, a 10 MB one in a
couple of minutes) and it runs in a pool of background workers, so the app
stays responsive and several previews load in parallel. The result is
**cached** (IndexedDB, keyed by a hash of the file's bytes, up to ~768 MB)
along with the thumbnail, so any file you have looked at once — opened, or
merely browsed past — comes back instantly afterwards.

On Windows, **Explorer shows previews for model files too**, through the
same shell extension that previews DXF: for any model Sketchor has rendered
once (opened, or browsed past) it's the exact shaded isometric picture;
for a STEP file it has never seen, a wireframe read straight from the file's
edges — assembly placements resolved — so the icon still shows the shape.
Opening the file upgrades the icon to the shaded version. Windows needs a
one-time administrator approval before Explorer will consult the handler
for a file type: the installer asks for it, and if that was skipped (or the
update arrived silently) Sketchor asks at its next launch — one "Registry
Editor" prompt, then never again. Declining is respected for a week.

There is no SAT or Parasolid support: those are proprietary kernels with no
open-source reader. Export STEP from the source CAD instead (Onshape does).

### The file browser

The left panel browses a folder of drawings as geometry thumbnails, and
filters as you type (`Ctrl+F`). Reading and rendering previews runs on a
queue that yields to the browser between files, so opening a large library
fills in progressively instead of freezing the app — the drawing already open
stays editable throughout.

**It is built for folders of thousands.** Only the cards near the viewport
exist as elements; the rest are stand-in padding, so the scrollbar still
measures the whole folder while the page holds a few dozen nodes instead of
ten thousand. Row height and column count are measured from a real card rather
than hardcoded, because the cards are square and follow the panel's draggable
width. That does mean every item has to be the same height — long names and
the tag strip clip rather than wrap, and in a folder where anything is tagged
every card reserves the tag row. On the desktop the folder scan runs on a
blocking-pool thread, not the one pumping window events, and a spinner shows
while it works. The **list view** shows a small preview plus
Name / Modified / Size columns — click a column title to sort by it, click it
again to reverse. (The grid view has no headers, so it keeps a compact
name/date toggle.)

Files can be **tagged** (right-click one, or select several and use **Tag…**);
the tag chips along the top filter the list, and multiple active tags narrow
rather than widen. Tags persist in `localStorage`, keyed by full path on the
desktop build and by filename in the browser — the File System Access API's
handles aren't a durable identifier across sessions, so in the browser two
same-named files from different folders share tags.

**Dragging files out** of the panel copies them to another app — a chat's
upload box, a file input, Explorer, the desktop. Dragging an item that's part
of the current selection drags the whole selection; dragging an unselected one
drags just it.

Two mechanisms are attached to the drag, because drop targets read different
things: real `File` objects (what any *web* drop target reads, and what makes
a drag into a chat attach the drawing instead of pasting its name), plus
Chromium's `DownloadURL` protocol, which is what lets a drop onto the *OS*
write a file. `DownloadURL` carries only one file, so it's attached to
single-file drags only; a multi-file drag still works into web targets, and
**Export** writes a selection out directly.

On Windows, `native/dxf-thumbnailer/` is a Rust COM shell extension that makes
Explorer render a **preview of the geometry** — not just the app icon — as the
`.dxf` file thumbnail (and, when installed elevated, in the reading pane).
Install it per-user with `native/dxf-thumbnailer/install-thumbnailer.ps1`.

On macOS, `native/dxf-quicklook/` does the same for Finder: a Quick Look
thumbnail extension (`.appex`) that renders `.dxf` geometry onto the file icon.
It shares the DXF parser and fit-to-box projection with the Windows thumbnailer
via a common Rust crate (`native/dxf-parse/`), so the two previews match. It
ships inside `Sketchor.app` (embedded after `tauri build` by
`native/embed-quicklook-macos.sh`, since Tauri can't bundle an app extension
itself); see `native/dxf-quicklook/README.md`.

## Saving

A tab remembers the file it came from, whichever way it got there — the Open
dialog, the in-app file browser, or a double-click in Explorer — so `Ctrl+S`
writes straight back to that file with no prompt. The Save button's menu names
it (`Save to bracket.dxf`) so it's clear what's about to be overwritten, and
sits above **Save As DXF/SVG** (prompts, and rebinds the tab to the new file)
and **Save a Copy** (prompts, but leaves the tab on its original file).

A drawing that has no file yet says so — the menu reads *Not saved to a file
yet* and Save opens the location prompt, pre-filled with the tab's name.

Two write paths back the same behaviour: a File System Access handle where the
file was picked through a dialog, and the `write_drawing_file` Tauri command
where the desktop build only has a native path (its folder browser and the
`.dxf` file association both hand over paths, not handles). DWG is import-only,
so a DWG tab stays unbound and Save falls through to a prompt. A 3D model tab
has nothing to save at all — Save just says so.

## Updates

The desktop app updates itself, without being asked. It checks a few seconds
after launch, and any time you press the download button in the toolbar; when
there's something newer it downloads the installer with a progress bar in the
banner, verifies its signature, installs it and relaunches into the new
version. Uncheck **Update automatically** in the toolbar's update popover to go
back to being asked first.

Installing closes Sketchor, so the automatic install only goes ahead while
every tab is saved. With unsaved work open the download finishes and then
waits, and the banner offers **Restart now** once you've saved — the update is
already on disk, so that restart is immediate.

Releases are signed with a minisign keypair. The public half is baked into
`tauri.conf.json`; the private half lives only in this machine's
`~/.sketchor-keys/` and in the repo's `TAURI_SIGNING_PRIVATE_KEY` Actions
secret, and `release.yml` uses it to sign the installer and publish the
`latest.json` the app polls. **Losing the private key means shipping a new
installer by hand**, since existing installs will reject anything signed with a
different key.

The web build has no installer to swap, so it falls back to the public GitHub
Releases API and offers the download page instead — the same fallback the
desktop app uses if `latest.json` can't be reached.

## Usage statistics

Sketchor sends anonymous usage statistics to [PostHog](https://posthog.com) so
it's possible to tell how many people use it and which features matter. It's
on by default; a one-time notice on first launch says so, and **Send anonymous
usage statistics** in the toolbar's update popover turns it off (or back on)
at any time. Turning it off also deletes the random id PostHog kept, so
turning it on again starts as a new anonymous user.

What is sent: a launch event, once per tab or window — a reload isn't a new
launch — with "first launch" and "updated from" flags;
a heartbeat every five minutes while the window is visible; which button,
shortcut, command-line command or palette entry was used — the same name for
all four, so it also records *how* a feature is reached, and never the text
typed into the command line — files opened and saved by *extension* and
order-of-magnitude size, STEP/IGES reads by part-count bucket and how long
they took, whether an update was found or failed, and errors — unhandled
exceptions plus a few caught ones (a model that failed to read, a save
target gone stale), with the message scrubbed of anything that looks like a
file name, path or URL before it leaves. Every event carries
the app version and whether it's the desktop or web build; PostHog derives a
coarse OS and browser from the user agent. Nothing else — never a file name,
a path, geometry, sketch text, layer names or plugin code. There is no
account or identity; no person profile is ever created.

`apps/web/src/metrics/` is the whole thing. `actions.ts` is the whitelist of
buttons that get counted, and a test checks each entry against the
components so a renamed button fails a test instead of silently vanishing
from the charts. Where a button's name is built at runtime the name is
dropped — a layer, a 3D part or a plugin is counted as "a layer was deleted",
never which one. Dev builds send nothing unless `VITE_METRICS_DEV=1`.

## Roadmap

1. **More geometry** — ellipses and splines; hatch patterns; blocks.
2. **Parametric constraints** — *the solver is in* (see below). What is
   left is the layer above it: tools to create constraints by picking
   geometry, glyphs that show which constraints exist, and driving
   dimensions you can double-click and retype.
3. **AI assistant** — a chat panel backed by the Claude API with tool
   definitions that emit `Command[]` proposals ("draw a 40x20 slot centered
   on the origin"). Proposals render as dashed previews; the user accepts or
   rejects. The command log doubles as conversation context.
4. **Rendering scale-up** — swap the Canvas2D renderer for WebGPU behind the
   same `render()` interface once drawings get large.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, tests and how to contribute.

## License

[GNU AGPL v3.0](LICENSE) or later.
