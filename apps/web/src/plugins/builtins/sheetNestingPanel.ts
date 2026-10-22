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
      .icon { background: none; border: none; color: var(--sk-text-dim,#9aa0a6); padding: 0 3px; cursor: pointer; }
    </style>
  </head>
  <body>
    <div id="app"></div>
    <input type="file" id="file-parts" multiple accept=".dxf,.dwg,.svg" style="display:none">
    <input type="file" id="file-csv" accept=".csv,.txt,.tsv" style="display:none">
    <input type="file" id="file-job"accept=".sketchor-nest,.json" style="display:none">
    <script>
      const post = (m) => parent.postMessage({ pluginMessage: m }, "*");
      const $ = (id) => document.getElementById(id);
      const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

      // All user-visible strings in one table so translations can be added later.
      const T = {
        material: "Material", materials: { al5052: "Aluminium 5052", al6061: "Aluminium 6061", ss: "Stainless steel", cs: "Carbon steel", plastic: "Plastic", plywood: "Plywood", stone: "Stone", quartz: "Quartz" },
        sheet: "Sheet", standard: "Standard sheet", stock: "Stock on hand", addSize: "+ size", removeSize: "Remove size", addRow: "+ Add row", buyExtra: "Also buy extra sheets of the standard size",
        thickness: "Thickness", gauge: "Gauge...", machine: "Machine", machines: { laser: "Laser", waterjet: "Waterjet", router: "CNC router", other: "Other" },
        engine: "Engine", raster: "Raster (fast)", trueShape: "True shape (exact)",
        engineHint: "Raster: default - fast, handles any quantity. True shape: pick for few large parts with tight kerf, or when you need exact clearance or mirroring.",
        cutting: "Cutting parameters", estimate: "Estimates - set your machine's values.", kerf: "Kerf", web: "Web (gap)", margin: "Edge margin", clamp: "Clamp strip", bedW: "Bed width", bedH: "Bed height",
        accuracy: "Accuracy", acc: { fast: "Fast", normal: "Normal", precise: "Precise" }, time: "Optimise for", times: { 0: "First result", 10000: "10 s", 30000: "30 s", 120000: "2 min" },
        units: "Display units", unitNames: { in: "Inches (fractions)", indec: "Inches (decimal)", ftin: "Feet-inches", mm: "mm", cm: "cm", m: "m" },
        trueOpts: "True shape options", gravity: "Gravity", minHole: "Min hole size", search: "Search", searches: { quick: "Quick", normal: "Normal", thorough: "Thorough" },
        grav: { "bottom-left": "Bottom-left", "bottom-right": "Bottom-right", "top-left": "Top-left", "top-right": "Top-right" },
        parts: "Parts", addSelection: "+ Add selection", addFiles: "+ Add files", noParts: "No parts yet - select closed shapes and click Add selection, or add DXF/DWG files.",
        qty: "Qty", rot: { none: "No rotation", flip: "0 / 180", r90: "Every 90", r45: "Every 45", r30: "Every 30", r15: "Every 15", r10: "Every 10", free: "Any angle" },
        holes: "holes", mirror: "Mirror", inHoles: "In holes", fileUnit: "File units", fileUnits: { "": "As in file", 1: "inch", 4: "mm", 5: "cm", 6: "m", 2: "foot" },
        calculate: "Calculate", stop: "Stop", clear: "Clear", check: "Check nest", saveJob: "Save job", openJob: "Open job",
        fillIn: "Fill in the orange fields", ready: "Ready to calculate", gone: "Drawing no longer found", bedWarn: "The sheet is larger than the machine bed.",
        results: "Results", kpi: { sheets: "Sheets", toBuy: "To purchase", util: "Utilisation", placed: "Parts placed", cut: "Cut length", pierce: "Pierces" },
        stockUsage: "Stock usage", notPlaced: "Not placed", dxf: "DXF", allZip: "All as ZIP", gcode: "G-code",
        manual: "Manual", groupsMode: "Groups from a list", bomHint: "Paste the parts list here (part number, quantity, material)...", loadCsv: "Load CSV", chooseFolder: "Choose folder", makeGroups: "Groups from the list",
        noFolder: "No drawing folder chosen - part numbers are looked up as DXF files in it.", noGroups: "No groups yet - paste a parts list and click Groups from the list.", group: "Group", of: "of",
        credit: "Nesting engine based on the Sheet Nesting Calculator by Oleksandr Borenko",
      };
      const ROT_KEYS = ["none", "flip", "r90", "r45", "r30", "r15", "r10", "free"];

      let V = null; // last view from the plugin
      let R = null; // last result
      let progress = null;
      let message = null;
      let customOpen = false;

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
        h += "<div class='muted' style='font-size:10px'>" + T.engineHint + "</div>";
        return h + "</div>";
      }

      function cuttingCard() {
        const j = V.job, st = V.status, p = j.params, ras = isRaster();
        let h = "<details class='card'><summary>" + T.cutting + "</summary><div class='muted' style='font-size:10px;margin-bottom:4px'>" + T.estimate + "</div><div class='grid2'>";
        h += lenField("kerf", j.machine === "router" ? "Bit diameter (kerf)" : T.kerf, p.kerf, st.kerf);
        h += lenField("web", T.web, p.web, st.web);
        h += lenField("margin", T.margin, p.margin, st.margin);
        if (j.machine === "laser") h += lenField("clamp", T.clamp, p.clamp, st.clamp);
        h += lenField("bedW", T.bedW, p.bedW, st.bedW);
        h += lenField("bedH", T.bedH, p.bedH, st.bedH);
        h += "<label class='fld' title='" + esc(ras ? "" : RASTER_ONLY_NA.accuracy) + "'><span class='t'>" + T.accuracy + "</span><select data-id='accuracy' data-set='accuracy'" + (ras ? "" : " disabled") + ">" + optionsHtml(T.acc, j.accuracy) + "</select></label>";
        h += "<label class='fld' title='" + esc(ras ? "" : RASTER_ONLY_NA.time) + "'><span class='t'>" + T.time + "</span><select data-id='timeMs' data-set='timeMs'" + (ras ? "" : " disabled") + ">" + optionsHtml(T.times, j.timeMs, [0, 10000, 30000, 120000]) + "</select></label>";
        h += "<label class='fld'><span class='t'>" + T.units + "</span><select data-id='outputUnit' data-set='outputUnit'>" + optionsHtml(T.unitNames, j.outputUnit) + "</select></label></div>";
        h += "<h4 style='margin-top:6px'>" + T.trueOpts + "</h4><div class='grid2'>";
        h += "<label class='fld' title='" + esc(ras ? RASTER_ONLY_NA.gravity : "") + "'><span class='t'>" + T.gravity + "</span><select data-id='gravity' data-set='gravity'" + (ras ? " disabled" : "") + ">" + optionsHtml(T.grav, j.gravity) + "</select></label>";
        h += "<label class='fld' title='" + esc(ras ? RASTER_ONLY_NA.search : "") + "'><span class='t'>" + T.search + "</span><select data-id='searchLevel' data-set='searchLevel'" + (ras ? " disabled" : "") + ">" + optionsHtml(T.searches, j.searchLevel) + "</select></label>";
        h += "<label class='fld' title='" + esc(ras ? RASTER_ONLY_NA.minHole : "") + "'><span class='t'>" + T.minHole + "</span><input data-id='minHole' data-minhole='1' value='" + esc(j.minHoleArea > 0 ? Math.round(Math.sqrt(j.minHoleArea) * 100) / 100 : "") + "' placeholder='mm'" + (ras ? " disabled" : "") + "></label></div>";
        return h + "</details>";
      }

      function partsCard() {
        const j = V.job;
        let h = "<div class='card'><h4>" + T.parts + "</h4><div class='row' style='margin-bottom:6px'><button data-act='add-selection'>" + T.addSelection + "</button><button class='ghost' data-act='add-files'>" + T.addFiles + "</button><span class='muted' id='sel-hint'></span></div>";
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

      const ITEM_TEXT = { nofolder: "choose the folder", missing: "no file found", failed: "file unusable", loading: "reading...", ok: "ok" };
      function bomCard() {
        let h = "<div class='card'><h4>Parts list</h4><textarea data-id='bom' data-bom='1' rows='5' placeholder='" + esc(T.bomHint) + "' style='width:100%;resize:vertical;background:var(--sk-bg,#1e1f22);color:inherit;border:1px solid var(--sk-border,#3a3d42);border-radius:4px;font:11px monospace;padding:4px'>" + esc(V.bomText) + "</textarea>";
        h += "<div class='row' style='margin:6px 0'><button class='ghost sm' data-act='load-csv'>" + T.loadCsv + "</button><button class='ghost sm' data-act='pick-folder'>" + T.chooseFolder + "</button><button data-act='make-groups'>" + T.makeGroups + "</button></div>";
        h += "<div class='pdim'>" + (V.folder ? esc(V.folder.name) + " - " + V.folder.count + " files" + (V.folder.truncated ? " (list truncated)" : "") : T.noFolder) + "</div></div>";
        return h;
      }
      function groupsCard() {
        if (!V.groups.length) return "<div class='card'><div class='muted'>" + T.noGroups + "</div></div>";
        return V.groups.map((g, gi) => {
          const sheetSel = g.sheetOptions.map((s, i) => "<option value='" + i + "'" + (Math.abs(s.w - g.sheet.w) < 1e-6 && Math.abs(s.h - g.sheet.h) < 1e-6 ? " selected" : "") + ">" + esc(s.label) + "</option>").join("");
          const gid = esc(g.id);
          let h = "<div class='card'><h4>" + T.group + " " + (gi + 1) + " " + T.of + " " + V.groups.length + "</h4><div class='grid2'>";
          h += "<label class='fld'><span class='t'>" + T.material + "</span><select data-gid='" + gid + "' data-gset='material'>" + optionsHtml(T.materials, g.material, V.materials) + "</select></label>";
          h += "<label class='fld'><span class='t'>" + T.thickness + " (in)</span><input data-id='gt" + gi + "' data-gid='" + gid + "' data-gthk='1' value='" + esc(g.thickness) + "'></label>";
          h += "<label class='fld'><span class='t'>" + T.sheet + "</span><select data-gid='" + gid + "' data-gsheet='1'>" + sheetSel + "</select></label>";
          h += "<label class='fld'><span class='t'>Rotation</span><select data-gid='" + gid + "' data-gset='rotation'>" + optionsHtml(T.rot, g.rotation, ROT_KEYS) + "</select></label></div>";
          h += g.items.map((it) => {
            const bad = it.state === "missing" || it.state === "failed" || it.state === "nofolder";
            return "<div class='scard' style='" + (bad ? "color:var(--sk-danger,#f0616d)" : "") + "'><div style='min-width:0'><div class='pname' title='" + esc(it.file || it.num) + "'>" + esc(it.num) + "</div><div class='pdim' style='" + (bad ? "color:inherit" : "") + "'>" +
              esc(ITEM_TEXT[it.state] || it.state) + (it.state === "ok" && it.file ? " - " + esc(it.file) + (it.per > 1 ? " (" + it.per + " per file, " + it.need + " files)" : "") : "") + (it.error ? ": " + esc(it.error) : "") + "</div></div>" +
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

      function resultCard() {
        if (!R) return "";
        const k = R.kpis;
        let h = "<div class='card'><h4>" + T.results + "</h4><div class='kpis'>" +
          [[k.sheets, T.kpi.sheets], [k.toPurchase, T.kpi.toBuy], [Math.round(k.utilisation * 1000) / 10 + "%", T.kpi.util], [k.placed + "/" + k.required, T.kpi.placed], [k.cutLength, T.kpi.cut], [k.pierces, T.kpi.pierce]]
            .map((x) => "<div class='kpi'><b>" + esc(x[0]) + "</b><span>" + x[1] + "</span></div>").join("") + "</div>";
        if (R.unplaced.length) h += "<div class='msg err'>" + T.notPlaced + ": " + R.unplaced.map((u) => esc(u.name) + " &times;" + u.count).join(", ") + "</div>";
        if (R.stopped) h += "<div class='msg warn'>Stopped early - showing the best layout found so far.</div>";
        (R.notes || []).forEach((n) => (h += "<div class='msg warn'>" + esc(n) + "</div>"));
        h += "<h4 style='margin-top:6px'>" + T.stockUsage + "</h4><table><tr><th>Size</th><th>Used</th><th>Buy</th><th>In stock</th></tr>" +
          R.stock.map((s) => "<tr><td>" + esc(s.size) + "</td><td>" + s.used + "</td><td>" + s.purchased + "</td><td>" + (s.available == null ? "&infin;" : s.available) + "</td></tr>").join("") + "</table>";
        h += "<h4 style='margin-top:8px'>Sheets</h4>" + R.cards.map((c) =>
          "<div class='scard'><div><b>" + esc(c.title) + "</b>" + (c.group ? " <span class='muted'>" + esc(c.group) + "</span>" : "") + "<div class='pdim'>" + esc(c.size) + " &middot; " + c.parts + " parts &middot; " + Math.round(c.utilisation * 100) + "%</div></div>" +
          "<button class='ghost sm' data-act='dxf' data-i='" + c.index + "'>" + T.dxf + "</button></div>").join("");
        h += "<div class='row' style='margin-top:8px'><button class='ghost sm' data-act='dxf-all'>" + T.allZip + "</button><select id='gsheet' style='width:auto;margin:0'>" + R.sheetLabels.map((l, i) => "<option value='" + i + "'>" + esc(l) + "</option>").join("") + "</select><button class='ghost sm' data-act='gcode'>" + T.gcode + "</button><button class='ghost sm' data-act='print'>Print report</button></div>";
        return h + "</div>";
      }

      let focusState = null;
      function render() {
        if (!V) { $("app").innerHTML = "<div class='muted'>Loading...</div>"; return; }
        const a = document.activeElement;
        focusState = a && a.dataset && a.dataset.id ? { id: a.dataset.id, s: a.selectionStart, e: a.selectionEnd } : null;
        V.statusList = Object.keys(V.status).filter((k) => V.status[k] !== "ok").map((k) => ({ thickness: "thickness", kerf: "kerf", web: "web", margin: "margin", clamp: "clamp", bedW: "bed width", bedH: "bed height", parts: "parts", sheet: "sheet" }[k] || k));
        const modeBar = "<div class='seg'><button data-act='mode' data-v='manual' class='" + (V.job.mode === "manual" ? "on" : "") + "'>" + T.manual + "</button><button data-act='mode' data-v='groups' class='" + (V.job.mode === "groups" ? "on" : "") + "'>" + T.groupsMode + "</button></div>";
        const body = V.job.mode === "groups" ? bomCard() + groupsCard() : partsCard();
        $("app").innerHTML = modeBar + jobCard() + cuttingCard() + body + actionsCard() + resultCard() + "<div class='credit'>" + T.credit + "</div>";
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
        if (t.dataset.len) later("len" + t.dataset.len, () => setJob(lenPatch(t.dataset.len)));
        else if (t.dataset.stock) later("stock", () => post({ type: "stock-set", rows: stockRows() }), 400);
        else if (t.dataset.pset === "qty") later("q" + t.dataset.part, () => post({ type: "part-set", key: t.dataset.part, patch: { qty: t.value }, refresh: false }));
        else if (t.dataset.bom) later("bom", () => post({ type: "bom-text", text: t.value, refresh: false }), 400);
        else if (t.dataset.gthk) later("gt" + t.dataset.gid, () => post({ type: "group-set", id: t.dataset.gid, patch: { thickness: t.value }, refresh: false }));
        else if (t.dataset.inum) later("iq" + t.dataset.gid + t.dataset.inum, () => post({ type: "item-set", gid: t.dataset.gid, num: t.dataset.inum, qty: t.value, refresh: false }));
        else if (t.dataset.minhole) later("minhole", () => setJob({ minHoleSide: t.value === "" ? 0 : Number(t.value) || 0 }));
      });
      document.addEventListener("change", (e) => {
        const t = e.target, d = t.dataset;
        if (d.lenu) setJob(lenPatch(d.lenu));
        else if (d.gauge) { if (t.value) { const f = document.querySelector("[data-len=thickness]"); setJob({ thickness: { v: t.value, u: "in" } }); } }
        else if (d.gset) post({ type: "group-set", id: d.gid, patch: { [d.gset]: t.value } });
        else if (d.gsheet) { const g = V.groups.find((x) => x.id === d.gid); const o = g && g.sheetOptions[Number(t.value)]; if (o) post({ type: "group-set", id: d.gid, patch: { sheet: { w: o.w, h: o.h } } }); }
        else if (d.sheet) { const o = V.sheetOptions[Number(t.value)]; if (o) setJob({ sheet: { w: o.w, h: o.h } }); }
        else if (d.set) setJob({ [d.set]: d.set === "buyExtra" ? t.checked : (d.set === "timeMs" ? Number(t.value) : t.value) });
        else if (d.pset) post({ type: "part-set", key: d.part, patch: { [d.pset]: d.pset === "mirror" || d.pset === "allowInHoles" ? t.checked : t.value } });
        else if (d.fileunit) post({ type: "file-unit", key: d.fileunit, unit: t.value === "" ? null : Number(t.value) });
      });
      document.addEventListener("click", (e) => {
        const b = e.target.closest("[data-act]");
        if (!b) return;
        const a = b.dataset.act;
        if (a === "source") setJob({ sheetSource: b.dataset.v });
        else if (a === "mode") setJob({ mode: b.dataset.v });
        else if (a === "load-csv") $("file-csv").click();
        else if (a === "pick-folder") post({ type: "pick-folder" });
        else if (a === "make-groups") { const ta = document.querySelector("[data-bom]"); post({ type: "make-groups", text: ta ? ta.value : undefined }); }
        else if (a === "item-remove") post({ type: "item-remove", gid: b.dataset.g, num: b.dataset.n });
        else if (a === "custom-toggle") { customOpen = !customOpen; render(); }
        else if (a === "custom-add") { post({ type: "custom-sheet", w: document.querySelector("[data-id=cw]").value, h: document.querySelector("[data-id=ch]").value }); customOpen = false; }
        else if (a === "custom-remove") post({ type: "remove-custom-sheet" });
        else if (a === "stock-add") post({ type: "stock-set", rows: stockRows().concat([{ name: "Sheet", w: V.stockRows.length ? V.stockRows[V.stockRows.length - 1].w : "48", h: V.stockRows.length ? V.stockRows[V.stockRows.length - 1].h : "96", qty: "1" }]) });
        else if (a === "stock-del") post({ type: "stock-set", rows: stockRows().filter((_, i) => i !== Number(b.dataset.i)) });
        else if (a === "add-selection") post({ type: "add-selection" });
        else if (a === "add-files") $("file-parts").click();
        else if (a === "remove") post({ type: "remove-part", key: b.dataset.k });
        else if (a === "nest") { message = null; progress = null; R = null; post({ type: "nest" }); }
        else if (a === "stop") post({ type: "cancel-nest" });
        else if (a === "clear") post({ type: "clear" });
        else if (a === "check") post({ type: "check-nest" });
        else if (a === "save-job") post({ type: "save-job" });
        else if (a === "open-job") $("file-job").click();
        else if (a === "dxf") post({ type: "export-dxf", sheetIndex: Number(b.dataset.i) });
        else if (a === "dxf-all") post({ type: "export-dxf", sheetIndex: -1 });
        else if (a === "gcode") post({ type: "export-gcode", sheetIndex: Number($("gsheet").value) });
        else if (a === "print") post({ type: "print" });
      });

      $("file-parts").addEventListener("change", async (e) => {
        const out = [];
        for (const f of Array.from(e.target.files || [])) {
          try {
            if (/\.dwg$/i.test(f.name)) out.push({ name: f.name, bytes: await f.arrayBuffer() });
            else out.push({ name: f.name, text: await f.text() });
          } catch (err) { out.push({ name: f.name, text: "" }); }
        }
        e.target.value = "";
        if (out.length) post({ type: "add-files", files: out });
      });
      $("file-csv").addEventListener("change", async (e) => {
        const f = (e.target.files || [])[0];
        e.target.value = "";
        if (f) post({ type: "bom-text", text: await f.text() });
      });
      $("file-job").addEventListener("change", async (e) => {
        const f = (e.target.files || [])[0];
        e.target.value = "";
        if (f) post({ type: "open-job", text: await f.text() });
      });

      window.addEventListener("message", (e) => {
        const m = e.data && e.data.pluginMessage;
        if (!m) return;
        if (m.type === "view") { V = m; if (!V.running) progress = null; render(); return; }
        if (m.type === "status") { if (V) { V.status = m.status; V.canCalculate = m.canCalculate && !V.running; render(); } return; }
        if (m.type === "nest-progress") { progress = m; const el = document.querySelector(".msg.ok"); if (el && V && V.running) el.textContent = progressText(); return; }
        if (m.type === "result") { R = m; message = null; render(); return; }
        if (m.type === "cleared") { R = null; message = null; render(); return; }
        if (m.type === "error") { message = m.message; render(); return; }
        if (m.type === "selection-hint") { const el = $("sel-hint"); if (el) el.textContent = m.count ? m.count + " shape(s) selected" + (m.openCount ? ", " + m.openCount + " open" : "") : ""; return; }
      });
      post({ type: "ready" });
    </script>
  </body>
</html>`;
