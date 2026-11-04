import { useEffect, useMemo, useState } from "react";
import { countSimplifiable, simplifyPolylineCommands, type Entity } from "@sketchor/core";
import { bus, doc, reinterpretImportUnits, useApp } from "../state/store";
import { getSimplifyOnImport, getSimplifyTolerance, parseSimplifyTolerance, setSimplifyOnImport, setSimplifyTolerance } from "../simplifySettings";
import { DISPLAY_UNITS, dxfCodeToDisplayUnit, dxfUnitName } from "../units";

/**
 * A dismissible summary of the most recent import: for DXF/DWG, which entity
 * types were parsed vs. found-but-skipped (so an unsupported entity like
 * HATCH or DIMENSION is never silently dropped — see R8 in the engineering
 * brief) and which unit the file was read in; for SVG, whatever warnings the
 * parser produced (e.g. curve approximation, an unreadable file).
 *
 * A wrong unit silently makes every dimension wrong, so it is always shown.
 * When the file didn't state it (the unit was guessed from its drawing
 * defaults, or it has no hint at all), the banner turns amber and offers
 * one click to re-read the geometry in the right unit.
 */
export function ImportReportBanner() {
  const report = useApp((s) => s.importReport);
  const units = useApp((s) => s.importUnits);
  const dismissReport = useApp((s) => s.setImportReport);
  const dismissUnits = useApp((s) => s.setImportUnits);
  const warnings = useApp((s) => s.fileWarnings);
  const dismissWarnings = useApp((s) => s.setFileWarnings);

  // P-03b: offer (or, when the preference is on, just do) Simplify on a fresh import.
  const [tolText, setTolText] = useState(() => String(getSimplifyTolerance()));
  const [auto, setAuto] = useState(getSimplifyOnImport);
  const [simplified, setSimplified] = useState<string | null>(null);
  const tol = parseSimplifyTolerance(tolText);
  const simplifyAll = (mm: number): number => {
    const commands = simplifyPolylineCommands(doc.all(), mm);
    if (commands.length > 0) bus.execute({ type: "batch", commands });
    return commands.length / 2;
  };
  useEffect(() => {
    setSimplified(null);
    if (!report || !getSimplifyOnImport()) return;
    const mm = getSimplifyTolerance();
    const n = simplifyAll(mm);
    if (n > 0) setSimplified(`Simplified ${n} polyline${n === 1 ? "" : "s"} at ${mm} mm (Ctrl+Z to undo)`);
  }, [report]);
  const candidates = useMemo(() => (report && !simplified ? countSimplifiable(doc.all() as Entity[], tol ?? getSimplifyTolerance()) : 0), [report, simplified, tol]);

  if (report) {
    const { parsed, skipped } = report;
    const guessed = units !== null && (units.source === "inferred" || units.source === "none" || units.source === "conflict" || units.source === "svg-assumed");
    const clean = skipped.length === 0 && warnings.length === 0 && !guessed;
    const current = units ? dxfCodeToDisplayUnit(units.code) : null;
    const summary =
      skipped.length === 0
        ? `Imported ${parsed.map((p) => `${p.count} ${p.type}`).join(", ") || "nothing"}`
        : `Imported with ${skipped.reduce((n, s) => n + s.count, 0)} unsupported entit${skipped.length === 1 && skipped[0].count === 1 ? "y" : "ies"}: ${skipped
            .map((s) => `${s.count} ${s.type}`)
            .join(", ")}`;
    return (
      <div className={`import-banner ${clean ? "clean" : "warn"}`} data-testid="import-report">
        <span className="import-banner-summary">
          {summary}
          {units && <> · {unitText(units.source, units.code)}</>}
          {warnings.length > 0 && <> · {warnings.join("; ")}</>}
        </span>
        {simplified && (
          <span className="import-banner-units" data-testid="import-simplified">
            {simplified}
          </span>
        )}
        {!simplified && (candidates > 0 || auto) && (
          <span className="import-banner-units" data-testid="import-simplify">
            {candidates} dense polyline{candidates === 1 ? "" : "s"} can be simplified to
            <input
              value={tolText}
              onChange={(e) => {
                setTolText(e.target.value);
                const t = parseSimplifyTolerance(e.target.value);
                if (t !== null) setSimplifyTolerance(t);
              }}
              style={{ width: 44, margin: "0 4px" }}
              aria-label="Simplify tolerance in mm"
              aria-invalid={tol === null}
            />
            mm
            <button
              className="btn ghost"
              disabled={tol === null || candidates === 0}
              onClick={() => {
                if (tol === null) return;
                const n = simplifyAll(tol);
                setSimplified(`Simplified ${n} polyline${n === 1 ? "" : "s"} at ${tol} mm (Ctrl+Z to undo)`);
              }}
              title="Fewer points, real arcs (same as Shift+P)"
            >
              Simplify
            </button>
            <label title="Simplify polylines automatically whenever a file is opened">
              <input
                type="checkbox"
                checked={auto}
                onChange={(e) => {
                  setAuto(e.target.checked);
                  setSimplifyOnImport(e.target.checked);
                }}
              />{" "}
              always on import
            </label>
          </span>
        )}
        {guessed && (
          <span className="import-banner-units" data-testid="import-units">
            Read as:
            {DISPLAY_UNITS.map((u) => (
              <button
                key={u.id}
                className={`btn ghost${u.id === current ? " active" : ""}`}
                onClick={() => reinterpretImportUnits(u.id)}
                title={`Re-read the drawing as if the file were in ${u.label}`}
              >
                {u.label}
              </button>
            ))}
          </span>
        )}
        <button
          className="btn ghost"
          onClick={() => {
            dismissReport(null);
            dismissUnits(null);
            dismissWarnings([]);
          }}
          title="Dismiss"
        >
          ✕
        </button>
      </div>
    );
  }

  if (warnings.length > 0) {
    return (
      <div className="import-banner warn" data-testid="import-report">
        <span className="import-banner-summary">{warnings.join("; ")}</span>
        <button className="btn ghost" onClick={() => dismissWarnings([])} title="Dismiss">
          ✕
        </button>
      </div>
    );
  }

  return null;
}

function unitText(source: string, code: number): string {
  const name = dxfUnitName(code);
  switch (source) {
    case "insunits":
      return `units: ${name}`;
    case "measurement":
      return `units: ${name} (from the file's imperial/metric setting)`;
    case "inferred":
      return `units not stated in the file — guessed ${name} from its drawing defaults. Check a known dimension`;
    case "svg-assumed":
      return "size not stated in physical units (no mm/cm/in on width/height) — read at 96 dpi, 1 px = 0.2646 mm. Check a known dimension";
    case "conflict":
      return `file says millimetres, but its dimension settings say ${name} — read as ${name}. Check a known dimension`;
    case "user":
      return `units: ${name} (set by you)`;
    default:
      return code
        ? `units not stated in the file — numbers read as ${name}. Check a known dimension`
        : "units not stated in the file — numbers read as millimetres. Check a known dimension";
  }
}
