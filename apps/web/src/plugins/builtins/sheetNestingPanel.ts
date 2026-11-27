/**
 * The "Sheet Nesting" panel (a ~380px docked, sandboxed iframe). It holds no
 * job logic: the plugin sends a `view` (the job, per-field status, parts with
 * lengths already formatted in the display unit, which options the chosen
 * engine does not support) and the panel renders it and posts small patches
 * back. All user-visible strings live in the `T` table at the top of the
 * script so translations can be added later.
 *
 * Nesting engine based on the Sheet Nesting Calculator by Oleksandr Borenko.
 */
export const SHEET_NESTING_PANEL_HTML = String.raw`<!doctype html>
<html>
  <head>
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; padding: 10px; font: 12px system-ui, -apple-system, sans-serif; color: var(--sk-text,#dfe1e5); background: var(--sk-bg,#1e1f22); }
      h4 { margin: 0 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; opacity: .6; }
      .card { border: 1px solid var(--sk-border,#3a3d42); border-radius: 6px; padding: 8px; margin-bottom: 8px; background: var(--sk-panel,#232529); }
      .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 8px; }
      .fld { display: block; margin-bottom: 6px; }
      .fld > span.t { display: block; opacity: .7; font-size: 11px; }
      input, select { width: 100%; margin-top: 2px; padding: 4px 5px; background: var(--sk-bg,#1e1f22); color: inherit; border: 1px solid var(--sk-border,#3a3d42); border-radius: 4px; font: inherit; }
      input[type=checkbox] { width: auto; margin: 0 4px 0 0; }
      input.st-ok { border-color: #4f9d69; }
      input.st-missing { border-color: #e0912f; background: rgba(224,145,47,.12); }
      input.st-bad { border-color: var(--sk-danger,#f0616d); background: rgba(240,97,109,.12); }
      .lf { display: flex; gap: 3px; }
      .lf select { width: 52px; flex: none; }
      button { padding: 5px 9px; border: none; border-radius: 5px; background: var(--sk-accent,#4f7cff); color: #fff; font: inherit; cursor: pointer; }
      button.ghost { background: var(--sk-bg,#1e1f22); color: var(--sk-text,#dfe1e5); border: 1px solid var(--sk-border,#3a3d42); }
      button.sm { padding: 2px 6px; font-size: 11px; }
      button.warn { background: #e0912f; }
      button.go { background: #3f8f5c; }
      button.go.missing { background: #e0912f; }
      button:disabled, select:disabled, input:disabled { opacity: .4; cursor: default; }
      .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
      .row.tight { gap: 4px; }
      .muted { opacity: .6; }
      .seg { display: flex; border: 1px solid var(--sk-border,#3a3d42); border-radius: 5px; overflow: hidden; margin-bottom: 6px; }
      .seg button { flex: 1; border-radius: 0; background: transparent; color: var(--sk-text-dim,#9aa0a6); }
      .seg button.on { background: var(--sk-accent,#4f7cff); color: #fff; }
      details > summary { cursor: pointer; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; opacity: .75; margin-bottom: 6px; }
      .msg { padding: 5px 7px; border-radius: 4px; background: var(--sk-bg,#1e1f22); border-left: 3px solid #6b7280; margin: 4px 0; white-space: pre-wrap; }
      .msg.err { border-left-color: var(--sk-danger,#f0616d); }
      .msg.ok { border-left-color: #4f9d69; }
      .msg.warn { border-left-color: #e0912f; }
      .part { display: grid; grid-template-columns: 38px 1fr auto; gap: 6px; padding: 6px 0; border-top: 1px solid var(--sk-border,#3a3d42); align-items: start; }
      .part:first-child { border-top: none; }
      .part.gone { opacity: .5; }
      .thumb { width: 38px; height: 38px; background: var(--sk-bg,#1e1f22); border-radius: 4px; }
      .thumb svg { width: 100%; height: 100%; display: block; }
      .pname { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .pdim { opacity: .65; font-size: 11px; }
      .pwarn { color: #e0912f; font-size: 11px; }
      .pctl { display: grid; grid-template-columns: 46px 96px; gap: 3px; grid-column: 2 / 4; }
      .pctl select, .pctl input { margin-top: 0; padding: 3px 4px; font-size: 11px; }
      .prio-high { border-color: var(--sk-warn,#e0a030) !important; color: var(--sk-warn,#e0a030); }
      .kpis { display: grid; grid-template-columns: repeat(3,1fr); gap: 6px; margin-bottom: 6px; }
      .kpi { background: var(--sk-bg,#1e1f22); border-radius: 5px; padding: 5px 6px; }
      .kpi b { display: block; font-size: 15px; }
      .kpi span { opacity: .65; font-size: 10px; }
      table { border-collapse: collapse; width: 100%; font-size: 11px; }
      th, td { text-align: left; padding: 2px 4px; border-bottom: 1px solid var(--sk-border,#3a3d42); }
      .scard { display: flex; justify-content: space-between; align-items: center; padding: 4px 0; border-top: 1px solid var(--sk-border,#3a3d42); }
      .scard:first-child { border-top: none; }
      .credit { margin-top: 10px; font-size: 10px; opacity: .5; text-align: center; }
      .stockrow { display: grid; grid-template-columns: 1fr 58px 58px 40px 18px; gap: 3px; margin-bottom: 3px; }
      .stockrow input { margin: 0; padding: 3px; font-size: 11px; }
      .drop { border: 1px dashed var(--sk-border,#3a3d42); border-radius: 6px; padding: 10px; text-align: center; opacity: .7; margin-bottom: 6px; font-size: 11px; }
      .card.dragover { border-color: var(--sk-accent,#4f7cff); background: rgba(79,124,255,.10); }
      .card.dragover .drop { border-color: var(--sk-accent,#4f7cff); opacity: 1; }
      .tabs { display: flex; gap: 2px; margin-bottom: 8px; border-bottom: 1px solid var(--sk-border,#3a3d42); }
      .tabs button { flex: 1; background: transparent; color: var(--sk-text-dim,#9aa0a6); border-radius: 5px 5px 0 0; padding: 6px 4px; }
      .tabs button.on { background: var(--sk-panel,#232529); color: var(--sk-text,#dfe1e5); box-shadow: inset 0 -2px 0 var(--sk-accent,#4f7cff); }
      .rows { display: grid; gap: 3px; margin-bottom: 3px; align-items: center; }
      .rows input, .rows select { margin: 0; padding: 3px; font-size: 11px; }
      .rows.hdr { font-size: 10px; opacity: .6; }
      .barline { padding: 4px 0; border-top: 1px solid var(--sk-border,#3a3d42); font-size: 11px; }
      .barline:first-child { border-top: none; }
      .qtyb { display: inline-block; margin-left: 4px; padding: 0 6px; border-radius: 9px; background: var(--sk-accent,#4f7cff); color: #fff; font-size: 11px; font-weight: 600; }
      .mlist { margin: 4px 0 0; padding-left: 16px; }
      .mlist li { margin: 1px 0; }
      .mlist li.err { color: var(--sk-danger,#f0616d); }
      .mlist li.warn { color: #e0912f; }
      .rotrow button { padding: 3px 6px; }
      .barsvg { display: block; width: 100%; height: auto; margin: 3px 0 1px; touch-action: none; }
      .barsvg polygon { cursor: grab; }
      .barsvg polygon.sel { stroke: #ffd400; stroke-width: 4; }
      .barsvg.over { outline: 2px solid var(--sk-danger,#f0616d); }
      .barsvg.droptarget, .tray.droptarget { outline: 2px dashed var(--sk-accent,#4f7cff); outline-offset: 1px; }
      .barline.over b { color: var(--sk-danger,#f0616d); }
      .tray { border: 1px dashed var(--sk-border,#3a3d42); border-radius: 5px; padding: 6px; margin: 6px 0; min-height: 30px; touch-action: none; }
      .chip { display: inline-block; margin: 2px; padding: 2px 7px; border-radius: 10px; color: #fff; font-size: 11px; cursor: grab; user-select: none; }
      .ghost-drag { position: fixed; z-index: 99; pointer-events: none; padding: 2px 8px; border-radius: 10px; background: var(--sk-accent,#4f7cff); color: #fff; font-size: 11px; box-shadow: 0 2px 8px rgba(0,0,0,.4); }
      .seltools { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; margin: 4px 0; }
      .icon { background: none; border: none; color: var(--sk-text-dim,#9aa0a6); padding: 0 3px; cursor: pointer; }
    </style>
  </head>
  <body>
    <div id="app"></div>
    <input type="file" id="file-parts" multiple accept=".dxf,.dwg,.svg" style="display:none">
    <input type="file" id="file-csv" accept=".csv,.txt,.tsv" style="display:none">
    <input type="file" id="file-job" accept=".sketchor-nest,.json" style="display:none">
    <input type="file" id="file-machine" accept=".sketchor-machine,.json" style="display:none">
    <script>
      const post = (m) => parent.postMessage({ pluginMessage: m }, "*");
      const $ = (id) => document.getElementById(id);
      // Single quotes too: almost every attribute below is written value='...', so a name with an apostrophe would otherwise end it.
      const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

      // All user-visible strings in one table so translations can be added later.
      const T = {
        material: "Material", materials: { al5052: "Aluminium 5052", al6061: "Aluminium 6061", ss: "Stainless steel", cs: "Carbon steel", plastic: "Plastic", plywood: "Plywood", stone: "Stone", quartz: "Quartz" },
        sheet: "Sheet", standard: "Standard sheet", stock: "Stock on hand", addSize: "+ size", removeSize: "Remove size", addRow: "+ Add row", buyExtra: "Also buy extra sheets of the standard size",
        thickness: "Thickness", gauge: "Gauge...", machine: "Machine", machines: { laser: "Laser", waterjet: "Waterjet", router: "CNC router", other: "Other" },
        engine: "Engine", raster: "Raster (fast)", trueShape: "True shape (exact)",
        engineHint: "Raster: default - fast, handles any quantity. True shape: pick for few large parts with tight kerf, or when you need exact clearance or mirroring.",
        cutting: "Cutting parameters", estimate: "Estimates - set your machine's values.", kerf: "Kerf", web: "Web (gap)", margin: "Edge margin", clamp: "Clamp strip", bedW: "Bed width", bedH: "Bed height", speeds: "Cutting speeds", speedsHint: "For the cutting-time estimate and the G-code feed. Leave blank to use the built-in laser estimate shown in grey.", feed: "Feed rate (per min)", rapid: "Rapid (per min)", pierce: "Pierce time (s)",
        accuracy: "Accuracy", acc: { fast: "Fast", normal: "Normal", precise: "Precise" }, time: "Optimise for", times: { 0: "First result", 10000: "10 s", 30000: "30 s", 120000: "2 min" },
        units: "Display units", unitNames: { in: "Inches (fractions)", indec: "Inches (decimal)", ftin: "Feet-inches", mm: "mm", cm: "cm", m: "m" },
        trueOpts: "True shape options", gravity: "Gravity", minHole: "Min hole size", tabCount: "Tabs per contour", prio: { high: "High priority", normal: "Normal", low: "Low priority" }, due: "Due", prioHint: "High-priority and earlier-due parts are nested first, so they land on the first sheets - and are the last left out when the stock runs out.", commonLine: "Common-line cutting", commonHint: "Parts are nested one kerf apart (the web gap is ignored) and an edge two parts share is cut once - less cutting, fewer pierces. Works best with the True shape engine and parts with straight edges. In manual nesting, keep parts one kerf apart for their edges to be shared.", leadIn: "Lead-in", leadIns: { line: "Straight", arc: "Arc (tangent)" }, tabWidth: "Tab width", gcodeOpts: "G-code", post: "Post-processor", postEdit: "Edit...", postDelete: "Delete", postEditOwn: "Edit post-processor", postEditCopy: "New post-processor (a copy you can change)", postName: "Name", postOn: "Beam on", postOff: "Beam off", postEnd: "Program end", postHeader: "Header lines (one per line)", postDwell: "Pierce dwell", postComments: "Comments", postSave: "Save", postSaveCopy: "Save as my post-processor", postCancel: "Cancel", search: "Search", searches: { quick: "Quick", normal: "Normal", thorough: "Thorough" },
        grav: { "bottom-left": "Bottom-left", "bottom-right": "Bottom-right", "top-left": "Top-left", "top-right": "Top-right" },
        parts: "Parts", addSelection: "+ Add selection", addFiles: "+ Add files", noParts: "No parts yet - select closed shapes and click Add selection, or add DXF/DWG files.",
        qty: "Qty", rot: { none: "No rotation", flip: "0 / 180", r90: "Every 90", r45: "Every 45", r30: "Every 30", r15: "Every 15", r10: "Every 10", free: "Any angle" },
        holes: "holes", mirror: "Mirror", inHoles: "In holes", fileUnit: "File units", fileUnits: { "": "As in file", 1: "inch", 4: "mm", 5: "cm", 6: "m", 2: "foot" },
        calculate: "Calculate", stop: "Stop", clear: "Clear", check: "Check nest", saveJob: "Save job", openJob: "Open job",
        fillIn: "Fill in the orange fields", ready: "Ready to calculate", gone: "Drawing no longer found", bedWarn: "The sheet is larger than the machine bed.",
        results: "Results", kpi: { sheets: "Sheets", sheetsUsed: "Sheets used", toBuy: "To purchase", util: "Utilisation", placed: "Parts placed", cut: "Cut length", pierce: "Pierces", time: "Cut time (est.)" },
        stockUsage: "Stock usage", offcuts: "Usable offcuts", saveOffcuts: "Save offcuts as stock", notPlaced: "Not placed", dxf: "DXF", allZip: "All as ZIP", gcode: "G-code", toolpath: "Toolpath", toolpathTip: "Open the cut order, pierces and rapids for this sheet in a new tab",
        manual: "Manual", groupsMode: "Multi-material (list / CSV)", bomHint: "Load a CSV or paste the parts list here: Part, Qty, Material, Thickness (optional: Rotation, Priority, Due, Sheet)...", loadCsv: "Load CSV...", addDrawings: "Add drawings...", chooseFolder: "Choose folder", makeGroups: "Groups from the list",
        csvHint: "One group per material + thickness, each nested on its own sheets with its own kerf - one Calculate covers every thickness. Part names are looked up as DXF files in the folder, then in the added drawings.",
        noFolder: "No drawing folder chosen and no drawings added - part numbers are looked up as DXF files.", added: "added drawing(s)", noGroups: "No groups yet - load a CSV (or paste a parts list) and click Groups from the list.", group: "Group", of: "of",
        kerfGroup: "Kerf", kerfFrom: { group: "this group's own", machine: "from the machine file", job: "the job's kerf" },
        credit: "Nesting engine based on the Sheet Nesting Calculator by Oleksandr Borenko",
        tabs: { sheets: "Sheets", tubes: "Tubes", bars: "Bars", offcuts: "Offcuts", machines: "Machines" },
        useOffcuts: "Cut from matching offcuts first", useOffcutsHint: "Offcuts in the library of this material and thickness are used before a fresh sheet - largest first. Manage them on the Offcuts tab.", offcutsAvail: "in the library", offcutsUsed: "Offcuts used from the library", newOffcuts: "New usable offcuts", updateLib: "Update offcut library", updateLibHint: "Takes the offcuts this nest used out of the library, adds its new offcuts, and takes the stock-on-hand sheets it used off the stock list. Do this once the sheets are cut.", libUpdated: "Offcut library updated.",
        libHint: "Offcuts kept from earlier jobs, by material and thickness. Sheet Nesting cuts from the matching ones first when the job ticks Cut from matching offcuts first; after cutting, Update offcut library in the results takes the used ones out and adds the new ones.", libEmpty: "No offcuts yet - nest a job and click Update offcut library in the results, or add one here.", libAdd: "Add offcut", libMatch: "matches this job", libHdr: ["Size", "Material", "Thick.", "Qty", "From"],
        dropHere: "Drop DXF / DWG files here - each file is one part",
        machineFile: "Machine file", noMachineFile: "None - use the values below", manageMachines: "Machines...",
      };
      const TT = {
        unit: "Units", units: { in: "inches", ft: "feet", mm: "mm", m: "m" }, kerf: "Kerf (blade / beam)", trim: "End trim (squaring cut)", tail: "Tail (unusable drop)",
        stock: "Stock lengths", stockHdr: ["Length", "Qty on hand", "Cost / bar"], addStock: "+ length", cuts: "Lengths to cut", cutsHdr: ["Label", "Length", "Qty"], cutsHdrTube: ["Label", "Length", "Qty", "&ang;1", "&ang;2", "Extra", "Holes"], angHint: "Mitre angle at each end, degrees from square (0 = square cut). + = long point on the bottom face: 45 and 45 is a frame piece, 45 and -45 a parallelogram. Length = long point to long point.", across: "Mitres across", acrossOpts: { b: "Height", a: "Width" }, turn: "Turn pieces so mitres share a cut", turnHint: "Lets the plan turn a piece end for end or roll it upside down (180 degrees about the tube axis) so neighbouring mitres share one cut - a frame piece nests against the next one with no wedge of waste.", sawCut: "Saw time per cut (s)", sawLoad: "Load per bar (s)", draw: "Draw on canvas", print: "Print report", drawHint: "Open the bars to scale in a new tab", turned: "* turned (see the cut list)", manualHint: "Arrange by hand: drag a piece along its bar to reorder it, onto another bar to move it, or into the To cut tray to take it off. Click a piece to turn it. A bar that gets too long turns red.", manualOn: "Arranged by hand", replan: "Re-plan automatically", update: "Update", toCut: "To cut", toCutEmpty: "Every piece is on a bar - drag one here to take it off.", extra: "More than ordered", addBar: "+ bar", split: "Split one off", removeBar: "Remove bar", endForEnd: "Turn end for end", upsideDown: "Upside down", toTray: "To tray", selected: "Selected", over: "too long by", addCut: "+ row",
        calc: "Calculate", buy: "Get these bars", cutList: "Cut list", notPlaced: "Not placed", remnant: "drop", paste: "Paste list...", pasteHint: "One per line: length, qty, label (tab or comma separated)",
        tube: "Tube / profile", shape: "Shape", shapes: { round: "Round tube / pipe", square: "Square tube", rect: "Rectangular tube", angle: "Angle", channel: "Channel", flat: "Flat bar" }, a: { round: "Outside diameter", other: "Width" }, b: "Height", wall: "Wall", material: "Material",
        machine: "Tube laser", feed: "Feed (per min)", pierce: "Pierce (s)", index: "Index / rotate per cut (s)", load: "Bar load (s)", unload: "Part unload (s)", ppc: "Pierces per cut", fromFile: "from machine file", none: "None - enter values",
        mHint: "One file per machine in the shop. The cut table gives feed, pierce and kerf per material and thickness; the motion values make the time match the machine (acceleration, corner stops, small holes, head lift, sheet loading).",
        mNew: "+ Laser / waterjet", mNewTube: "+ Tube laser", mPreset: "+ Add Amada",
        mPresetHint: "Amada fiber lasers: bed travel, motion and a cut table (feed, pierce, kerf, assist gas) for mild steel, stainless and aluminium, 1-25 mm. Typical starting values, not Amada's data - added as an editable copy, so check it against your machine's cutting conditions. Select it as the Machine file on the Sheets tab: each group's kerf and cut time then come from its thickness.", mCopy: "Duplicate", mDelete: "Delete", mImport: "Import...", mExport: "Export file", mNone: "No machine files yet.",
        mName: "Name", mType: "Type", mTypes: { laser: "Laser", waterjet: "Waterjet", router: "CNC router", other: "Other", tube: "Tube laser" }, mUnits: "Units", mBedW: "Bed width", mBedH: "Bed length",
        mRapid: "Rapid (per min)", mCutAcc: "Cut accel. (per s²)", mRapAcc: "Rapid accel. (per s²)", mLift: "Head up+down / pierce (s)", mCorner: "Corner stop above (°)", mSmall: "Small hole below", mSmallPct: "Small hole feed %", mLoad: "Load + unload / sheet (min)",
        mRows: "Cut table", mRowsHdr: ["Material", "Thick.", "Feed/min", "Pierce s", "Kerf", "Note"], mAddRow: "+ row",
      };
      const ROT_KEYS = ["none", "flip", "r90", "r45", "r30", "r15", "r10", "free"];

      let V = null; // last view from the plugin
      let R = null; // last result
      let progress = null;
      let message = null;
      let customOpen = false;
      let cuttingOpen = false; // the Cutting parameters <details> stays as the user left it across re-renders
      let postDraft = null; // N-42: the post-processor being edited, or null; kept here so a re-render doesn't lose typing
      let M = null; // manual nesting: the last read of the layout tab (overlaps, parts still to nest)

      function optionsHtml(map, sel, keys) {
        return (keys || Object.keys(map)).map((k) => "<option value='" + esc(k) + "'" + (String(k) === String(sel) ? " selected" : "") + ">" + esc(map[k]) + "</option>").join("");
      }
      function reason(opt) {
        const u = V && V.unsupported ? V.unsupported.find((x) => x.option === opt) : null;
        return u ? u.reason : "";
      }
      const isRaster = () => V && V.job.engine === "raster";
      const RASTER_ONLY_NA = {
        gravity: "Raster nesting always fills from the sheet's start edge; gravity is a True shape option.",
        minHole: "Raster nesting fills every hole large enough automatically; the minimum hole size is a True shape option.",
        search: "Raster nesting uses the optimisation time above; Search level is a True shape option.",
        mirror: "The raster engine does not mirror parts; use True shape.",
        inHoles: "Raster nesting fills holes automatically.",
        accuracy: "Accuracy applies to the raster engine only (True shape is exact).",
        time: "True shape uses its Search level instead of a time budget.",
      };
      function lenField(id, label, f, st, extraAttr) {
        const units = ["in", "mm", "cm", "m", "ft"].map((u) => "<option" + (f.u === u ? " selected" : "") + ">" + u + "</option>").join("");
        return "<label class='fld'><span class='t'>" + esc(label) + "</span><span class='lf'>" +
          "<input data-id='" + id + "' data-len='" + id + "' class='st-" + (st || "ok") + "' value='" + esc(f.v) + "'" + (extraAttr || "") + ">" +
          "<select data-id='" + id + "-u' data-lenu='" + id + "'" + (extraAttr || "") + ">" + units + "</select></span></label>";
      }

      const MM_PER_UNIT = { in: 25.4, mm: 1, cm: 10, m: 1000, ft: 304.8 };
      /** A machine speed (length per minute): blank shows the built-in estimate, converted to the field's own unit, in grey. */
      function speedField(id, label, f, autoMm) {
        const fld = f || { v: "", u: V.bareUnit || "in" };
        const k = MM_PER_UNIT[fld.u] || 25.4;
        const v = autoMm > 0 ? autoMm / k : 0;
        const ph = v > 0 ? String(v >= 100 ? Math.round(v) : Math.round(v * 10) / 10) : "";
        return lenField(id, label, fld, "ok", ph ? " placeholder='" + ph + "'" : "");
      }

      function thumb(pts) {
        if (!pts || pts.length < 3) return "";
        const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
        const minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs), minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
        const w = Math.max(maxX - minX, 1e-6), h = Math.max(maxY - minY, 1e-6), m = Math.max(w, h) * 0.06;
        const d = pts.map((p) => (p[0] - minX) + "," + (maxY - p[1])).join(" ");
        return "<svg viewBox='" + (-m) + " " + (-m) + " " + (w + 2 * m) + " " + (h + 2 * m) + "' preserveAspectRatio='xMidYMid meet'><polygon points='" + d + "' fill='none' stroke='#8ab4f8' stroke-width='" + (Math.max(w, h) / 18) + "'/></svg>";
      }

      function jobCard() {
        const j = V.job, st = V.status;
        let h = "<div class='card'><h4>Job</h4>";
        if (j.mode === "manual") {
        h += "<label class='fld'><span class='t'>" + T.material + "</span><select data-id='material' data-set='material'>" + optionsHtml(T.materials, j.material, V.materials) + "</select></label>";
        h += "<div class='seg'><button data-act='source' data-v='standard' class='" + (j.sheetSource === "standard" ? "on" : "") + "'>" + T.standard + "</button><button data-act='source' data-v='stock' class='" + (j.sheetSource === "stock" ? "on" : "") + "'>" + T.stock + "</button></div>";
        const sheetSel = V.sheetOptions.map((s, i) => "<option value='" + i + "'" + (Math.abs(s.w - j.sheet.w) < 1e-6 && Math.abs(s.h - j.sheet.h) < 1e-6 ? " selected" : "") + ">" + esc(s.label) + (s.custom ? " *" : "") + "</option>").join("");
        const curCustom = V.sheetOptions.some((s) => s.custom && Math.abs(s.w - j.sheet.w) < 1e-6 && Math.abs(s.h - j.sheet.h) < 1e-6);
        h += "<label class='fld'><span class='t'>" + (j.sheetSource === "stock" ? "Standard size (for buying extra)" : T.sheet) + "</span><span class='lf'><select data-id='sheet' data-sheet='1'>" + sheetSel + "</select>" +
          "<button class='ghost sm' data-act='custom-toggle' title='Add a custom sheet size'>" + T.addSize + "</button>" + (curCustom ? "<button class='ghost sm' data-act='custom-remove' title='" + T.removeSize + "'>&#10005;</button>" : "") + "</span></label>";
        if (customOpen) {
          h += "<div class='row tight' style='margin-bottom:6px'><input data-id='cw' placeholder='W' style='flex:1'><input data-id='ch' placeholder='H' style='flex:1'><span class='muted'>" + esc(V.bareUnit) + "</span><button class='sm' data-act='custom-add'>Add</button></div>";
        }
        if (j.sheetSource === "stock") {
          h += "<div class='muted' style='font-size:10px'>Name / W / H (" + esc(V.bareUnit) + ") / Qty</div>";
          h += V.stockRows.map((r, i) => "<div class='stockrow' data-row='" + i + "'><input data-id='sn" + i + "' data-stock='name' value='" + esc(r.name) + "'><input data-id='sw" + i + "' data-stock='w' value='" + esc(r.w) + "'><input data-id='sh" + i + "' data-stock='h' value='" + esc(r.h) + "'><input data-id='sq" + i + "' data-stock='qty' value='" + esc(r.qty) + "' placeholder='&infin;'><button class='icon' data-act='stock-del' data-i='" + i + "'>&#10005;</button></div>").join("");
          h += "<div class='row'><button class='ghost sm' data-act='stock-add'>" + T.addRow + "</button><label style='margin:0'><input type='checkbox' data-set='buyExtra'" + (j.buyExtra ? " checked" : "") + ">" + T.buyExtra + "</label></div>";
        }
        {
          const avail = (V.library || []).filter((r) => r.match).reduce((n, r) => n + r.qty, 0);
          h += "<label style='display:block;margin:2px 0 6px' title='" + esc(T.useOffcutsHint) + "'><input type='checkbox' data-set='useRemnants'" + (j.useRemnants ? " checked" : "") + ">" + T.useOffcuts + " <span class='muted'>(" + avail + " " + T.offcutsAvail + ")</span></label>";
        }
        if (V.bedWarn) h += "<div class='msg warn'>" + T.bedWarn + "</div>";
        }
        if (j.mode === "manual") {
          const gauges = "<option value=''>" + T.gauge + "</option>" + V.thicknessOptions.map((o) => "<option value='" + esc(o.value) + "'>" + esc(o.label) + "</option>").join("");
          h += lenField("thickness", T.thickness, j.thickness, st.thickness) ;
          h = h.replace(/<\/span><\/label>$/, "</span></label>");
          h += "<label class='fld' style='margin-top:-2px'><select data-id='gauge' data-gauge='1'>" + gauges + "</select></label>";
        }
        h += "<div class='grid2'><label class='fld'><span class='t'>" + T.machine + "</span><select data-id='machine' data-set='machine'>" + optionsHtml(T.machines, j.machine) + "</select></label>";
        h += "<label class='fld'><span class='t'>" + T.engine + "</span><select data-id='engine' data-set='engine'><option value='raster'" + (j.engine === "raster" ? " selected" : "") + ">" + T.raster + "</option><option value='true-shape'" + (j.engine === "true-shape" ? " selected" : "") + ">" + T.trueShape + "</option></select></label></div>";
        const sheetProfiles = (V.profiles || []).filter((p) => p.type !== "tube");
        h += "<label class='fld'><span class='t'>" + T.machineFile + "</span><span class='lf'><select data-id='profileId' data-set='profileId' style='flex:1;min-width:0'><option value=''>" + T.noMachineFile + "</option>" +
          sheetProfiles.map((p) => "<option value='" + esc(p.id) + "'" + (p.id === V.profileId ? " selected" : "") + ">" + esc(p.name) + "</option>").join("") + "</select><button class='ghost sm' data-act='tab' data-v='machines'>" + T.manageMachines + "</button></span></label>";
        h += (V.engineHint && V.engineHint.length ? V.engineHint : [T.engineHint]).map((l, i) => "<div class='muted' style='font-size:10px" + (i > 0 ? ";color:var(--sk-warn,#e0a030)" : "") + "'>" + esc(l) + "</div>").join("");
        return h + "</div>";
      }

      function cuttingCard() {
        const j = V.job, st = V.status, p = j.params, ras = isRaster();
        let h = "<details class='card' data-cutting='1'" + (cuttingOpen || postDraft ? " open" : "") + "><summary>" + T.cutting + "</summary><div class='muted' style='font-size:10px;margin-bottom:4px'>" + T.estimate + "</div><div class='grid2'>";
        h += lenField("kerf", j.machine === "router" ? "Bit diameter (kerf)" : T.kerf, p.kerf, st.kerf);
        h += lenField("web", T.web, p.web, st.web);
        h += lenField("margin", T.margin, p.margin, st.margin);
        if (j.machine === "laser") h += lenField("clamp", T.clamp, p.clamp, st.clamp);
        h += lenField("bedW", T.bedW, p.bedW, st.bedW);
        h += lenField("bedH", T.bedH, p.bedH, st.bedH);
        const fromFile = !!(V.profileId && V.speedAuto && V.speedAuto.profile);
        const sa = V.speedAuto || {};
        h += "</div><h4 style='margin-top:6px'>" + T.speeds + "</h4><div class='muted' style='font-size:10px;margin-bottom:4px" + (fromFile ? ";opacity:1;color:#4f9d69" : "") + "'>" + esc(fromFile ? sa.profile : sa.none ? sa.none : T.speedsHint) + "</div><div class='grid2'>";
        const dis = fromFile ? " disabled" : "";
        h += fromFile ? speedField("feed", T.feed, { v: "", u: (p.feed || {}).u || V.bareUnit || "in" }, sa.feedMm).replace(/<input /, "<input disabled ").replace(/<select /, "<select disabled ") : speedField("feed", T.feed, p.feed, sa.feedMm || 0);
        h += fromFile ? speedField("rapid", T.rapid, { v: "", u: (p.rapid || {}).u || V.bareUnit || "in" }, sa.rapidMm).replace(/<input /, "<input disabled ").replace(/<select /, "<select disabled ") : speedField("rapid", T.rapid, p.rapid, sa.rapidMm || 0);
        h += "<label class='fld'><span class='t'>" + T.pierce + "</span><input data-id='pierce' data-pierce='1' value='" + (fromFile ? "" : esc(p.pierce || "")) + "' placeholder='" + esc(sa.pierce || "") + "'" + dis + "></label>";
        h += "</div><div class='grid2'>";
        h += "<label class='fld' title='" + esc(ras ? "" : RASTER_ONLY_NA.accuracy) + "'><span class='t'>" + T.accuracy + "</span><select data-id='accuracy' data-set='accuracy'" + (ras ? "" : " disabled") + ">" + optionsHtml(T.acc, j.accuracy) + "</select></label>";
        h += "<label class='fld' title='" + esc(ras ? "" : RASTER_ONLY_NA.time) + "'><span class='t'>" + T.time + "</span><select data-id='timeMs' data-set='timeMs'" + (ras ? "" : " disabled") + ">" + optionsHtml(T.times, j.timeMs, [0, 10000, 30000, 120000]) + "</select></label>";
        h += "<label class='fld'><span class='t'>" + T.units + "</span><select data-id='outputUnit' data-set='outputUnit'>" + optionsHtml(T.unitNames, j.outputUnit) + "</select></label></div>";
        h += "<h4 style='margin-top:6px'>" + T.trueOpts + "</h4><div class='grid2'>";
        h += "<label class='fld' title='" + esc(ras ? RASTER_ONLY_NA.gravity : "") + "'><span class='t'>" + T.gravity + "</span><select data-id='gravity' data-set='gravity'" + (ras ? " disabled" : "") + ">" + optionsHtml(T.grav, j.gravity) + "</select></label>";
        h += "<label class='fld' title='" + esc(ras ? RASTER_ONLY_NA.search : "") + "'><span class='t'>" + T.search + "</span><select data-id='searchLevel' data-set='searchLevel'" + (ras ? " disabled" : "") + ">" + optionsHtml(T.searches, j.searchLevel) + "</select></label>";
        h += "<label class='fld' title='" + esc(ras ? RASTER_ONLY_NA.minHole : "") + "'><span class='t'>" + T.minHole + "</span><input data-id='minHole' data-minhole='1' value='" + esc(j.minHoleArea > 0 ? Math.round(Math.sqrt(j.minHoleArea) * 100) / 100 : "") + "' placeholder='mm'" + (ras ? " disabled" : "") + "></label></div>";
        h += "<h4 style='margin-top:6px'>" + T.gcodeOpts + "</h4><div class='grid2'>";
        const ownPost = (V.posts || []).some((p) => p.id === V.postId && p.custom);
        h += "<label class='fld' style='grid-column:1/-1'><span class='t'>" + T.post + "</span><span class='lf'><select data-id='postId' data-set='postId' style='flex:1;min-width:0'>" + (V.posts || []).map((p) => "<option value='" + esc(p.id) + "'" + (p.id === V.postId ? " selected" : "") + ">" + esc(p.name) + "</option>").join("") + "</select>" +
          "<button class='ghost sm' data-act='post-edit'>" + T.postEdit + "</button>" + (ownPost ? "<button class='ghost sm' data-act='post-delete'>" + T.postDelete + "</button>" : "") + "</span></label>";
        if (postDraft) h += "</div>" + postEditor() + "<div class='grid2'>";
        h += "<label class='fld' title='Arc: a quarter circle that joins the edge tangentially - no dwell mark where the cut meets the part. Falls back to straight where it does not fit (small holes) and on contours with tabs.'><span class='t'>" + T.leadIn + "</span><select data-id='leadIn' data-set='leadIn'>" + optionsHtml(T.leadIns, j.leadIn || "line") + "</select></label>";
        h += "<label class='fld' style='grid-column:1/-1' title='" + esc(T.commonHint) + "'><input type='checkbox' data-set='commonLine'" + (j.commonLine ? " checked" : "") + ">" + T.commonLine + "</label>";
        h += "<label class='fld'><span class='t'>" + T.tabCount + "</span><input data-id='tabCount' data-tabs='tabCount' value='" + esc(j.tabCount || "") + "' placeholder='0'></label>";
        h += "<label class='fld'><span class='t'>" + T.tabWidth + "</span><input data-id='tabWidth' data-tabs='tabWidth' value='" + esc(j.tabWidth || "") + "' placeholder='3 mm'></label></div>";
        return h + "</details>";
      }

      /** N-42: edits a copy of the selected post-processor (a built-in) or the user's own one in place. */
      function postEditor() {
        const d = postDraft, own = (V.posts || []).some((p) => p.id === d.id && p.custom);
        const field = (k, label) => "<label class='fld'><span class='t'>" + label + "</span><input data-id='pe-" + k + "' data-pe='" + k + "' value='" + esc(d[k]) + "'></label>";
        const opt = (k, v, label) => "<option value='" + v + "'" + (d[k] === v ? " selected" : "") + ">" + label + "</option>";
        let h = "<div class='card' style='margin:6px 0'><h4>" + (own ? T.postEditOwn : T.postEditCopy) + "</h4><div class='grid2'>";
        h += "<label class='fld' style='grid-column:1/-1'><span class='t'>" + T.postName + "</span><input data-id='pe-name' data-pe='name' value='" + esc(d.name) + "'></label>";
        h += field("on", T.postOn) + field("off", T.postOff);
        h += "<label class='fld'><span class='t'>" + T.postDwell + "</span><select data-pe='dwellUnit'>" + opt("dwellUnit", "s", "G4 P seconds") + opt("dwellUnit", "ms", "G4 P milliseconds") + "</select></label>";
        h += "<label class='fld'><span class='t'>" + T.postComments + "</span><select data-pe='comments'>" + opt("comments", "paren", "(comment)") + opt("comments", "semicolon", "; comment") + "</select></label>";
        h += "<label class='fld' style='grid-column:1/-1'><span class='t'>" + T.postHeader + "</span><textarea data-id='pe-header' data-pe='header' rows='3' style='width:100%;resize:vertical;background:var(--sk-bg,#1e1f22);color:inherit;border:1px solid var(--sk-border,#3a3d42);border-radius:4px'>" + esc(d.header) + "</textarea></label>";
        h += field("end", T.postEnd) + "</div>";
        return h + "<div class='row' style='margin-top:6px'><button data-act='post-save'>" + (own ? T.postSave : T.postSaveCopy) + "</button><button class='ghost' data-act='post-cancel'>" + T.postCancel + "</button></div></div>";
      }

      function partsCard() {
        const j = V.job;
        let h = "<div class='card' data-drop='parts'><h4>" + T.parts + "</h4><div class='row' style='margin-bottom:6px'><button data-act='add-selection'>" + T.addSelection + "</button><button class='ghost' data-act='add-files'>" + T.addFiles + "</button><span class='muted' id='sel-hint'></span></div>";
        h += "<div class='drop'>" + T.dropHere + "</div>";
        if (V.missing > 0) h += "<div class='msg warn'>" + V.missing + " part(s): " + T.gone + "</div>";
        if (V.parts.length === 0) h += "<div class='muted'>" + T.noParts + "</div>";
        h += V.parts.map((p) => {
          if (p.missing) return "<div class='part gone'><div class='thumb'></div><div><div class='pname'>" + esc(p.name) + "</div><div class='pwarn'>" + T.gone + "</div></div><button class='icon' data-act='remove' data-k='" + esc(p.key) + "'>&#10005;</button></div>";
          const k = esc(p.key);
          const rots = ROT_KEYS.map((c) => "<option value='" + c + "'" + (p.rotation === c ? " selected" : "") + (c === "flip" && reason("flip") ? " title='" + esc(reason("flip")) + "'" : "") + ">" + T.rot[c] + "</option>").join("");
          let extra = "";
          if (!isRaster()) {
            extra = "<label title='" + T.mirror + "' style='margin:0'><input type='checkbox' data-part='" + k + "' data-pset='mirror'" + (p.mirror ? " checked" : "") + ">" + T.mirror + "</label> <label title='" + T.inHoles + "' style='margin:0'><input type='checkbox' data-part='" + k + "' data-pset='allowInHoles'" + (p.allowInHoles ? " checked" : "") + ">" + T.inHoles + "</label>";
          }
          const prio = "<select data-part='" + k + "' data-pset='priority' title='" + esc(T.prioHint) + "'" + (p.priority && p.priority !== "normal" ? " class='prio-" + p.priority + "'" : "") + ">" + optionsHtml(T.prio, p.priority || "normal") + "</select>";
          const due = "<label title='" + esc(T.prioHint) + "' style='margin:0'>" + T.due + " <input type='date' data-part='" + k + "' data-pset='due' value='" + esc(p.due || "") + "' style='width:118px'></label>";
          extra = prio + " " + due + (extra ? " " + extra : "");
          let unit = "";
          if (p.file) {
            const cur = p.file.unit == null ? "" : String(p.file.unit);
            unit = "<select data-fileunit='" + esc(p.file.key) + "' title='" + T.fileUnit + "' style='margin-left:3px'>" + optionsHtml(T.fileUnits, cur, ["", "1", "4", "5", "6", "2"]) + "</select>";
          }
          return "<div class='part'><div class='thumb'>" + thumb(p.thumb) + "</div><div style='min-width:0'><div class='pname' title='" + esc(p.name) + "'>" + esc(p.name) + "</div><div class='pdim'>" + esc(p.size) + " &middot; " + p.holes + " " + T.holes + "</div>" +
            (p.notes || []).map((n) => "<div class='pdim'>" + esc(n) + "</div>").join("") + (p.warns || []).map((n) => "<div class='pwarn'>&#9888; " + esc(n) + "</div>").join("") + "</div>" +
            "<button class='icon' data-act='remove' data-k='" + k + "' title='Remove'>&#10005;</button>" +
            "<div class='pctl'><input type='number' min='0' step='1' value='" + p.qty + "' data-id='q" + k + "' data-part='" + k + "' data-pset='qty' title='" + T.qty + "'><select data-part='" + k + "' data-pset='rotation'>" + rots + "</select></div>" +
            (extra || unit ? "<div style='grid-column:2/4' class='row tight'>" + extra + unit + "</div>" : "") + "</div>";
        }).join("");
        return h + "</div>";
      }

      const ITEM_TEXT = { nofolder: "choose a folder or add drawings", missing: "no file found", failed: "file unusable", loading: "reading...", ok: "ok" };
      function bomCard() {
        let h = "<div class='card'><h4>Parts list</h4><div class='muted' style='font-size:10px;margin-bottom:4px'>" + esc(T.csvHint) + "</div><textarea data-id='bom' data-bom='1' rows='5' placeholder='" + esc(T.bomHint) + "' style='width:100%;resize:vertical;background:var(--sk-bg,#1e1f22);color:inherit;border:1px solid var(--sk-border,#3a3d42);border-radius:4px;font:11px monospace;padding:4px'>" + esc(V.bomText) + "</textarea>";
        h += "<div class='row' style='margin:6px 0;flex-wrap:wrap'><button class='ghost sm' data-act='load-csv'>" + T.loadCsv + "</button><button class='ghost sm' data-act='add-drawings'>" + T.addDrawings + "</button><button class='ghost sm' data-act='pick-folder'>" + T.chooseFolder + "</button><button data-act='make-groups'>" + T.makeGroups + "</button></div>";
        const src = [];
        if (V.folder) src.push(esc(V.folder.name) + " - " + V.folder.count + " files" + (V.folder.truncated ? " (list truncated)" : ""));
        if (V.addedDrawings) src.push(V.addedDrawings + " " + T.added);
        h += "<div class='pdim'>" + (src.length ? src.join(" &middot; ") : T.noFolder) + "</div></div>";
        return h;
      }
      function groupsCard() {
        if (!V.groups.length) return "<div class='card'><div class='muted'>" + T.noGroups + "</div></div>";
        return V.groups.map((g, gi) => {
          const sheetSel = g.sheetOptions.map((s, i) => "<option value='" + i + "'" + (Math.abs(s.w - g.sheet.w) < 1e-6 && Math.abs(s.h - g.sheet.h) < 1e-6 ? " selected" : "") + ">" + esc(s.label) + "</option>").join("");
          const gid = esc(g.id);
          let h = "<div class='card'><h4>" + T.group + " " + (gi + 1) + " " + T.of + " " + V.groups.length + "</h4><div class='grid2'>";
          h += "<label class='fld'><span class='t'>" + T.material + "</span><select data-gid='" + gid + "' data-gset='material'>" + optionsHtml(T.materials, g.material, V.materials) + "</select></label>";
          h += "<label class='fld'><span class='t'>" + T.thickness + "</span><span class='lf'><input data-id='gt" + gi + "' data-gid='" + gid + "' data-gthk='1' value='" + esc(g.thickness) + "' style='flex:1;min-width:0'><select data-gid='" + gid + "' data-gset='thicknessUnit' style='width:52px'><option value='in'" + (g.thicknessUnit === "in" ? " selected" : "") + ">in</option><option value='mm'" + (g.thicknessUnit === "mm" ? " selected" : "") + ">mm</option></select></span></label>";
          h += "<label class='fld'><span class='t'>" + T.sheet + "</span><select data-gid='" + gid + "' data-gsheet='1'>" + sheetSel + "</select></label>";
          h += "<label class='fld'><span class='t'>Rotation</span><select data-gid='" + gid + "' data-gset='rotation'>" + optionsHtml(T.rot, g.rotation, ROT_KEYS) + "</select></label>";
          h += "<label class='fld'><span class='t'>" + T.kerfGroup + " (" + esc(g.kerfUnit) + ")</span><input data-id='gk" + gi + "' data-gid='" + gid + "' data-gkerf='1' value='" + esc(g.kerf) + "' placeholder='" + esc(g.kerfAuto) + "' title='Blank = " + esc(T.kerfFrom[g.kerfFrom === "group" ? "job" : g.kerfFrom]) + "'></label>";
          h += "<div class='pdim' style='grid-column:1/-1'>" + esc(g.label) + " &middot; kerf " + esc(g.kerfAuto) + " (" + esc(T.kerfFrom[g.kerfFrom]) + ")" + (g.machineHint ? "<br>" + esc(g.machineHint) : "") + "</div></div>";
          h += g.items.map((it) => {
            const bad = it.state === "missing" || it.state === "failed" || it.state === "nofolder";
            return "<div class='scard' style='" + (bad ? "color:var(--sk-danger,#f0616d)" : "") + "'><div style='min-width:0'><div class='pname' title='" + esc(it.file || it.num) + "'>" + esc(it.num) + "</div><div class='pdim' style='" + (bad ? "color:inherit" : "") + "'>" +
              esc(ITEM_TEXT[it.state] || it.state) + (it.state === "ok" && it.file ? " - " + esc(it.file) + (it.per > 1 ? " (" + it.per + " per file, " + it.need + " files)" : "") : "") + (it.error ? ": " + esc(it.error) : "") +
              (it.rotation || it.priority || it.due ? " &middot; " + [it.rotation ? esc(T.rot[it.rotation] || it.rotation) : "", it.priority ? esc(it.priority) + " priority" : "", it.due ? "due " + esc(it.due) : ""].filter(Boolean).join(", ") : "") + "</div></div>" +
              "<div class='row tight'><input type='number' min='1' step='1' value='" + it.qty + "' data-id='iq" + gi + esc(it.num) + "' data-gid='" + gid + "' data-inum='" + esc(it.num) + "' style='width:54px;margin:0' title='" + T.qty + "'><button class='icon' data-act='item-remove' data-g='" + gid + "' data-n='" + esc(it.num) + "'>&#10005;</button></div></div>";
          }).join("");
          return h + "</div>";
        }).join("");
      }
      function actionsCard() {
        const run = V.running;
        let h = "<div class='row' style='margin-bottom:6px'>";
        h += "<button class='go" + (V.canCalculate ? "" : " missing") + "' data-act='nest'" + (V.canCalculate ? "" : " disabled") + " style='flex:1'>" + T.calculate + "</button>";
        h += "<button class='warn' data-act='stop'" + (run ? "" : " disabled") + ">" + T.stop + "</button>";
        h += "<button class='ghost' data-act='clear'>" + T.clear + "</button></div>";
        h += "<div class='msg " + (V.canCalculate || run ? "ok" : "warn") + "' style='margin-top:0'>" + (run ? esc(progressText()) : (V.canCalculate ? T.ready : T.fillIn + (V.statusList.length ? ": " + esc(V.statusList.join(", ")) : ""))) + "</div>";
        h += "<div class='row tight' style='margin-bottom:6px'><button class='ghost sm' data-act='check'>" + T.check + "</button><button class='ghost sm' data-act='save-job'>" + T.saveJob + "</button><button class='ghost sm' data-act='open-job'>" + T.openJob + "</button></div>";
        if (message) h += "<div class='msg err'>" + esc(message) + "</div>";
        return h;
      }
      function progressText() {
        if (!progress) return "Starting...";
        const p = progress;
        return (p.runs > 1 ? "Group " + p.run + " of " + p.runs + (p.label ? " (" + p.label + ")" : "") + " - " : "") + "best so far: " + (p.sheets != null ? p.sheets + " sheet(s)" : "...") + (p.unplaced ? ", " + p.unplaced + " not placed" : "") + " - " + (p.ms / 1000).toFixed(1) + " s";
      }

      // NF-08: job name / notes for the printed report, and the autosave folder (kept here so a re-render does not clear them).
      let jobName = "", jobNotes = "", printFolder = null;
      function reportCard() {
        const fl = printFolder && printFolder.supported !== false ? (printFolder.folder ? (printFolder.enabled ? "Copies are filed in: " : "Folder (paused): ") + esc(printFolder.folder) : "No autosave folder chosen.") : "";
        return "<div class='row' style='margin-top:8px'><input data-id='jobname' data-jobname='1' placeholder='Job name (report title)' value='" + esc(jobName) + "'></div><textarea data-id='jobnotes' data-jobnotes='1' rows='2' placeholder='Notes for the report'>" + esc(jobNotes) + "</textarea>" +
          (printFolder && printFolder.supported !== false ? "<div class='row' style='margin-top:4px'><button class='ghost sm' data-act='pick-print-folder'>Autosave folder...</button><span class='pdim'>" + fl + "</span></div>" : "");
      }

      function resultCard() {
        if (!R) return "";
        const k = R.kpis;
        let h = "<div class='card'><h4>" + T.results + "</h4><div class='kpis'>" +
          [[k.sheets, k.showPurchase ? T.kpi.sheets : T.kpi.sheetsUsed]].concat(k.showPurchase ? [[k.toPurchase, T.kpi.toBuy]] : []).concat([[Math.round(k.utilisation * 1000) / 10 + "%", T.kpi.util], [(M ? M.placed + "/" + M.required : k.placed + "/" + k.required), T.kpi.placed], [k.cutLength, T.kpi.cut], [k.pierces, T.kpi.pierce]]).concat(k.cutTime ? [[k.cutTime, T.kpi.time]] : [])
            .map((x) => "<div class='kpi'><b>" + esc(x[0]) + "</b><span>" + x[1] + "</span></div>").join("") + "</div>";
        if (R.unplaced.length && !M) h += "<div class='msg err'>" + T.notPlaced + ": " + R.unplaced.map((u) => esc(u.name) + " &times;" + u.count).join(", ") + "</div>";
        h += manualCard();
        if (R.stopped) h += "<div class='msg warn'>Stopped early - showing the best layout found so far.</div>";
        (R.notes || []).forEach((n) => (h += "<div class='msg warn'>" + esc(n) + "</div>"));
        if ((R.offcutsUsed || []).length) h += "<div class='msg ok'>" + T.offcutsUsed + ": " + R.offcutsUsed.map((o) => esc(o.size) + (o.n > 1 ? " &times;" + o.n : "")).join(", ") + "</div>";
        if ((R.remnants || []).length || (R.offcutsUsed || []).length) h += "<div class='row' style='margin-top:6px'><span class='muted' style='flex:1'>" + ((R.remnants || []).length ? T.newOffcuts + ": " + R.remnants.map((r) => esc(r.size)).join(", ") : "") + "</span><button class='ghost sm' data-act='save-remnants' title='" + esc(T.updateLibHint) + "'>" + T.updateLib + "</button></div>";
        if (R.libraryUpdated) h += "<div class='msg ok'>" + T.libUpdated + "</div>";
        h += "<h4 style='margin-top:6px'>" + T.stockUsage + "</h4><table><tr><th>Size</th><th>Used</th>" + (k.showPurchase ? "<th>Buy</th>" : "") + "<th>In stock</th></tr>" +
          R.stock.map((s) => "<tr><td>" + esc(s.size) + "</td><td>" + s.used + "</td>" + (k.showPurchase ? "<td>" + s.purchased + "</td>" : "") + "<td>" + (s.available == null ? "&infin;" : s.available) + "</td></tr>").join("") + "</table>";
        h += "<h4 style='margin-top:8px'>Sheets</h4>" + R.cards.map((c) =>
          "<div class='scard'><div><b>" + esc(c.title) + "</b>" + (c.count > 1 ? "<span class='qtyb' title='Identical sheets - cut this layout " + c.count + " times'>CUT &times;" + c.count + "</span>" : "") + (c.group ? " <span class='muted'>" + esc(c.group) + "</span>" : "") + "<div class='pdim'>" + esc(c.size) + " &middot; " + c.parts + " parts &middot; " + Math.round(c.utilisation * 100) + "%</div></div>" +
          "<button class='ghost sm' data-act='dxf' data-i='" + c.index + "'>" + T.dxf + "</button></div>").join("");
        h += "<div class='row' style='margin-top:8px'><button class='ghost sm' data-act='dxf-all'>" + T.allZip + "</button><select id='gsheet' style='width:auto;margin:0'>" + R.sheetLabels.map((l, i) => "<option value='" + i + "'>" + esc(l) + "</option>").join("") + "</select><button class='ghost sm' data-act='toolpath' title='" + esc(T.toolpathTip) + "'>" + T.toolpath + "</button><button class='ghost sm' data-act='gcode'>" + T.gcode + "</button><button class='ghost sm' data-act='print'>Print report</button></div>" + reportCard();
        return h + "</div>";
      }

      /** Manual nesting on the layout tab: how to move / turn parts, what is flagged, what is still to nest. */
      function manualCard() {
        let h = "<div class='card' style='margin:6px 0'><h4>Manual nesting</h4><div class='muted' style='font-size:10px;margin-bottom:4px'>On the nest layout tab, click a part to pick up the whole part and drag it - it snaps to the other parts and the sheet edge. Turn it with its round handle (45&deg; steps; hold Ctrl for any angle) or with these buttons. Parts that did not fit wait in the To nest tray below the sheets.</div>";
        h += "<div class='row tight rotrow'><span class='muted'>Rotate selected</span><button class='ghost sm' data-act='rot' data-deg='90' title='90&deg; anticlockwise'>&#8634; 90&deg;</button><button class='ghost sm' data-act='rot' data-deg='-90' title='90&deg; clockwise'>&#8635; 90&deg;</button><button class='ghost sm' data-act='rot' data-deg='45'>&#8634; 45&deg;</button><button class='ghost sm' data-act='rot' data-deg='-45'>&#8635; 45&deg;</button><input data-id='rotdeg' style='width:52px;margin:0' placeholder='deg'><button class='ghost sm' data-act='rot-free' title='Turn by the angle typed (anticlockwise; negative = clockwise)'>Turn</button></div>";
        if (!M) return h + "</div>";
        if (M.red || M.orange) {
          h += "<div class='msg " + (M.red ? "err" : "warn") + "'>" + (M.red ? M.red + " part(s) flagged red - overlapping or off the sheet" : "") + (M.red && M.orange ? "; " : "") + (M.orange ? M.orange + " flagged orange - margin, clamp strip or web gap" : "") + "<ul class='mlist'>" +
            M.issues.map((i) => "<li class='" + (i.tone === "error" ? "err" : "warn") + "'>" + esc(i.label) + "</li>").join("") + (M.more ? "<li>+" + M.more + " more</li>" : "") + "</ul></div>";
        } else {
          h += "<div class='msg ok'>No overlaps - every part on a sheet fits." + (M.moved ? " " + M.moved + " part(s) placed by hand." : "") + "</div>";
        }
        if (M.toNest.length) {
          h += "<div class='msg warn'><b>Still to nest</b>" + M.toNest.map((t) => "<div class='row tight' style='margin-top:3px'><span style='flex:1'>" + esc(t.name) + " &times;" + t.n + (t.waiting ? " <span class='muted'>(" + t.waiting + " in the tray)</span>" : "") + "</span>" +
            (t.waiting < t.n ? "<button class='ghost sm' data-act='tray-add' data-k='" + esc(t.key) + "' data-n='" + (t.n - t.waiting) + "' title='Draw the missing part(s) in the To nest tray so you can drag them onto a sheet'>Put " + (t.n - t.waiting) + " in tray</button>" : "") + "</div>").join("") + "</div>";
        }
        if (M.extra.length) h += "<div class='msg warn'>More than ordered: " + M.extra.map((t) => esc(t.name) + " +" + t.n).join(", ") + "</div>";
        return h + "</div>";
      }

      // ---- NT-02..04: tabs, calculators, machine files ----
      let tab = "sheets";
      let BI = null, TI = null; // calculator drafts (bars, tubes)
      let barRes = null, tubeRes = null;
      let pasteOpen = { bar: false, tube: false };
      let editId = null, MD = null; // machine file being edited
      let mSaveTimer = null;
      let delArm = null;
      const clone = (o) => JSON.parse(JSON.stringify(o));
      const draftOf = (k) => (k === "tube" ? TI : BI);

      function tabsBar() {
        return "<div class='tabs'>" + ["sheets", "tubes", "bars", "offcuts", "machines"].map((k) => "<button data-act='tab' data-v='" + k + "' class='" + (tab === k ? "on" : "") + "'>" + T.tabs[k] + "</button>").join("") + "</div>";
      }
      function inp(attr, v, extra) { return "<input " + attr + " value='" + esc(v) + "'" + (extra || "") + ">"; }

      function calcCommon(k) {
        const D = draftOf(k), tube = k === "tube";
        let h = "<div class='grid2'><label class='fld'><span class='t'>" + TT.unit + "</span><select data-ck='" + k + "' data-cf='unit'>" + optionsHtml(TT.units, D.unit) + "</select></label>";
        h += "<label class='fld'><span class='t'>" + TT.kerf + "</span>" + inp("data-ck='" + k + "' data-cf='kerf' data-id='" + k + "-kerf'", D.kerf) + "</label>";
        h += "<label class='fld'><span class='t'>" + TT.trim + "</span>" + inp("data-ck='" + k + "' data-cf='trim' data-id='" + k + "-trim'", D.trim) + "</label>";
        h += "<label class='fld'><span class='t'>" + TT.tail + "</span>" + inp("data-ck='" + k + "' data-cf='tail' data-id='" + k + "-tail'", D.tail) + "</label></div>";
        h += "<h4 style='margin-top:4px'>" + TT.stock + "</h4><div class='rows hdr' style='grid-template-columns:1fr 70px 70px 18px'>" + TT.stockHdr.map((x) => "<span>" + x + "</span>").join("") + "<span></span></div>";
        h += D.stock.map((r, i) => "<div class='rows' style='grid-template-columns:1fr 70px 70px 18px'>" + inp("data-ck='" + k + "' data-cs='" + i + ":length' data-id='" + k + "s" + i + "l'", r.length) + inp("data-ck='" + k + "' data-cs='" + i + ":qty' data-id='" + k + "s" + i + "q' placeholder='&infin;'", r.qty) + inp("data-ck='" + k + "' data-cs='" + i + ":cost' data-id='" + k + "s" + i + "c'", r.cost) + "<button class='icon' data-act='c-del' data-ck='" + k + "' data-list='stock' data-i='" + i + "'>&#10005;</button></div>").join("");
        h += "<button class='ghost sm' data-act='c-add' data-ck='" + k + "' data-list='stock'>" + TT.addStock + "</button>";
        const cols = tube ? "36px 1fr 34px 30px 30px 42px 30px 16px" : "54px 1fr 54px 18px";
        h += "<h4 style='margin-top:8px'>" + TT.cuts + "</h4><div class='rows hdr' style='grid-template-columns:" + cols + "'>" + (tube ? TT.cutsHdrTube : TT.cutsHdr).map((x) => "<span>" + x + "</span>").join("") + "<span></span></div>";
        h += D.cuts.map((r, i) => "<div class='rows' style='grid-template-columns:" + cols + "'>" + inp("data-ck='" + k + "' data-cc='" + i + ":label' data-id='" + k + "c" + i + "a'", r.label) + inp("data-ck='" + k + "' data-cc='" + i + ":length' data-id='" + k + "c" + i + "l'", r.length) + inp("data-ck='" + k + "' data-cc='" + i + ":qty' data-id='" + k + "c" + i + "q'", r.qty) +
          (tube ? inp("data-ck='" + k + "' data-cc='" + i + ":a1' data-id='" + k + "c" + i + "a1' placeholder='0' title='" + esc(TT.angHint) + "'", r.a1 || "") + inp("data-ck='" + k + "' data-cc='" + i + ":a2' data-id='" + k + "c" + i + "a2' placeholder='0' title='" + esc(TT.angHint) + "'", r.a2 || "") + inp("data-ck='" + k + "' data-cc='" + i + ":extraCut' data-id='" + k + "c" + i + "e' title='Extra cut length per piece (holes, slots, copes)'", r.extraCut || "") + inp("data-ck='" + k + "' data-cc='" + i + ":extraPierces' data-id='" + k + "c" + i + "p' title='Extra pierces per piece (one per hole)'", r.extraPierces || "") : "") +
          "<button class='icon' data-act='c-del' data-ck='" + k + "' data-list='cuts' data-i='" + i + "'>&#10005;</button></div>").join("");
        h += "<div class='row'><button class='ghost sm' data-act='c-add' data-ck='" + k + "' data-list='cuts'>" + TT.addCut + "</button><button class='ghost sm' data-act='c-paste' data-ck='" + k + "'>" + TT.paste + "</button></div>";
        if (pasteOpen[k]) h += "<textarea data-id='" + k + "-paste' data-paste='" + k + "' rows='4' placeholder='" + esc(TT.pasteHint) + "' style='width:100%;margin-top:4px;background:var(--sk-bg,#1e1f22);color:inherit;border:1px solid var(--sk-border,#3a3d42);border-radius:4px;font:11px monospace'></textarea><button class='sm' data-act='c-paste-apply' data-ck='" + k + "'>Add lines</button>";
        return h;
      }
      const BAR_COLORS = ["#4f7cff", "#3f8f5c", "#e0912f", "#a35bd6", "#d6536d", "#2aa3b5", "#8a8f3a", "#c26a3a"];
      /** One bar pattern from the side: stock, trim, each piece (a mitred one as a trapezoid), the drop. */
      function barSvg(d, labels, pat, kind) {
        if (!d || !(d.stock > 0)) return "";
        // Scaled to the bar - or past it when the pieces overrun it (the overrun shows red).
        const span = Math.max(d.stock, d.used + d.tail);
        const W = 1000, H = d.depth > 0 ? Math.max(40, Math.min(120, d.depth * W / span * 4)) : 40;
        const sx = W / span;
        const X = (v) => (v * sx).toFixed(1);
        const yb = H + 2, yt = 2;
        let g = "<rect x='0' y='2' width='" + X(d.stock) + "' height='" + H + "' fill='rgba(127,127,127,.12)' stroke='#888' stroke-width='1.5'/>";
        if (span > d.stock + 1e-6) g += "<rect x='" + X(d.stock) + "' y='2' width='" + X(span - d.stock) + "' height='" + H + "' fill='rgba(240,97,109,.35)' stroke='#f0616d' stroke-width='1.5'/>";
        if (d.trim > 0) g += "<rect x='0' y='2' width='" + X(d.trim) + "' height='" + H + "' fill='rgba(127,127,127,.45)'/>";
        if (d.tail > 0) g += "<rect x='" + X(d.stock - d.tail) + "' y='2' width='" + X(d.tail) + "' height='" + H + "' fill='rgba(127,127,127,.45)'/>";
        d.pieces.forEach((p, pi) => {
          const ci = Math.max(0, labels.indexOf(p.label)) % BAR_COLORS.length;
          const l1 = d.depth > 0 ? p.l1 : p.l0, r1 = d.depth > 0 ? p.r1 : p.r0;
          const isSel = sel && sel.k === kind && sel.pat === pat && sel.pi === pi;
          g += "<polygon data-ck='" + kind + "' data-pat='" + pat + "' data-pi='" + pi + "'" + (isSel ? " class='sel'" : "") + " points='" + X(p.l0) + "," + yb + " " + X(p.r0) + "," + yb + " " + X(r1) + "," + yt + " " + X(l1) + "," + yt + "' fill='" + BAR_COLORS[ci] + "' fill-opacity='.8' stroke='#fff' stroke-width='1'><title>" + esc(p.label + (p.turned ? " - turned " + p.turned : "")) + "</title></polygon>";
          const w = (Math.min(p.r0, r1) - Math.max(p.l0, l1)) * sx;
          const t = p.label + (p.turned ? "*" : "");
          if (w > t.length * 13 + 4) g += "<text x='" + (((p.l0 + p.r0 + l1 + r1) / 4) * sx).toFixed(1) + "' y='" + (2 + H / 2 + 8) + "' text-anchor='middle' font-size='24' font-weight='600' fill='#fff' pointer-events='none'>" + esc(t) + "</text>";
        });
        return "<svg class='barsvg" + (span > d.stock + 1e-6 ? " over" : "") + "' data-barsvg='" + pat + "' data-ck='" + kind + "' data-span='" + span + "' viewBox='0 0 " + W + " " + (H + 4) + "' preserveAspectRatio='none'>" + g + "</svg>";
      }
      let calcJobName = "";
      let sel = null; // NT-06: the piece clicked on a bar: { k, pat, pi }
      /** Tools for the selected piece: turn it, or put it back in the tray. */
      function selTools(res, kind) {
        if (!sel || sel.k !== kind || !res.bars[sel.pat] || !res.bars[sel.pat].draw.pieces[sel.pi]) return "";
        const p = res.bars[sel.pat].draw.pieces[sel.pi];
        return "<div class='seltools'><span class='muted'>" + TT.selected + ": <b>" + esc(p.label) + "</b>" + (p.turned ? " (" + esc(p.turned) + ")" : "") + "</span><button class='ghost sm' data-act='piece-flip' data-ck='" + kind + "'>" + TT.endForEnd + "</button><button class='ghost sm' data-act='piece-upside' data-ck='" + kind + "'>" + TT.upsideDown + "</button><button class='ghost sm' data-act='piece-tray' data-ck='" + kind + "'>" + TT.toTray + "</button></div>";
      }
      const resOf = (k) => (k === "tube" ? tubeRes : barRes);
      /** The hand layout of a calculator, started from the last result's patterns the first time it is edited. */
      function manualOf(k) {
        const D = draftOf(k), res = resOf(k);
        if (!D.manual && res && res.patterns) D.manual = clone(res.patterns);
        return D.manual;
      }
      function recalc(k) { post({ type: k === "tube" ? "tube-calc" : "bar-calc", input: draftOf(k) }); }
      /** Where on a bar's drawing a drop at clientX lands: the index to insert at, skipping skip (the piece being moved on the same bar). */
      function dropIndex(svg, clientX, k, pat, skip) {
        const res = resOf(k), d = res && res.bars[pat] && res.bars[pat].draw;
        if (!d) return 0;
        const r = svg.getBoundingClientRect();
        const x = ((clientX - r.left) / Math.max(1, r.width)) * Number(svg.dataset.span || d.stock);
        let idx = 0;
        d.pieces.forEach((p, i) => { if (i !== skip && (p.l0 + p.r0) / 2 < x) idx++; });
        return idx;
      }
      // Pointer drag (HTML5 drag-and-drop is unreliable in the sandboxed panel): pieces between bars and the tray.
      let drag = null;
      document.addEventListener("pointerdown", (e) => {
        const pg = e.target.closest && e.target.closest("[data-pi]");
        const chip = e.target.closest && e.target.closest("[data-tray-label]");
        if (!pg && !chip) return;
        e.preventDefault();
        const k = (pg || chip).dataset.ck;
        drag = pg ? { k, pat: Number(pg.dataset.pat), pi: Number(pg.dataset.pi), x0: e.clientX, y0: e.clientY, moved: false, ghost: null, text: (pg.querySelector("title") || {}).textContent || "" }
                  : { k, tray: { label: chip.dataset.trayLabel, length: Number(chip.dataset.trayLen) }, x0: e.clientX, y0: e.clientY, moved: false, ghost: null, text: chip.textContent.replace(/ ×\d+$/, "") };
      });
      const clearTargets = () => document.querySelectorAll(".droptarget").forEach((el) => el.classList.remove("droptarget"));
      const dropTargetAt = (x, y) => {
        const el = document.elementFromPoint(x, y);
        return el ? el.closest("[data-barsvg]") || el.closest("[data-tray]") : null;
      };
      document.addEventListener("pointermove", (e) => {
        if (!drag) return;
        if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 4) return;
        drag.moved = true;
        if (!drag.ghost) { drag.ghost = document.createElement("div"); drag.ghost.className = "ghost-drag"; drag.ghost.textContent = drag.text; document.body.appendChild(drag.ghost); }
        // Near the panel's top or bottom edge, scroll so a far bar can be reached.
        const edge = 36;
        if (e.clientY < edge) window.scrollBy(0, -12);
        else if (e.clientY > window.innerHeight - edge) window.scrollBy(0, 12);
        drag.ghost.style.left = e.clientX + 10 + "px";
        drag.ghost.style.top = e.clientY + 8 + "px";
        clearTargets();
        const t = dropTargetAt(e.clientX, e.clientY);
        if (t && t.dataset.ck === drag.k) t.classList.add("droptarget");
      });
      document.addEventListener("pointerup", (e) => {
        if (!drag) return;
        const d = drag;
        drag = null;
        if (d.ghost) d.ghost.remove();
        clearTargets();
        if (!d.moved) {
          if (d.tray) return;
          sel = sel && sel.k === d.k && sel.pat === d.pat && sel.pi === d.pi ? null : { k: d.k, pat: d.pat, pi: d.pi };
          render();
          return;
        }
        const t = dropTargetAt(e.clientX, e.clientY);
        if (!t || t.dataset.ck !== d.k) return;
        const M = manualOf(d.k);
        if (!M) return;
        let piece;
        if (d.tray) piece = { label: d.tray.label, length: d.tray.length, flipped: false, upsideDown: false };
        else {
          const src = M.patterns[d.pat];
          if (!src || !src.pieces[d.pi]) return;
          piece = src.pieces[d.pi];
        }
        if (t.dataset.tray !== undefined) {
          if (d.tray) return;
          M.patterns[d.pat].pieces.splice(d.pi, 1);
        } else {
          const to = Number(t.dataset.barsvg);
          if (!M.patterns[to]) return;
          const idx = dropIndex(t, e.clientX, d.k, to, !d.tray && to === d.pat ? d.pi : -1);
          if (!d.tray) M.patterns[d.pat].pieces.splice(d.pi, 1);
          M.patterns[to].pieces.splice(Math.min(idx, M.patterns[to].pieces.length), 0, piece);
        }
        sel = null;
        recalc(d.k);
      });
      function calcResult(res, kind) {
        if (!res) return "";
        let h = "<div class='card'><h4>" + T.results + "</h4>";
        if (res.error) return h + "<div class='msg err'>" + esc(res.error) + "</div></div>";
        h += "<div class='kpis'>" + res.summary.map((x) => "<div class='kpi'><b>" + esc(x[1]) + "</b><span>" + esc(x[0]) + "</span></div>").join("") + "</div>";
        (res.warnings || []).forEach((w) => (h += "<div class='msg warn'>" + esc(w) + "</div>"));
        if (res.unplaced.length && !res.manual) h += "<div class='msg err'>" + TT.notPlaced + ": " + res.unplaced.map(esc).join(", ") + "</div>";
        const hasCost = res.buy.some((b) => b.cost);
        h += "<h4 style='margin-top:6px'>" + TT.buy + "</h4><table><tr><th>Length</th><th>Bars</th>" + (hasCost ? "<th>Cost</th>" : "") + "</tr>" + res.buy.map((b) => "<tr><td>" + esc(b.length) + "</td><td><b>" + b.count + "</b></td>" + (hasCost ? "<td>" + esc(b.cost) + "</td>" : "") + "</tr>").join("") + "</table>";
        const labels = res.labels || [];
        h += "<h4 style='margin-top:8px'>" + TT.cutList + (res.manual ? " <span class='qtyb' style='background:#e0912f'>" + TT.manualOn + "</span>" : "") + "</h4><div class='muted' style='font-size:10px'>" + TT.manualHint + "</div>";
        h += "<div class='tray' data-tray='" + kind + "' data-ck='" + kind + "'><b style='font-size:11px'>" + TT.toCut + "</b> " + ((res.toCut || []).length ? res.toCut.map((t) => "<span class='chip' data-ck='" + kind + "' data-tray-label='" + esc(t.label) + "' data-tray-len='" + t.length + "' style='background:" + BAR_COLORS[Math.max(0, labels.indexOf(t.label)) % BAR_COLORS.length] + "' title='Drag onto a bar'>" + esc(t.text) + " &times;" + t.count + "</span>").join("") : "<span class='muted' style='font-size:10px'>" + TT.toCutEmpty + "</span>") + "</div>";
        h += selTools(res, kind);
        h += res.bars.map((b, i) => "<div class='barline" + (b.over ? " over" : "") + "'><div class='row tight'><b style='flex:1'>" + (i + 1) + ". " + esc(b.stock) + (b.over ? " - " + TT.over + " " + esc(b.over) : "") + "</b>" + (b.count > 1 ? "<span class='qtyb' title='Cut " + b.count + " bars this way'>CUT &times;" + b.count + "</span><button class='icon' data-act='bar-split' data-ck='" + kind + "' data-pat='" + i + "' title='" + TT.split + " - edit one of these bars on its own'>&#9986;</button>" : "") + "<button class='icon' data-act='bar-remove' data-ck='" + kind + "' data-pat='" + i + "' title='" + TT.removeBar + " (its pieces go to the tray)'>&#10005;</button></div>" + (b.time ? "<span class='muted'>" + esc(b.time) + " each</span>" : "") + barSvg(b.draw, labels, i, kind) + "<div>" + esc(b.cuts) + "</div><div class='pdim'>" + TT.remnant + " " + esc(b.remnant) + "</div></div>").join("");
        h += "<div class='row tight' style='margin-top:4px'><select data-id='addbar-" + kind + "' style='width:auto;margin:0'>" + (res.stockMm || []).map((st) => "<option value='" + st.length + "'>" + esc(st.text) + "</option>").join("") + "</select><button class='ghost sm' data-act='bar-add' data-ck='" + kind + "'>" + TT.addBar + "</button></div>";
        if ((res.extra || []).length) h += "<div class='msg warn'>" + TT.extra + ": " + res.extra.map(esc).join(", ") + "</div>";
        if (res.bars.some((b) => b.draw && b.draw.pieces.some((p) => p.turned))) h += "<div class='pdim'>" + TT.turned + "</div>";
        h += "<div class='row' style='margin-top:8px'><input data-id='calcjob' data-calcjob='1' placeholder='Job name (report title)' value='" + esc(calcJobName) + "' style='flex:1'><button class='ghost sm' data-act='calc-draw' data-ck='" + kind + "' title='" + esc(TT.drawHint) + "'>" + TT.draw + "</button><button class='ghost sm' data-act='calc-print' data-ck='" + kind + "'>" + TT.print + "</button></div>";
        return h + "</div>";
      }
      /** Calculate; once pieces were arranged by hand, Update (keeps the layout, picks up edited settings) and Re-plan (discards it). */
      function calcButtons(k) {
        if (!draftOf(k).manual) return "<div class='row' style='margin-top:8px'><button class='go' data-act='calc' data-ck='" + k + "' style='flex:1'>" + TT.calc + "</button></div>";
        return "<div class='row' style='margin-top:8px'><button class='go' data-act='calc-update' data-ck='" + k + "' style='flex:1' title='Recalculate with your layout (e.g. after changing kerf or the feed)'>" + TT.update + "</button><button class='warn' data-act='calc' data-ck='" + k + "' title='Throw away the hand layout and plan the bars again'>" + TT.replan + "</button></div>";
      }
      function barsView() {
        return "<div class='card'><h4>" + T.tabs.bars + "</h4><div class='muted' style='font-size:10px;margin-bottom:6px'>Saw or any straight cut: how many bars to buy for a list of lengths, and what to cut from each.</div>" + calcCommon("bar") +
          "<div class='grid2' style='margin-top:6px'><label class='fld'><span class='t'>" + TT.sawCut + "</span>" + inp("data-ck='bar' data-cf='cutSec' data-id='bar-cutsec' placeholder='-'", BI.cutSec || "") + "</label><label class='fld'><span class='t'>" + TT.sawLoad + "</span>" + inp("data-ck='bar' data-cf='loadSec' data-id='bar-loadsec' placeholder='0'", BI.loadSec || "") + "</label></div>" +
          calcButtons("bar") + "</div>" + calcResult(barRes, "bar");
      }
      function tubesView() {
        const D = TI, tubeProfiles = (V.profiles || []).filter((p) => p.type === "tube" || p.type === "laser");
        let h = "<div class='card'><h4>" + TT.tube + "</h4><div class='grid2'>";
        h += "<label class='fld' style='grid-column:1/-1'><span class='t'>" + TT.shape + "</span><select data-ck='tube' data-cf='shape' data-rerender='1'>" + optionsHtml(TT.shapes, D.shape) + "</select></label>";
        h += "<label class='fld'><span class='t'>" + (D.shape === "round" ? TT.a.round : TT.a.other) + "</span>" + inp("data-ck='tube' data-cf='a' data-id='t-a'", D.a) + "</label>";
        if (D.shape === "rect" || D.shape === "angle" || D.shape === "channel") h += "<label class='fld'><span class='t'>" + TT.b + "</span>" + inp("data-ck='tube' data-cf='b' data-id='t-b'", D.b) + "</label>";
        h += "<label class='fld'><span class='t'>" + TT.wall + "</span>" + inp("data-ck='tube' data-cf='wall' data-id='t-w'", D.wall) + "</label>";
        h += "<label class='fld'><span class='t'>" + TT.material + "</span><select data-ck='tube' data-cf='material'>" + optionsHtml(T.materials, D.material, V.materials) + "</select></label>";
        h += "<label class='fld'><span class='t'>" + TT.across + "</span><select data-ck='tube' data-cf='across'>" + optionsHtml(TT.acrossOpts, D.across || "b") + "</select></label></div>";
        h += "<label style='display:block;margin:0 0 4px' title='" + esc(TT.turnHint) + "'><input type='checkbox' data-ck='tube' data-cf='turn'" + (D.turn !== false ? " checked" : "") + ">" + TT.turn + "</label>";
        h += "<h4 style='margin-top:4px'>" + TT.machine + "</h4><label class='fld'><span class='lf'><select data-ck='tube' data-cf='profileId' data-rerender='1' style='flex:1;min-width:0'><option value=''>" + TT.none + "</option>" + tubeProfiles.map((p) => "<option value='" + esc(p.id) + "'" + (p.id === D.profileId ? " selected" : "") + ">" + esc(p.name) + "</option>").join("") + "</select><button class='ghost sm' data-act='tab' data-v='machines'>" + T.manageMachines + "</button></span></label>";
        const ph = D.profileId ? " placeholder='" + TT.fromFile + "'" : "";
        h += "<div class='grid2'>";
        h += "<label class='fld'><span class='t'>" + TT.feed + " (" + esc(TT.units[D.unit]) + ")</span>" + inp("data-ck='tube' data-cf='feed' data-id='t-feed'", D.feed, ph) + "</label>";
        h += "<label class='fld'><span class='t'>" + TT.pierce + "</span>" + inp("data-ck='tube' data-cf='pierce' data-id='t-pierce'", D.pierce, ph) + "</label>";
        h += "<label class='fld'><span class='t'>" + TT.index + "</span>" + inp("data-ck='tube' data-cf='index' data-id='t-index'", D.index) + "</label>";
        h += "<label class='fld'><span class='t'>" + TT.load + "</span>" + inp("data-ck='tube' data-cf='load' data-id='t-load'", D.load, ph) + "</label>";
        h += "<label class='fld'><span class='t'>" + TT.unload + "</span>" + inp("data-ck='tube' data-cf='unload' data-id='t-unload'", D.unload) + "</label>";
        h += "<label class='fld'><span class='t'>" + TT.ppc + "</span>" + inp("data-ck='tube' data-cf='piercesPerCut' data-id='t-ppc'", D.piercesPerCut) + "</label></div></div>";
        h += "<div class='card'>" + calcCommon("tube") + calcButtons("tube") + "</div>";
        return h + calcResult(tubeRes, "tube");
      }

      /** N-52: the offcut library - what is on the rack, by material and thickness; add, change the count, remove. */
      function offcutsView() {
        const lib = V.library || [];
        let h = "<div class='card'><h4>" + T.tabs.offcuts + "</h4><div class='muted' style='font-size:10px;margin-bottom:6px'>" + T.libHint + "</div>";
        h += "<div class='rows hdr' style='grid-template-columns:52px 52px 36px 1fr 52px'><span>W (" + esc(V.bareUnit) + ")</span><span>H</span><span>Qty</span><span>Material</span><span>Thick.</span></div>";
        h += "<div class='rows' style='grid-template-columns:52px 52px 36px 1fr 52px'><input data-id='lib-w' data-libnew='w'><input data-id='lib-h' data-libnew='h'><input data-id='lib-q' data-libnew='qty' placeholder='1'><select data-libnew='material'>" + optionsHtml(T.materials, V.job.material, V.materials) + "</select><input data-id='lib-t' data-libnew='thickness' value='" + esc(V.job.thickness && V.job.thickness.v ? V.job.thickness.v + (V.job.thickness.u && V.job.thickness.u !== V.bareUnit ? " " + V.job.thickness.u : "") : "") + "'></div>";
        h += "<button class='sm' data-act='lib-add'>" + T.libAdd + "</button></div>";
        h += "<div class='card'>";
        if (!lib.length) h += "<div class='muted'>" + T.libEmpty + "</div>";
        else {
          h += "<table><tr>" + T.libHdr.map((x) => "<th>" + x + "</th>").join("") + "<th></th></tr>" + lib.map((r) => "<tr" + (r.match ? " style='background:rgba(79,157,105,.15)' title='" + T.libMatch + "'" : "") + "><td><b>" + esc(r.size) + "</b></td><td>" + esc(r.material) + "</td><td>" + esc(r.thickness) + "</td><td><input type='number' min='0' step='1' value='" + r.qty + "' data-id='libq" + esc(r.id) + "' data-libq='" + esc(r.id) + "' style='width:44px;margin:0;padding:2px'></td><td class='pdim'>" + esc(r.from) + (r.date ? "<br>" + esc(r.date) : "") + "</td><td><button class='icon' data-act='lib-del' data-id='" + esc(r.id) + "'>&#10005;</button></td></tr>").join("") + "</table>";
          const m = lib.filter((r) => r.match).reduce((n, r) => n + r.qty, 0);
          h += "<div class='pdim' style='margin-top:4px'>" + m + " " + T.libMatch + (V.job.useRemnants ? "" : " - tick " + T.useOffcuts + " on the Sheets tab to use them") + "</div>";
        }
        return h + "</div>";
      }

      function machinesView() {
        const list = V.profiles || [];
        let h = "<div class='card'><h4>" + T.tabs.machines + "</h4><div class='muted' style='font-size:10px;margin-bottom:6px'>" + TT.mHint + "</div>";
        h += "<div class='row' style='margin-bottom:6px'><button class='sm' data-act='m-new'>" + TT.mNew + "</button><button class='sm' data-act='m-new' data-kind='tube'>" + TT.mNewTube + "</button><button class='ghost sm' data-act='m-import'>" + TT.mImport + "</button></div>";
        const presets = V.amadaPresets || [];
        if (presets.length) {
          h += "<div class='row' style='margin-bottom:4px'><select data-id='amada-preset' style='flex:1;min-width:0'>" + presets.map((p) => "<option value='" + esc(p.id) + "'>Amada " + esc(p.model) + " - " + esc(p.sheet) + "</option>").join("") + "</select><button class='sm' data-act='m-preset'>" + TT.mPreset + "</button></div>";
          h += "<div class='muted' style='font-size:10px;margin-bottom:6px'>" + TT.mPresetHint + "</div>";
        }
        if (!list.length) h += "<div class='muted'>" + TT.mNone + "</div>";
        h += list.map((p) => "<div class='scard'><div><b>" + esc(p.name) + "</b> <span class='muted'>" + esc(TT.mTypes[p.type] || p.type) + " &middot; " + p.rows.length + " cut rows</span></div><button class='ghost sm' data-act='m-edit' data-mid='" + esc(p.id) + "'>" + (editId === p.id ? "Editing" : "Edit") + "</button></div>").join("");
        h += "</div>";
        if (MD) h += machineEditor();
        return h;
      }
      function machineEditor() {
        const d = MD, u = d.units;
        const f = (k, label, w) => "<label class='fld'" + (w ? " style='grid-column:1/-1'" : "") + "><span class='t'>" + label + "</span>" + inp("data-m='" + k + "' data-id='m-" + k + "'", d[k]) + "</label>";
        let h = "<div class='card'><h4>" + esc(d.name) + "</h4><div class='grid2'>";
        h += f("name", TT.mName, true);
        h += "<label class='fld'><span class='t'>" + TT.mType + "</span><select data-m='type' data-mstruct='1'>" + optionsHtml(TT.mTypes, d.type) + "</select></label>";
        h += "<label class='fld'><span class='t'>" + TT.mUnits + "</span><select data-m='units' data-mstruct='1'><option value='in'" + (u === "in" ? " selected" : "") + ">inches</option><option value='mm'" + (u === "mm" ? " selected" : "") + ">mm</option></select></label>";
        if (d.type !== "tube") h += f("bedW", TT.mBedW + " (" + u + ")") + f("bedH", TT.mBedH + " (" + u + ")");
        h += f("rapid", TT.mRapid + " (" + u + ")") + f("cutAccel", TT.mCutAcc + " (" + u + ")") + f("rapidAccel", TT.mRapAcc + " (" + u + ")") + f("headLift", TT.mLift) + f("cornerAngle", TT.mCorner);
        h += f("smallHole", TT.mSmall + " (" + u + ")") + f("smallHoleFeedPct", TT.mSmallPct) + f("sheetLoadMin", d.type === "tube" ? "Bar load (min)" : TT.mLoad) + "</div>";
        const cols = "70px 46px 54px 42px 44px 1fr 16px";
        h += "<h4 style='margin-top:6px'>" + TT.mRows + " (" + u + ")</h4><div class='rows hdr' style='grid-template-columns:" + cols + "'>" + TT.mRowsHdr.map((x) => "<span>" + x + "</span>").join("") + "<span></span></div>";
        h += d.rows.map((r, i) => "<div class='rows' style='grid-template-columns:" + cols + "'><select data-mr='" + i + ":material'>" + optionsHtml(T.materials, r.material, V.materials) + "</select>" +
          ["thickness", "feed", "pierce", "kerf", "note"].map((k) => inp("data-mr='" + i + ":" + k + "' data-id='mr" + i + k + "'", r[k] == null ? "" : r[k])).join("") + "<button class='icon' data-act='m-row-del' data-i='" + i + "'>&#10005;</button></div>").join("");
        h += "<div class='row' style='margin-top:6px'><button class='ghost sm' data-act='m-row-add'>" + TT.mAddRow + "</button><span style='flex:1'></span><button class='ghost sm' data-act='m-copy'>" + TT.mCopy + "</button><button class='ghost sm' data-act='m-export'>" + TT.mExport + "</button><button class='sm warn' data-act='m-delete'>" + (delArm === d.id ? "Click again to delete" : TT.mDelete) + "</button></div>";
        return h + "</div>";
      }
      const NUM_FIELDS = ["bedW", "bedH", "rapid", "cutAccel", "rapidAccel", "headLift", "cornerAngle", "smallHole", "smallHoleFeedPct", "sheetLoadMin"];
      function mdForSave() {
        const o = clone(MD);
        NUM_FIELDS.forEach((k) => { o[k] = Number(o[k]) || 0; });
        o.rows = o.rows.map((r) => ({ material: r.material, thickness: Number(r.thickness), feed: Number(r.feed), pierce: Number(r.pierce) || 0, kerf: Number(r.kerf) || 0, note: r.note || "" }));
        return o;
      }
      function saveMachine(refresh) { clearTimeout(mSaveTimer); mSaveTimer = null; if (MD) post({ type: "profile-save", profile: mdForSave(), refresh: !!refresh }); }
      function pasteLines(k) {
        const ta = document.querySelector("[data-paste='" + k + "']");
        const D = draftOf(k);
        if (!ta) return;
        const rows = ta.value.split(/\r?\n/).map((l) => l.split(/\t|,|;/).map((x) => x.trim())).filter((c) => c[0]);
        rows.forEach((c) => D.cuts.push({ label: c[2] || "", length: c[0], qty: c[1] || "1", extraCut: "", extraPierces: "" }));
        pasteOpen[k] = false;
        render();
      }
      function readFiles(list) {
        return Promise.all(Array.from(list || []).map(async (f) => {
          try {
            if (/\.dwg$/i.test(f.name)) return { name: f.name, bytes: await f.arrayBuffer() };
            return { name: f.name, text: await f.text() };
          } catch (err) { return { name: f.name, text: "" }; }
        }));
      }

      let focusState = null;
      function render() {
        if (!V) { $("app").innerHTML = "<div class='muted'>Loading...</div>"; return; }
        const a = document.activeElement;
        focusState = a && a.dataset && a.dataset.id ? { id: a.dataset.id, s: a.selectionStart, e: a.selectionEnd } : null;
        V.statusList = Object.keys(V.status).filter((k) => V.status[k] !== "ok").map((k) => ({ thickness: "thickness", kerf: "kerf", web: "web", margin: "margin", clamp: "clamp", bedW: "bed width", bedH: "bed height", parts: V.partsProblem || "parts", sheet: "sheet" }[k] || k));
        const modeBar = "<div class='seg'><button data-act='mode' data-v='manual' class='" + (V.job.mode === "manual" ? "on" : "") + "'>" + T.manual + "</button><button data-act='mode' data-v='groups' class='" + (V.job.mode === "groups" ? "on" : "") + "'>" + T.groupsMode + "</button></div>";
        const body = V.job.mode === "groups" ? bomCard() + groupsCard() : partsCard();
        if (!BI) BI = clone(V.barInput);
        if (!TI) TI = clone(V.tubeInput);
        if (tab === "bars") $("app").innerHTML = tabsBar() + barsView();
        else if (tab === "tubes") $("app").innerHTML = tabsBar() + tubesView();
        else if (tab === "machines") $("app").innerHTML = tabsBar() + machinesView();
        else if (tab === "offcuts") $("app").innerHTML = tabsBar() + offcutsView();
        else $("app").innerHTML = tabsBar() + modeBar + jobCard() + cuttingCard() + body + actionsCard() + resultCard() + "<div class='credit'>" + T.credit + "</div>";
        const cut = document.querySelector("[data-cutting]");
        if (cut) cut.addEventListener("toggle", () => { cuttingOpen = cut.open; });
        if (focusState) {
          const el = document.querySelector("[data-id='" + focusState.id + "']");
          if (el) { el.focus(); try { el.setSelectionRange(focusState.s, focusState.e); } catch (e) {} }
        }
      }

      // ---- events ----
      let timers = {};
      function later(key, fn, ms) { clearTimeout(timers[key]); timers[key] = setTimeout(fn, ms || 250); }
      const setJob = (patch) => post({ type: "job-set", patch });
      function lenPatch(id) {
        const v = document.querySelector("[data-len='" + id + "']").value, u = document.querySelector("[data-lenu='" + id + "']").value;
        return id === "thickness" ? { thickness: { v, u } } : { params: { [id]: { v, u } } };
      }
      function stockRows() {
        return Array.from(document.querySelectorAll(".stockrow")).map((r) => ({ name: r.querySelector("[data-stock=name]").value, w: r.querySelector("[data-stock=w]").value, h: r.querySelector("[data-stock=h]").value, qty: r.querySelector("[data-stock=qty]").value }));
      }

      document.addEventListener("input", (e) => {
        const t = e.target;
        if (t.dataset.calcjob) { calcJobName = t.value; return; }
        if (t.dataset.ck && t.tagName !== "SELECT" && t.type !== "checkbox") {
          const D = draftOf(t.dataset.ck);
          if (t.dataset.cf) D[t.dataset.cf] = t.value;
          else if (t.dataset.cs) { const a = t.dataset.cs.split(":"); D.stock[Number(a[0])][a[1]] = t.value; }
          else if (t.dataset.cc) { const a = t.dataset.cc.split(":"); D.cuts[Number(a[0])][a[1]] = t.value; }
          return;
        }
        if (t.dataset.m && MD && t.tagName !== "SELECT") { MD[t.dataset.m] = t.value; clearTimeout(mSaveTimer); mSaveTimer = setTimeout(() => saveMachine(false), 500); return; }
        if (t.dataset.mr && MD && t.tagName !== "SELECT") { const a = t.dataset.mr.split(":"); MD.rows[Number(a[0])][a[1]] = t.value; clearTimeout(mSaveTimer); mSaveTimer = setTimeout(() => saveMachine(false), 500); return; }
        if (t.dataset.jobname) { jobName = t.value; return; }
        if (t.dataset.pe && postDraft) { postDraft[t.dataset.pe] = t.value; return; }
        if (t.dataset.jobnotes) { jobNotes = t.value; return; }
        if (t.dataset.len) later("len" + t.dataset.len, () => setJob(lenPatch(t.dataset.len)));
        else if (t.dataset.pierce) later("pierce", () => setJob({ params: { pierce: t.value } }));
        else if (t.dataset.stock) later("stock", () => post({ type: "stock-set", rows: stockRows() }), 400);
        else if (t.dataset.pset === "qty") later("q" + t.dataset.part, () => post({ type: "part-set", key: t.dataset.part, patch: { qty: t.value }, refresh: false }));
        else if (t.dataset.bom) later("bom", () => post({ type: "bom-text", text: t.value, refresh: false }), 400);
        else if (t.dataset.gthk) later("gt" + t.dataset.gid, () => post({ type: "group-set", id: t.dataset.gid, patch: { thickness: t.value }, refresh: false }));
        else if (t.dataset.gkerf) later("gk" + t.dataset.gid, () => post({ type: "group-set", id: t.dataset.gid, patch: { kerf: t.value }, refresh: false }));
        else if (t.dataset.inum) later("iq" + t.dataset.gid + t.dataset.inum, () => post({ type: "item-set", gid: t.dataset.gid, num: t.dataset.inum, qty: t.value, refresh: false }));
        else if (t.dataset.tabs) later(t.dataset.tabs, () => setJob({ [t.dataset.tabs]: t.value === "" ? 0 : Number(t.value) || 0 }));
        else if (t.dataset.libq) later("libq" + t.dataset.libq, () => post({ type: "lib-set", id: t.dataset.libq, qty: t.value }), 500);
        else if (t.dataset.minhole) later("minhole", () => setJob({ minHoleSide: t.value === "" ? 0 : Number(t.value) || 0 }));
      });
      document.addEventListener("change", (e) => {
        const t = e.target, d = t.dataset;
        if (d.ck && t.tagName === "SELECT") { draftOf(d.ck)[d.cf] = t.value; if (d.rerender || d.cf === "unit") render(); return; }
        if (d.ck && t.type === "checkbox") { draftOf(d.ck)[d.cf] = t.checked; return; }
        if (d.m && MD && t.tagName === "SELECT") { MD[d.m] = t.value; saveMachine(true); render(); return; }
        if (d.mr && MD && t.tagName === "SELECT") { const a = d.mr.split(":"); MD.rows[Number(a[0])][a[1]] = t.value; saveMachine(false); return; }
        if (d.pe && postDraft) { postDraft[d.pe] = t.value; return; }
        if (d.lenu) setJob(lenPatch(d.lenu));
        else if (d.gauge) { if (t.value) { const f = document.querySelector("[data-len=thickness]"); setJob({ thickness: { v: t.value, u: "in" } }); } }
        else if (d.gset) post({ type: "group-set", id: d.gid, patch: { [d.gset]: t.value } });
        else if (d.gsheet) { const g = V.groups.find((x) => x.id === d.gid); const o = g && g.sheetOptions[Number(t.value)]; if (o) post({ type: "group-set", id: d.gid, patch: { sheet: { w: o.w, h: o.h } } }); }
        else if (d.sheet) { const o = V.sheetOptions[Number(t.value)]; if (o) setJob({ sheet: { w: o.w, h: o.h } }); }
        else if (d.set) setJob({ [d.set]: d.set === "buyExtra" || d.set === "commonLine" || d.set === "useRemnants" ? t.checked : (d.set === "timeMs" ? Number(t.value) : t.value) });
        else if (d.pset) post({ type: "part-set", key: d.part, patch: { [d.pset]: d.pset === "mirror" || d.pset === "allowInHoles" ? t.checked : t.value } });
        else if (d.fileunit) post({ type: "file-unit", key: d.fileunit, unit: t.value === "" ? null : Number(t.value) });
      });
      document.addEventListener("click", (e) => {
        const b = e.target.closest("[data-act]");
        if (!b) return;
        const a = b.dataset.act;
        if (a === "tab") { if (mSaveTimer) saveMachine(false); tab = b.dataset.v; render(); window.scrollTo(0, 0); return; }
        if (a === "calc") { const k = b.dataset.ck; delete draftOf(k).manual; sel = null; post({ type: k === "tube" ? "tube-calc" : "bar-calc", input: draftOf(k) }); return; }
        if (a === "calc-update") { recalc(b.dataset.ck); return; }
        if (a === "bar-split" || a === "bar-remove" || a === "bar-add" || a === "piece-flip" || a === "piece-upside" || a === "piece-tray") {
          const k = b.dataset.ck, M = manualOf(k);
          if (!M) return;
          const pat = Number(b.dataset.pat);
          if (a === "bar-split") { const p = M.patterns[pat]; if (p && p.count > 1) { p.count -= 1; M.patterns.splice(pat + 1, 0, { count: 1, stock: p.stock, pieces: clone(p.pieces) }); } }
          else if (a === "bar-remove") { M.patterns.splice(pat, 1); }
          else if (a === "bar-add") { const v = Number((document.querySelector("[data-id='addbar-" + k + "']") || {}).value); if (v > 0) M.patterns.push({ count: 1, stock: v, pieces: [] }); }
          else if (sel && sel.k === k && M.patterns[sel.pat] && M.patterns[sel.pat].pieces[sel.pi]) {
            const p = M.patterns[sel.pat].pieces[sel.pi];
            if (a === "piece-flip") p.flipped = !p.flipped;
            else if (a === "piece-upside") p.upsideDown = !p.upsideDown;
            else { M.patterns[sel.pat].pieces.splice(sel.pi, 1); sel = null; }
          }
          if (a === "bar-split" || a === "bar-remove") sel = null;
          recalc(k);
          return;
        }
        if (a === "calc-draw" || a === "calc-print") { const k = b.dataset.ck; post({ type: a, kind: k, input: draftOf(k), jobName: calcJobName }); return; }
        if (a === "c-add") {
          const D = draftOf(b.dataset.ck);
          if (b.dataset.list === "stock") D.stock.push({ length: D.stock.length ? D.stock[D.stock.length - 1].length : "", qty: "", cost: "" });
          else D.cuts.push({ label: String.fromCharCode(65 + (D.cuts.length % 26)), length: "", qty: "1", extraCut: "", extraPierces: "", a1: "", a2: "" });
          render(); return;
        }
        if (a === "c-del") { draftOf(b.dataset.ck)[b.dataset.list].splice(Number(b.dataset.i), 1); render(); return; }
        if (a === "c-paste") { pasteOpen[b.dataset.ck] = !pasteOpen[b.dataset.ck]; render(); return; }
        if (a === "c-paste-apply") { pasteLines(b.dataset.ck); return; }
        if (a === "m-new") { if (mSaveTimer) saveMachine(false); post({ type: "profile-new", kind: b.dataset.kind || "" }); return; }
        if (a === "m-import") { $("file-machine").click(); return; }
        if (a === "m-edit") { if (mSaveTimer) saveMachine(false); const p = (V.profiles || []).find((x) => x.id === b.dataset.mid); editId = p ? p.id : null; MD = p ? clone(p) : null; render(); return; }
        if (a === "m-row-add" && MD) { const last = MD.rows[MD.rows.length - 1]; MD.rows.push(last ? Object.assign({}, last, { note: "" }) : { material: "cs", thickness: "", feed: "", pierce: "", kerf: "", note: "" }); render(); return; }
        if (a === "m-row-del" && MD) { MD.rows.splice(Number(b.dataset.i), 1); saveMachine(false); render(); return; }
        if (a === "m-copy" && MD) { saveMachine(false); post({ type: "profile-new", copyOf: MD.id }); return; }
        if (a === "m-export" && MD) { saveMachine(false); post({ type: "profile-export", id: MD.id }); return; }
        // The sandboxed panel has no confirm(): the first click arms the button, the second deletes.
        if (a === "m-delete" && MD) { if (delArm !== MD.id) { delArm = MD.id; render(); return; } delArm = null; post({ type: "profile-delete", id: MD.id }); MD = null; editId = null; return; }
        if (a === "source") setJob({ sheetSource: b.dataset.v });
        else if (a === "mode") setJob({ mode: b.dataset.v });
        else if (a === "load-csv") $("file-csv").click();
        else if (a === "add-drawings") { partsForGroups = true; $("file-parts").click(); }
        else if (a === "m-preset") { const sel = document.querySelector("[data-id=amada-preset]"); if (sel && sel.value) { if (mSaveTimer) saveMachine(false); post({ type: "profile-new", preset: sel.value }); } }
        else if (a === "pick-folder") post({ type: "pick-folder" });
        else if (a === "make-groups") { const ta = document.querySelector("[data-bom]"); post({ type: "make-groups", text: ta ? ta.value : undefined }); }
        else if (a === "item-remove") post({ type: "item-remove", gid: b.dataset.g, num: b.dataset.n });
        else if (a === "custom-toggle") { customOpen = !customOpen; render(); }
        else if (a === "custom-add") { post({ type: "custom-sheet", w: document.querySelector("[data-id=cw]").value, h: document.querySelector("[data-id=ch]").value }); customOpen = false; }
        else if (a === "custom-remove") post({ type: "remove-custom-sheet" });
        else if (a === "stock-add") post({ type: "stock-set", rows: stockRows().concat([{ name: "Sheet", w: V.stockRows.length ? V.stockRows[V.stockRows.length - 1].w : "48", h: V.stockRows.length ? V.stockRows[V.stockRows.length - 1].h : "96", qty: "1" }]) });
        else if (a === "stock-del") post({ type: "stock-set", rows: stockRows().filter((_, i) => i !== Number(b.dataset.i)) });
        else if (a === "add-selection") post({ type: "add-selection" });
        else if (a === "add-files") { partsForGroups = false; $("file-parts").click(); }
        else if (a === "remove") post({ type: "remove-part", key: b.dataset.k });
        else if (a === "nest") { message = null; progress = null; R = null; post({ type: "nest" }); }
        else if (a === "stop") post({ type: "cancel-nest" });
        else if (a === "save-remnants") post({ type: "save-remnants", jobName });
        else if (a === "lib-del") post({ type: "lib-delete", id: b.dataset.id });
        else if (a === "lib-add") { const g = (k) => (document.querySelector("[data-libnew='" + k + "']") || {}).value || ""; post({ type: "lib-add", w: g("w"), h: g("h"), qty: g("qty") || "1", material: g("material"), thickness: g("thickness") }); }
        else if (a === "clear") post({ type: "clear" });
        else if (a === "check") post({ type: "check-nest" });
        else if (a === "save-job") post({ type: "save-job" });
        else if (a === "open-job") $("file-job").click();
        else if (a === "dxf") post({ type: "export-dxf", sheetIndex: Number(b.dataset.i) });
        else if (a === "dxf-all") post({ type: "export-dxf", sheetIndex: -1 });
        else if (a === "gcode") post({ type: "export-gcode", sheetIndex: Number($("gsheet").value) });
        else if (a === "toolpath") post({ type: "preview-toolpath", sheetIndex: Number($("gsheet").value) });
        else if (a === "post-edit") { const p = V.postSpec || {}; postDraft = { id: p.id, name: p.name, on: p.on, off: p.off, end: p.end, dwellUnit: p.dwellUnit, comments: p.comments, header: (p.header || []).join("\n") }; render(); }
        else if (a === "post-cancel") { postDraft = null; render(); }
        else if (a === "post-save" && postDraft) post({ type: "post-save", spec: Object.assign({}, postDraft, { header: String(postDraft.header || "").split("\n") }) });
        else if (a === "post-delete") { postDraft = null; post({ type: "post-delete", id: V.postId }); }
        else if (a === "pick-print-folder") post({ type: "pick-print-folder" });
        else if (a === "print") post({ type: "print", jobName, notes: jobNotes });
        else if (a === "rot") post({ type: "rotate-selected", deg: Number(b.dataset.deg) });
        else if (a === "rot-free") { const v = Number((document.querySelector("[data-id=rotdeg]") || {}).value); if (v) post({ type: "rotate-selected", deg: v }); else { message = "Type an angle in degrees first (e.g. 30, or -15 for clockwise)."; render(); } }
        else if (a === "tray-add") post({ type: "tray-add", key: b.dataset.k, count: Number(b.dataset.n) || 1 });
      });

      // Multi-material mode: "Add drawings" files are looked up by the list's part names, not added as parts.
      let partsForGroups = false;
      $("file-parts").addEventListener("change", async (e) => {
        const out = await readFiles(e.target.files);
        e.target.value = "";
        if (out.length) post({ type: "add-files", files: out, forGroups: partsForGroups });
      });
      $("file-machine").addEventListener("change", async (e) => {
        const f = (e.target.files || [])[0];
        e.target.value = "";
        if (f) post({ type: "profile-import", text: await f.text() });
      });
      // NT-01: drag DXF / DWG files from Explorer onto the Parts card (anywhere on the Sheets tab works too).
      const PART_FILE = /\.(dxf|dwg|svg)$/i;
      const dropCard = () => document.querySelector("[data-drop=parts]");
      let dragDepth = 0;
      const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).indexOf("Files") >= 0;
      document.addEventListener("dragenter", (e) => { if (!hasFiles(e) || tab !== "sheets") return; e.preventDefault(); dragDepth++; const c = dropCard(); if (c) c.classList.add("dragover"); });
      document.addEventListener("dragover", (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = tab === "sheets" && V && V.job.mode === "manual" ? "copy" : "none"; });
      document.addEventListener("dragleave", () => { dragDepth = Math.max(0, dragDepth - 1); if (dragDepth === 0) { const c = dropCard(); if (c) c.classList.remove("dragover"); } });
      document.addEventListener("drop", async (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepth = 0;
        const c = dropCard(); if (c) c.classList.remove("dragover");
        if (tab !== "sheets" || !V || V.job.mode !== "manual") return;
        const all = Array.from(e.dataTransfer.files || []);
        const files = all.filter((f) => PART_FILE.test(f.name));
        if (files.length < all.length) { message = (all.length - files.length) + " file(s) skipped - drop DXF or DWG drawings."; render(); }
        const out = await readFiles(files);
        if (out.length) post({ type: "add-files", files: out });
      });
      $("file-csv").addEventListener("change", async (e) => {
        const f = (e.target.files || [])[0];
        e.target.value = "";
        // Load and group in one step: the CSV lands in the text box and its groups appear.
        if (f) post({ type: "make-groups", text: await f.text() });
      });
      $("file-job").addEventListener("change", async (e) => {
        const f = (e.target.files || [])[0];
        e.target.value = "";
        if (f) post({ type: "open-job", text: await f.text() });
      });

      window.addEventListener("message", (e) => {
        const m = e.data && e.data.pluginMessage;
        if (!m) return;
        if (m.type === "view") {
          V = m;
          if (!V.running) progress = null;
          // Keep the machine being edited in step with what was saved (a deleted one closes) unless an edit is still pending.
          if (MD && !mSaveTimer) { const p = (V.profiles || []).find((x) => x.id === MD.id); MD = p ? clone(p) : null; if (!p) editId = null; }
          if (TI && TI.profileId && !(V.profiles || []).some((x) => x.id === TI.profileId)) TI.profileId = "";
          render();
          return;
        }
        if (m.type === "profile-created") { const p = (V.profiles || []).find((x) => x.id === m.id); if (p) { editId = p.id; MD = clone(p); tab = "machines"; render(); } return; }
        if (m.type === "bar-result") { barRes = m.result; render(); return; }
        if (m.type === "tube-result") { tubeRes = m.result; render(); return; }
        if (m.type === "status") { if (V) { V.status = m.status; V.partsProblem = m.partsProblem; V.canCalculate = m.canCalculate && !V.running; render(); } return; }
        if (m.type === "nest-progress") { progress = m; const el = document.querySelector(".msg.ok"); if (el && V && V.running) el.textContent = progressText(); return; }
        if (m.type === "result") { R = m; M = null; message = null; render(); return; }
        if (m.type === "manual") { M = m; if (R && tab === "sheets") render(); return; }
        if (m.type === "print-folder") { printFolder = m.folder; if (R) render(); return; }
        if (m.type === "cleared") { R = null; M = null; message = null; render(); return; }
        if (m.type === "post-saved") { postDraft = null; message = null; render(); return; }
        if (m.type === "error") { message = m.message; render(); return; }
        if (m.type === "selection-hint") { const el = $("sel-hint"); if (el) el.textContent = m.count ? m.count + " shape(s) selected" + (m.openCount ? ", " + m.openCount + " open" : "") : ""; return; }
      });
      post({ type: "ready" });
    </script>
  </body>
</html>`;
