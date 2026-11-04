import { TEXT_STYLE_PRESETS } from "@sketchor/core";
import { useEffect, useMemo, useState } from "react";
import { dynamicSpecOf, paramFields, resetParams, withParamValue } from "@sketchor/core";
import type { BlockDefinition, BlockTreeNode, Command, Entity, HatchEntity, InsertEntity, PolylineEntity, SplineEntity } from "@sketchor/core";
import { GRADIENT_NAMES, blockTree, editableAttributes, isMirroredInsert, withAttributeValues, withInsertArray, withInsertScale, explodeHatchCommands, recreateBoundaryCommands, setHatchDrawOrder, entityArea, entityLength, arcPointAt, arcSweep, bulgeToArc, BUILTIN_LINETYPES, dist, ellipseSweep, nurbsDomain, nurbsPointAt, findClosedRegions, isFullEllipse, layerOf, polylineLength, addSplinePoint, polylineToSpline, rebuildSpline, refitSpline, removeSplinePoint, splineToControlPoints, splineToPolyline } from "@sketchor/core";
import { canBeAnnotative, currentAnnotationScale, isAnnotative, withAnnotative, withScaleAdded, withScaleRemoved } from "@sketchor/core";
import { bus, doc, useApp } from "../state/store";
import { settingsFromHatch } from "../tools/hatchTool";
import { parseLength } from "../tools/typedInput";
import { factorFromMm, formatArea, formatLength, type DisplayUnit } from "../units";

/**
 * Properties panel (roadmap T-28): what's selected, as numbers you can
 * edit. A common section (layer, colour, construction) applies to the
 * whole selection; with exactly one entity selected its geometry is laid
 * out field by field — coordinates, radius, angles, text — plus the
 * read-only figures AutoCAD's Quick Properties shows (length, area,
 * circumference). Every edit is one `update-entity` per entity, so it
 * undoes like anything else.
 *
 * Lengths are shown and typed in the tab's display unit; angles in
 * degrees. A field commits on Enter or blur and reverts on Escape.
 */
export function PropertiesPanel({ onClose }: { onClose: () => void }) {
  const selection = useApp((s) => s.selection);
  const revision = useApp((s) => s.revision);
  const layers = useApp((s) => s.layers);
  const unit = useApp((s) => s.displayUnit);
  const entities = useMemo(
    () => selection.map((id) => doc.get(id)).filter((e): e is Entity => !!e),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selection, revision],
  );

  const applyAll = (patch: (e: Entity) => Entity) => {
    const commands: Command[] = entities.map((e) => ({ type: "update-entity", entity: patch(e) }));
    if (commands.length === 1) bus.execute(commands[0]);
    else if (commands.length > 1) bus.execute({ type: "batch", commands });
    useApp.getState().syncLayersFromDoc?.();
  };

  const common = (key: "layer" | "color" | "construction" | "linetype" | "lineweight") => {
    const values = new Set(entities.map((e) => (key === "layer" ? layerOf(e) : String(e[key] ?? ""))));
    return values.size === 1 ? [...values][0] : null;
  };

  return (
    <aside className="propspanel" data-testid="properties-panel">
      <div className="layerpanel-header">
        <span>Properties</span>
        <button className="btn ghost sm" onClick={onClose} title="Close">
          ✕
        </button>
      </div>
      {entities.length === 0 ? (
        <div className="propspanel-empty">Select something to see and edit its properties.</div>
      ) : (
        <div className="propspanel-body">
          <div className="propspanel-summary" data-testid="properties-summary">
            {summarize(entities)}
          </div>
          <Section title="Common">
            <Row label="Layer">
              <select
                className="propspanel-input"
                value={common("layer") ?? ""}
                data-testid="prop-layer"
                onChange={(e) => {
                  const layer = e.target.value;
                  applyAll((en) => (layer === "0" ? stripKey(en, "layer") : { ...en, layer }));
                }}
              >
                {common("layer") === null && <option value="">(varies)</option>}
                {layers.map((l) => (
                  <option key={l.name} value={l.name}>
                    {l.name}
                  </option>
                ))}
              </select>
            </Row>
            <Row label="Colour">
              <TextField
                value={common("color") ?? ""}
                placeholder={common("color") === null ? "(varies)" : "default"}
                testId="prop-color"
                onCommit={(v) => applyAll((en) => (v.trim() ? { ...en, color: v.trim() } : stripKey(en, "color")))}
              />
              <input
                type="color"
                className="propspanel-swatch"
                value={cssToHex(common("color") ?? "") ?? cssToHex(getComputedStyle(document.documentElement).getPropertyValue("--text").trim()) ?? "#dfe1e5"}
                onChange={(e) => applyAll((en) => ({ ...en, color: e.target.value }))}
                title="Pick a colour"
              />
            </Row>
            <Row label="Linetype">
              <select
                className="propspanel-input"
                value={common("linetype") ?? ""}
                data-testid="prop-linetype"
                onChange={(e) => {
                  const linetype = e.target.value;
                  applyAll((en) => (linetype ? { ...en, linetype } : stripKey(en, "linetype")));
                }}
              >
                <option value="">BYLAYER</option>
                {Object.values(BUILTIN_LINETYPES).map((lt) => (
                  <option key={lt.name} value={lt.name}>
                    {lt.name}
                  </option>
                ))}
              </select>
            </Row>
            <Row label="Lineweight (mm)">
              <TextField
                value={common("lineweight") ?? ""}
                placeholder={common("lineweight") === null ? "(varies)" : "BYLAYER"}
                testId="prop-lineweight"
                onCommit={(v) => {
                  const n = v.trim() === "" ? null : Number(v);
                  applyAll((en) => (n !== null && Number.isFinite(n) && n >= 0 ? { ...en, lineweight: n } : stripKey(en, "lineweight")));
                }}
              />
            </Row>
            <Row label="Construction">
              <input
                type="checkbox"
                data-testid="prop-dashed"
                checked={common("construction") === "true"}
                ref={(el) => {
                  if (el) el.indeterminate = common("construction") === null;
                }}
                onChange={(e) => applyAll((en) => (e.target.checked ? { ...en, construction: true } : stripKey(en, "construction")))}
              />
            </Row>
          </Section>
          <CustomBlockParams entities={entities} applyAll={applyAll} />
          <AnnotativeSection entities={entities} applyAll={applyAll} />
          {entities.length === 1 && <Geometry entity={entities[0]} unit={unit} />}
        </div>
      )}
    </aside>
  );
}

function stripKey(e: Entity, key: "layer" | "color" | "construction" | "linetype" | "lineweight" | "style" | "halign" | "valign" | "widthFactor" | "oblique"): Entity {
  const copy = { ...e } as Record<string, unknown>;
  delete copy[key];
  return copy as unknown as Entity;
}

function summarize(entities: Entity[]): string {
  if (entities.length === 1) return `1 ${entities[0].type}${entities[0].name ? ` · ${entities[0].name}` : ""}`;
  const counts = new Map<string, number>();
  for (const e of entities) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  return `${entities.length} selected: ${[...counts].map(([t, n]) => `${n} ${t}${n > 1 ? "s" : ""}`).join(", ")}`;
}

function cssToHex(c: string): string | null {
  return /^#[0-9a-f]{6}$/i.test(c) ? c : null;
}

/* ------------------------------- geometry -------------------------------- */

function Geometry({ entity, unit }: { entity: Entity; unit: DisplayUnit }) {
  const update = (e: Entity) => bus.execute({ type: "update-entity", entity: e });
  const deg = (rad: number) => (rad * 180) / Math.PI;
  const rad = (d: number) => (d * Math.PI) / 180;
  switch (entity.type) {
    case "line": {
      const len = dist(entity.a, entity.b);
      const ang = Math.atan2(entity.b.y - entity.a.y, entity.b.x - entity.a.x);
      return (
        <Section title="Line">
          <PointRow label="Start" p={entity.a} unit={unit} onCommit={(p) => update({ ...entity, a: p })} testId="prop-a" />
          <PointRow label="End" p={entity.b} unit={unit} onCommit={(p) => update({ ...entity, b: p })} testId="prop-b" />
          <LengthRow
            label="Length"
            value={len}
            unit={unit}
            testId="prop-length"
            onCommit={(v) => {
              if (len < 1e-12 || v <= 0) return;
              update({ ...entity, b: { x: entity.a.x + (Math.cos(ang) * v), y: entity.a.y + (Math.sin(ang) * v) } });
            }}
          />
          <NumberRow
            label="Angle"
            value={deg(ang)}
            suffix="°"
            testId="prop-angle"
            onCommit={(v) => update({ ...entity, b: { x: entity.a.x + Math.cos(rad(v)) * len, y: entity.a.y + Math.sin(rad(v)) * len } })}
          />
        </Section>
      );
    }
    case "circle":
      return (
        <Section title="Circle">
          <PointRow label="Center" p={entity.center} unit={unit} onCommit={(p) => update({ ...entity, center: p })} testId="prop-center" />
          <LengthRow label="Radius" value={entity.radius} unit={unit} testId="prop-radius" onCommit={(v) => v > 0 && update({ ...entity, radius: v })} />
          <LengthRow label="Diameter" value={entity.radius * 2} unit={unit} testId="prop-diameter" onCommit={(v) => v > 0 && update({ ...entity, radius: v / 2 })} />
          <ReadRow label="Circumference" value={formatLength(2 * Math.PI * entity.radius, unit)} />
          <ReadRow label="Area" value={formatArea(Math.PI * entity.radius * entity.radius, unit)} />
        </Section>
      );
    case "arc": {
      const sweep = arcSweep(entity.startAngle, entity.endAngle, entity.ccw);
      return (
        <Section title="Arc">
          <PointRow label="Center" p={entity.center} unit={unit} onCommit={(p) => update({ ...entity, center: p })} testId="prop-center" />
          <LengthRow label="Radius" value={entity.radius} unit={unit} testId="prop-radius" onCommit={(v) => v > 0 && update({ ...entity, radius: v })} />
          <NumberRow label="Start" value={deg(entity.startAngle)} suffix="°" testId="prop-start" onCommit={(v) => update({ ...entity, startAngle: rad(v) })} />
          <NumberRow label="End" value={deg(entity.endAngle)} suffix="°" testId="prop-end" onCommit={(v) => update({ ...entity, endAngle: rad(v) })} />
          <Row label="Direction">
            <select className="propspanel-input" value={entity.ccw ? "ccw" : "cw"} onChange={(e) => update({ ...entity, ccw: e.target.value === "ccw" })}>
              <option value="ccw">counterclockwise</option>
              <option value="cw">clockwise</option>
            </select>
          </Row>
          <ReadRow label="Sweep" value={`${round(deg(sweep))}°`} />
          <ReadRow label="Length" value={formatLength(entity.radius * sweep, unit)} />
          <ReadRow label="Start point" value={fmtPoint(arcPointAt(entity.center, entity.radius, entity.startAngle), unit)} />
          <ReadRow label="End point" value={fmtPoint(arcPointAt(entity.center, entity.radius, entity.endAngle), unit)} />
        </Section>
      );
    }
    case "ellipse": {
      const major = Math.hypot(entity.majorAxis.x, entity.majorAxis.y);
      const full = isFullEllipse(entity);
      const rotation = (Math.atan2(entity.majorAxis.y, entity.majorAxis.x) * 180) / Math.PI;
      const setMajor = (length: number, angleDeg: number) =>
        length > 0 && update({ ...entity, majorAxis: { x: length * Math.cos(rad(angleDeg)), y: length * Math.sin(rad(angleDeg)) } });
      return (
        <Section title={full ? "Ellipse" : "Elliptical arc"}>
          <PointRow label="Center" p={entity.center} unit={unit} onCommit={(p) => update({ ...entity, center: p })} testId="prop-center" />
          <LengthRow label="Major radius" value={major} unit={unit} testId="prop-major" onCommit={(v) => setMajor(v, rotation)} />
          <LengthRow label="Minor radius" value={major * entity.ratio} unit={unit} testId="prop-minor" onCommit={(v) => v > 0 && major > 0 && update({ ...entity, ratio: Math.min(1, v / major) })} />
          <NumberRow label="Rotation" value={round(rotation)} suffix="°" testId="prop-rotation" onCommit={(v) => setMajor(major, v)} />
          {full ? null : (
            <>
              <NumberRow label="Start" value={deg(entity.start)} suffix="°" testId="prop-start" onCommit={(v) => update({ ...entity, start: rad(v) })} />
              <NumberRow label="End" value={deg(entity.end)} suffix="°" testId="prop-end" onCommit={(v) => update({ ...entity, end: rad(v) })} />
              <ReadRow label="Sweep" value={`${round(deg(ellipseSweep(entity)))}°`} />
            </>
          )}
          <ReadRow label={full ? "Perimeter" : "Length"} value={formatLength(entityLength(entity) ?? 0, unit)} />
          {full && <ReadRow label="Area" value={formatArea(entityArea(entity) ?? 0, unit)} />}
        </Section>
      );
    }
    case "spline": {
      const [lo, hi] = nurbsDomain(entity);
      const rational = entity.weights?.some((w) => w !== 1) ?? false;
      return (
        <Section title="Spline">
          <ReadRow label="Degree" value={String(entity.degree)} />
          <ReadRow label="Control points" value={String(entity.controlPoints.length)} />
          <ReadRow label="Fit points" value={entity.fitPoints ? String(entity.fitPoints.length) : "none (edited by control points)"} />
          <ReadRow label="Kind" value={rational ? "rational (NURBS)" : "non-rational"} />
          <ReadRow label="Length" value={formatLength(entityLength(entity) ?? 0, unit)} />
          {entityArea(entity) !== null && <ReadRow label="Area" value={formatArea(entityArea(entity) ?? 0, unit)} />}
          <ReadRow label="Start point" value={fmtPoint(nurbsPointAt(entity, lo), unit)} />
          <ReadRow label="End point" value={fmtPoint(nurbsPointAt(entity, hi), unit)} />
          <Row label="Closed">
            <input type="checkbox" checked={entity.closed} data-testid="prop-closed" onChange={(e) => update({ ...entity, closed: e.target.checked })} />
          </Row>
          <SplineActions entity={entity} />
          <SplineHandles entity={entity} unit={unit} />
        </Section>
      );
    }
    case "hatch": {
      const p = entity.paint;
      return (
        <Section title="Hatch">
          <ReadRow label="Loops" value={String(entity.loops.length)} />
          {entity.sources && entity.sources.length > 0 && (
            <ReadRow label="Boundary" value={entity.boundaryLost ? "lost (open)" : entity.associative ? "associative" : "not associative"} />
          )}
          {p.kind === "pattern" ? (
            <>
              <Row label="Pattern">
                <TextField
                  value={p.name}
                  testId="prop-hatch-pattern"
                  onCommit={(v) => {
                    const { def: _def, ...rest } = p;
                    void _def;
                    if (v) update({ ...entity, paint: { ...rest, name: v } });
                  }}
                />
              </Row>
              <NumberRow label="Scale" value={p.scale} testId="prop-hatch-scale" onCommit={(v) => v > 0 && update({ ...entity, paint: { ...p, scale: v } })} />
              <NumberRow label="Angle" value={round(p.angle)} suffix="°" testId="prop-hatch-angle" onCommit={(v) => update({ ...entity, paint: { ...p, angle: v } })} />
            </>
          ) : p.kind === "solid" ? (
            <ReadRow label="Solid colour" value={p.color} />
          ) : (
            <>
              <Row label="Gradient">
                <select value={p.name.toUpperCase()} data-testid="prop-hatch-gradient" onChange={(e) => update({ ...entity, paint: { ...p, name: e.target.value } })}>
                  {GRADIENT_NAMES.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </Row>
              <NumberRow label="Angle" value={round(p.angle)} suffix="°" testId="prop-hatch-grad-angle" onCommit={(v) => update({ ...entity, paint: { ...p, angle: v } })} />
              <Row label="Colour 1">
                <TextField value={p.colors[0]} testId="prop-hatch-grad-c1" onCommit={(v) => v && update({ ...entity, paint: { ...p, colors: [v, p.colors[1]] } })} />
              </Row>
              <Row label="Colour 2">
                <TextField value={p.colors[1] ?? ""} testId="prop-hatch-grad-c2" onCommit={(v) => update({ ...entity, paint: { ...p, colors: v ? [p.colors[0], v] : [p.colors[0]] } })} />
              </Row>
            </>
          )}
          <NumberRow label="Transparency" value={Math.round((entity.transparency ?? 0) * 100)} suffix="%" testId="prop-hatch-transparency" onCommit={(v) => update(withTransparency(entity, Math.max(0, Math.min(100, v)) / 100))} />
          {p.kind === "pattern" && (
            <Row label="Background">
              <TextField value={entity.backgroundColor ?? ""} testId="prop-hatch-bg" onCommit={(v) => update(withBackground(entity, v))} />
            </Row>
          )}
          {p.kind === "pattern" && <PointRow label="Origin" p={p.origin ?? { x: 0, y: 0 }} unit={unit} testId="prop-hatch-origin" onCommit={(o) => update({ ...entity, paint: { ...p, origin: o } })} />}
          <Row label="Islands">
            <select
              value={entity.style}
              data-testid="prop-hatch-style"
              onChange={(e) => update({ ...entity, style: e.target.value as typeof entity.style })}
            >
              <option value="normal">Normal</option>
              <option value="outer">Outer</option>
              <option value="ignore">Ignore</option>
            </select>
          </Row>
          <HatchActions entity={entity} />
        </Section>
      );
    }
    case "polyline":
      return <PolylineGeometry entity={entity} unit={unit} />;
    case "point":
      return (
        <Section title="Point">
          <PointRow label="Position" p={entity.p} unit={unit} onCommit={(p) => update({ ...entity, p })} testId="prop-p" />
        </Section>
      );
    case "text":
      return (
        <Section title="Text">
          <Row label="Text">
            <TextField value={entity.text} testId="prop-text" onCommit={(v) => update({ ...entity, text: v })} />
          </Row>
          <PointRow label="Position" p={entity.at} unit={unit} onCommit={(p) => update({ ...entity, at: p })} testId="prop-at" />
          <LengthRow label="Height" value={entity.height} unit={unit} testId="prop-height" onCommit={(v) => v > 0 && update({ ...entity, height: v })} />
          <NumberRow label="Rotation" value={deg(entity.rotation)} suffix="°" testId="prop-rotation" onCommit={(v) => update({ ...entity, rotation: rad(v) })} />
          <Row label="Style">
            <select
              className="propspanel-input"
              value={entity.style ?? "Standard"}
              data-testid="prop-text-style"
              onChange={(e) => {
                const name = e.target.value;
                const preset = TEXT_STYLE_PRESETS.find((s) => s.name === name);
                const next = name === "Standard" ? stripKey(entity, "style") : { ...entity, style: name };
                // Picking a built-in preset the drawing doesn't have yet adds it to the table in the same undo step.
                if (preset && !doc.hasRecord("textStyles", name)) {
                  bus.execute({ type: "batch", commands: [{ type: "put-table-record", table: "textStyles", record: preset }, { type: "update-entity", entity: next }] });
                } else update(next);
              }}
            >
              {[...new Set(["Standard", ...TEXT_STYLE_PRESETS.map((s) => s.name), ...doc.records("textStyles").map((r) => r.name)])].map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </Row>
          <Row label="Align">
            <select
              className="propspanel-input"
              value={`${entity.halign ?? "left"}/${entity.valign ?? "baseline"}`}
              data-testid="prop-text-align"
              onChange={(e) => {
                const [h, v] = e.target.value.split("/");
                const base = stripKey(stripKey(entity, "halign"), "valign");
                update({ ...base, ...(h !== "left" ? { halign: h as "center" | "right" } : {}), ...(v !== "baseline" ? { valign: v as "bottom" | "middle" | "top" } : {}) });
              }}
            >
              {["left", "center", "right"].flatMap((h) => ["baseline", "bottom", "middle", "top"].map((v) => (
                <option key={`${h}/${v}`} value={`${h}/${v}`}>{h} / {v}</option>
              )))}
            </select>
          </Row>
          <NumberRow label="Width factor" value={entity.widthFactor ?? 1} testId="prop-text-width" onCommit={(v) => update(v > 0 && v !== 1 ? { ...entity, widthFactor: v } : stripKey(entity, "widthFactor"))} />
          <NumberRow label="Oblique" value={entity.oblique ?? 0} suffix="°" testId="prop-text-oblique" onCommit={(v) => update(v ? { ...entity, oblique: v } : stripKey(entity, "oblique"))} />
        </Section>
      );
    case "viewport":
      return (
        <Section title="Viewport">
          <PointRow label="Centre" p={entity.center} unit={unit} onCommit={(p) => update({ ...entity, center: p })} testId="prop-center" />
          <LengthRow label="Width" value={entity.width} unit={unit} testId="prop-width" onCommit={(v) => v > 0 && update({ ...entity, width: v })} />
          <LengthRow label="Height" value={entity.height} unit={unit} testId="prop-height" onCommit={(v) => v > 0 && update({ ...entity, height: v })} />
          <NumberRow label="Scale (paper:model)" value={entity.scale} testId="prop-vp-scale" onCommit={(v) => v > 0 && update({ ...entity, scale: v })} />
          <Row label="Locked">
            <input type="checkbox" checked={!!entity.locked} data-testid="prop-vp-locked" onChange={(ev) => update(ev.target.checked ? { ...entity, locked: true } : (({ locked: _l, ...rest }) => rest)(entity))} />
          </Row>
          <Row label="Frozen layers">
            <input
              type="text"
              defaultValue={(entity.frozenLayers ?? []).join(", ")}
              key={(entity.frozenLayers ?? []).join(",")}
              data-testid="prop-vp-frozen"
              onBlur={(ev) => {
                const names = ev.target.value.split(",").map((n) => n.trim()).filter(Boolean);
                update(names.length ? { ...entity, frozenLayers: names } : (({ frozenLayers: _f, ...rest }) => rest)(entity));
              }}
            />
          </Row>
        </Section>
      );
    case "image":
      return (
        <Section title="Image">
          <PointRow label="Insert" p={entity.insert} unit={unit} onCommit={(p) => update({ ...entity, insert: p })} testId="prop-insert" />
          <LengthRow label="Width" value={entity.width} unit={unit} testId="prop-width" onCommit={(v) => v > 0 && update({ ...entity, width: v })} />
          <LengthRow label="Height" value={entity.height} unit={unit} testId="prop-height" onCommit={(v) => v > 0 && update({ ...entity, height: v })} />
          <NumberRow label="Rotation" value={deg(entity.rotation)} suffix="°" testId="prop-rotation" onCommit={(v) => update({ ...entity, rotation: rad(v) })} />
        </Section>
      );
    case "insert":
      return <InsertGeometry entity={entity} unit={unit} />;
    default:
      return null; // a kind with no geometry editor yet
  }
}

/** B-10: an insert's placement, scale (with a uniform lock), array, attribute values and block swap. */
function InsertGeometry({ entity, unit }: { entity: InsertEntity; unit: DisplayUnit }) {
  const [lock, setLock] = useState(false);
  const update = (e: Entity) => bus.execute({ type: "update-entity", entity: e });
  const def = doc.getRecord("blocks", entity.block) as BlockDefinition | undefined;
  const names = (doc.records("blocks") as BlockDefinition[]).map((b) => b.name);
  const arr = entity.array;
  const f = factorFromMm(unit);
  const deg = (r: number) => (r * 180) / Math.PI;
  const attrs = editableAttributes(doc, entity);
  const tree = blockTree(doc, entity.block);
  const renderTree = (nodes: BlockTreeNode[], depth = 0): React.ReactNode =>
    nodes.map((n) => (
      <div key={`${depth}-${n.block}`} className="straighten-hint" style={{ paddingLeft: 8 + depth * 10 }}>
        {n.block} x{n.count}
        {renderTree(n.children, depth + 1)}
      </div>
    ));
  return (
    <Section title="Block">
      <Row label="Block">
        <select
          value={entity.block}
          data-testid="prop-block"
          onChange={(e) => {
            const to = e.target.value;
            if (to && to !== entity.block) update({ ...entity, block: to });
          }}
        >
          {!def && <option value={entity.block}>{entity.block} (missing)</option>}
          {names.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </Row>
      <PointRow label="Insert" p={entity.insert} unit={unit} onCommit={(p) => update({ ...entity, insert: p })} testId="prop-insert" />
      <NumberRow label="Scale X" value={entity.scale.x} testId="prop-scale-x" onCommit={(v) => update(withInsertScale(entity, def, "x", v, lock))} />
      <NumberRow label="Scale Y" value={entity.scale.y} testId="prop-scale-y" onCommit={(v) => update(withInsertScale(entity, def, "y", v, lock))} />
      <Row label="Uniform">
        <input type="checkbox" checked={lock || !!def?.scaleUniformly} disabled={!!def?.scaleUniformly} data-testid="prop-scale-lock" onChange={(e) => setLock(e.target.checked)} />
        {isMirroredInsert(entity) && <span className="straighten-hint"> mirrored</span>}
      </Row>
      <NumberRow label="Rotation" suffix="°" value={deg(entity.rotation)} testId="prop-rotation" onCommit={(v) => update({ ...entity, rotation: (v * Math.PI) / 180 })} />
      <NumberRow label="Columns" value={arr?.cols ?? 1} testId="prop-array-cols" onCommit={(v) => update(withInsertArray(entity, { cols: v }))} />
      <NumberRow label="Rows" value={arr?.rows ?? 1} testId="prop-array-rows" onCommit={(v) => update(withInsertArray(entity, { rows: v }))} />
      {arr && (
        <>
          <NumberRow label={`Column spacing (${unit})`} value={arr.colSpacing * f} testId="prop-array-colsp" onCommit={(v) => update(withInsertArray(entity, { colSpacing: v / f }))} />
          <NumberRow label={`Row spacing (${unit})`} value={arr.rowSpacing * f} testId="prop-array-rowsp" onCommit={(v) => update(withInsertArray(entity, { rowSpacing: v / f }))} />
        </>
      )}
      {attrs.map((a) => (
        <Row key={a.tag} label={a.prompt || a.tag}>
          <TextField
            value={entity.attributes[a.tag] ?? ""}
            placeholder={a.default ?? ""}
            testId={`prop-attr-${a.tag}`}
            onCommit={(v) => update(withAttributeValues(entity, { [a.tag]: v }))}
          />
        </Row>
      ))}
      {tree.length > 0 && (
        <div data-testid="prop-block-tree">
          <div className="straighten-hint">Contains</div>
          {renderTree(tree)}
        </div>
      )}
    </Section>
  );
}

/**
 * D-08/L-05: the "Annotative" section: a flag on text, mtext, dimensions, leaders, hatches and block inserts, the scales the
 * object supports, and "Add current scale" (the model-space annotation scale). Applies to the whole selection.
 */
function AnnotativeSection({ entities, applyAll }: { entities: Entity[]; applyAll: (patch: (e: Entity) => Entity) => void }) {
  const able = entities.filter(canBeAnnotative);
  if (able.length === 0) return null;
  const current = currentAnnotationScale(doc.settings);
  const on = able.filter(isAnnotative).length;
  const lists = new Set(able.filter(isAnnotative).map((e) => (e.annoScales?.length ? e.annoScales.join(", ") : "all")));
  const only = (fn: (e: Entity) => Entity | null) => applyAll((e) => (canBeAnnotative(e) ? (fn(e) ?? e) : e));
  return (
    <Section title="Annotative">
      <div data-testid="prop-annotative">
        <Row label="Annotative">
          <input
            type="checkbox"
            data-testid="prop-annotative-flag"
            checked={on === able.length}
            ref={(el) => {
              if (el) el.indeterminate = on > 0 && on < able.length;
            }}
            onChange={(e) => only((en) => withAnnotative(en, e.target.checked, current))}
          />
        </Row>
        {on > 0 && (
          <>
            <ReadRow label="Scales" value={lists.size === 1 ? [...lists][0] : "mixed"} />
            <div className="propspanel-row propspanel-actions">
              <button className="btn ghost sm" data-testid="prop-annotative-add" title={`Also show the selection at ${current}`} onClick={() => only((en) => withScaleAdded(en, current))}>
                Add {current}
              </button>
              <button className="btn ghost sm" data-testid="prop-annotative-remove" title={`Stop showing the selection at ${current}`} onClick={() => only((en) => withScaleRemoved(en, current))}>
                Remove {current}
              </button>
            </div>
          </>
        )}
      </div>
    </Section>
  );
}

/**
 * B-22: the "Custom" section of a dynamic block — one control per parameter
 * (number with its value set as a list, dropdown for visibility/lookup, flip
 * toggle) plus "Reset block". Shown when every selected entity is an insert of
 * the same dynamic block; an edit applies to all of them.
 */
function CustomBlockParams({ entities, applyAll }: { entities: Entity[]; applyAll: (patch: (e: Entity) => Entity) => void }) {
  const first = entities[0];
  if (!first || first.type !== "insert" || !entities.every((e) => e.type === "insert" && e.block === first.block)) return null;
  const def = doc.getRecord("blocks", first.block) as BlockDefinition | undefined;
  if (!def || !dynamicSpecOf(def)) return null;
  const fields = paramFields(def, first);
  const set = (key: string, value: number | string) => applyAll((e) => (e.type === "insert" ? withParamValue(def, e, key, value) : e));
  const deg = (r: number) => Math.round(((r * 180) / Math.PI) * 1000) / 1000;
  return (
    <Section title="Custom">
      <div data-testid="prop-custom">
        {fields.map((f) => (
          <Row key={f.key} label={f.label}>
            {f.control === "choice" || (f.control === "number" && f.options) ? (
              <select
                className="propspanel-input"
                value={String(f.value)}
                data-testid={`prop-param-${f.key}`}
                onChange={(e) => set(f.key, f.control === "choice" ? e.target.value : Number(e.target.value))}
              >
                {(f.options ?? []).map((o) => (
                  <option key={String(o)} value={String(o)}>
                    {String(o)}
                  </option>
                ))}
              </select>
            ) : f.control === "toggle" ? (
              <input type="checkbox" checked={f.value === 1} data-testid={`prop-param-${f.key}`} onChange={(e) => set(f.key, e.target.checked ? 1 : 0)} />
            ) : (
              <TextField
                value={String(f.control === "angle" ? deg(Number(f.value)) : round(Number(f.value)))}
                testId={`prop-param-${f.key}`}
                onCommit={(v) => {
                  const n = Number(v.trim());
                  if (Number.isFinite(n)) set(f.key, f.control === "angle" ? (n * Math.PI) / 180 : n);
                }}
              />
            )}
          </Row>
        ))}
        <Row label="">
          <button className="btn ghost sm" data-testid="prop-param-reset" onClick={() => applyAll((e) => (e.type === "insert" ? resetParams(e) : e))}>
            Reset block
          </button>
        </Row>
      </div>
    </Section>
  );
}

/** Show-CVs toggle and the end-tangent handles of a fit spline (C-07). */
function SplineHandles({ entity, unit }: { entity: SplineEntity; unit: DisplayUnit }) {
  const showCvs = useApp((s) => s.showSplineCvs);
  const setShowCvs = useApp((s) => s.setShowSplineCvs);
  const update = (e: Entity | null) => e && bus.execute({ type: "update-entity", entity: e });
  const first = entity.fitPoints?.[0];
  const last = entity.fitPoints?.[entity.fitPoints.length - 1];
  return (
    <>
      <Row label="Show CVs">
        <input type="checkbox" checked={showCvs} data-testid="prop-show-cvs" onChange={(e) => setShowCvs(e.target.checked)} />
      </Row>
      {entity.fitPoints && !entity.closed && first && last && (
        <>
          <ReadRow label="Start tangent" value={entity.startTangent ? fmtPoint(entity.startTangent, unit) : "free (drag its handle)"} />
          <ReadRow label="End tangent" value={entity.endTangent ? fmtPoint(entity.endTangent, unit) : "free (drag its handle)"} />
          {(entity.startTangent || entity.endTangent) && (
            <Row label="">
              <button
                className="btn ghost sm"
                title="Release both end tangents"
                data-testid="prop-clear-tangents"
                onClick={() => {
                  const { startTangent: _s, endTangent: _e, ...rest } = entity;
                  update(refitSpline(rest as SplineEntity, entity.fitPoints!));
                }}
              >
                Clear tangents
              </button>
            </Row>
          )}
        </>
      )}
    </>
  );
}

/** Spline editing actions (C-07): each is one undo step through `update-entity`. */
function SplineActions({ entity }: { entity: SplineEntity }) {
  const update = (e: Entity | null) => e && bus.execute({ type: "update-entity", entity: e });
  const [count, setCount] = useState(8);
  const points = entity.fitPoints ?? entity.controlPoints;
  const addAtWidestGap = () => {
    let best = 0;
    let at = { x: 0, y: 0 };
    for (let i = 1; i < points.length; i++) {
      const d = dist(points[i - 1], points[i]);
      if (d > best) {
        best = d;
        at = { x: (points[i - 1].x + points[i].x) / 2, y: (points[i - 1].y + points[i].y) / 2 };
      }
    }
    update(addSplinePoint(entity, at));
  };
  return (
    <>
      <div className="propspanel-row propspanel-actions">
        {entity.fitPoints && (
          <button className="btn ghost sm" title="Drop the fit points; edit the control points instead" data-testid="prop-to-cvs" onClick={() => update(splineToControlPoints(entity))}>
            Convert to CVs
          </button>
        )}
        <button className="btn ghost sm" title={`Add a ${entity.fitPoints ? "fit point" : "control point"} in the widest gap`} data-testid="prop-add-point" onClick={addAtWidestGap}>
          Add point
        </button>
        <button className="btn ghost sm" title="Remove the last point" data-testid="prop-remove-point" onClick={() => update(removeSplinePoint(entity, points.length - 1))}>
          Remove point
        </button>
      </div>
      <div className="propspanel-row propspanel-actions">
        <input type="number" min={2} max={500} value={count} data-testid="prop-rebuild-count" style={{ width: 56 }} onChange={(e) => setCount(Number(e.target.value))} />
        <button className="btn ghost sm" title="Refit as a cubic with this many control points" data-testid="prop-rebuild" onClick={() => update(rebuildSpline(entity, count))}>
          Rebuild
        </button>
        <button className="btn ghost sm" title="Replace with a polyline within 0.05 mm of the curve (arcs are refitted)" data-testid="prop-to-polyline" onClick={() => update(splineToPolyline(entity, 0.05))}>
          Convert to polyline
        </button>
      </div>
    </>
  );
}

function PolylineGeometry({ entity, unit }: { entity: PolylineEntity; unit: DisplayUnit }) {
  const update = (e: Entity) => bus.execute({ type: "update-entity", entity: e });
  const area = useMemo(() => (entity.closed ? findClosedRegions([entity])[0]?.area ?? null : null), [entity]);
  const [showVertices, setShowVertices] = useState(false);
  return (
    <Section title="Polyline">
      <ReadRow label="Vertices" value={String(entity.points.length)} />
      <Row label="Closed">
        <input type="checkbox" checked={entity.closed} data-testid="prop-closed" onChange={(e) => update({ ...entity, closed: e.target.checked })} />
      </Row>
      <ReadRow label="Length" value={formatLength(polylineLength(entity), unit)} />
      {area !== null && <ReadRow label="Area" value={formatArea(area, unit)} />}
      <div className="propspanel-row propspanel-actions">
        <button
          className="btn ghost sm"
          title="Replace with a smooth spline through the vertices"
          data-testid="prop-to-spline"
          onClick={() => {
            const s = polylineToSpline(entity);
            if (s) update(s);
          }}
        >
          Convert to spline
        </button>
        <button className="btn ghost sm" onClick={() => setShowVertices((v) => !v)} data-testid="prop-vertices-toggle">
          {showVertices ? "Hide vertices" : `Vertices (${entity.points.length})`}
        </button>
        <button
          className="btn ghost sm"
          title="Reverse the vertex order (flips the direction offset and arc legs follow)"
          data-testid="prop-reverse"
          onClick={() => update(reversePolyline(entity))}
        >
          Reverse
        </button>
      </div>
      {showVertices &&
        entity.points.map((p, i) => (
          <div key={i} className="propspanel-vertex">
            <PointRow
              label={`#${i + 1}`}
              p={p}
              unit={unit}
              testId={`prop-vertex-${i}`}
              onCommit={(np) => update({ ...entity, points: entity.points.map((q, j) => (j === i ? np : q)) })}
            />
            <div className="propspanel-vertex-actions">
              <button
                className="btn ghost sm"
                title="Insert a vertex after this one, at the middle of the next leg"
                data-testid={`prop-vertex-add-${i}`}
                onClick={() => update(insertVertexAfter(entity, i))}
              >
                +
              </button>
              <button
                className="btn ghost sm"
                title={(entity.bulges?.[i] ?? 0) !== 0 ? "Make the next leg straight" : "Make the next leg an arc (a slight bulge you can then grip)"}
                data-testid={`prop-vertex-arc-${i}`}
                disabled={!entity.closed && i === entity.points.length - 1}
                onClick={() => update(toggleLegArc(entity, i))}
              >
                {(entity.bulges?.[i] ?? 0) !== 0 ? "—" : "⌒"}
              </button>
              <button
                className="btn ghost sm"
                title="Remove this vertex"
                data-testid={`prop-vertex-remove-${i}`}
                disabled={entity.points.length <= 2}
                onClick={() => update(removeVertex(entity, i))}
              >
                ×
              </button>
            </div>
          </div>
        ))}
    </Section>
  );
}

/* ---------------------------- polyline editing ---------------------------- */

const legCount = (pl: PolylineEntity) => (pl.closed ? pl.points.length : pl.points.length - 1);
const bulgesOf = (pl: PolylineEntity) => Array.from({ length: legCount(pl) }, (_, i) => pl.bulges?.[i] ?? 0);
const withBulges = (pl: PolylineEntity, bulges: number[]): PolylineEntity =>
  bulges.some((b) => b !== 0) ? { ...pl, bulges } : (({ bulges: _b, ...rest }) => rest)(pl);

/** Reversed vertex order; each bulge moves to its leg's new index and flips sign. */
function reversePolyline(pl: PolylineEntity): PolylineEntity {
  const n = pl.points.length;
  const points = [...pl.points].reverse();
  const old = bulgesOf(pl);
  const bulges: number[] = [];
  for (let i = 0; i < legCount(pl); i++) {
    // New leg i runs from new point i to i+1 = old points (n-1-i) → (n-2-i), i.e. old leg (n-2-i) backwards.
    const oldLeg = ((n - 2 - i) % n + n) % n;
    bulges.push(-old[oldLeg]);
  }
  return withBulges({ ...pl, points }, bulges);
}

/** A new vertex at the middle of leg i (straight legs only keep the bulge split; an arc leg is split into two arcs of half the sweep). */
function insertVertexAfter(pl: PolylineEntity, i: number): PolylineEntity {
  const n = pl.points.length;
  const a = pl.points[i];
  const b = pl.points[(i + 1) % n];
  if (!pl.closed && i === n - 1) return { ...pl, points: [...pl.points, { x: a.x + 10, y: a.y }] };
  const old = bulgesOf(pl);
  const bulge = old[i] ?? 0;
  let mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  let half = 0;
  if (bulge !== 0) {
    const arc = bulgeToArc(a, b, bulge);
    if (arc) {
      const sweep = arcSweep(arc.startAngle, arc.endAngle, arc.ccw);
      const midAngle = arc.ccw ? arc.startAngle + sweep / 2 : arc.startAngle - sweep / 2;
      mid = arcPointAt(arc.center, arc.radius, midAngle);
      half = Math.tan(sweep / 8) * Math.sign(bulge);
    }
  }
  const points = [...pl.points.slice(0, i + 1), mid, ...pl.points.slice(i + 1)];
  const bulges = [...old.slice(0, i), half, half, ...old.slice(i + 1)];
  return withBulges({ ...pl, points }, bulges);
}

function removeVertex(pl: PolylineEntity, i: number): PolylineEntity {
  const points = pl.points.filter((_, j) => j !== i);
  const old = bulgesOf(pl);
  // The leg into the removed vertex and the leg out of it merge into one straight leg.
  const bulges = old.filter((_, j) => j !== i);
  if (i > 0 && i - 1 < bulges.length) bulges[i - 1] = 0;
  return withBulges({ ...pl, points }, bulges.slice(0, pl.closed ? points.length : points.length - 1));
}

function toggleLegArc(pl: PolylineEntity, i: number): PolylineEntity {
  const bulges = bulgesOf(pl);
  bulges[i] = bulges[i] !== 0 ? 0 : 0.3;
  return withBulges(pl, bulges);
}

/* --------------------------------- fields -------------------------------- */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="propspanel-section">
      <div className="propspanel-section-title">{title}</div>
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="propspanel-row">
      <span className="propspanel-label">{label}</span>
      <span className="propspanel-field">{children}</span>
    </label>
  );
}

function ReadRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="propspanel-row">
      <span className="propspanel-label">{label}</span>
      <span className="propspanel-read">{value}</span>
    </div>
  );
}

/** A text field that commits on Enter/blur and reverts on Escape, re-syncing when the value changes underneath it. */
function TextField({ value, onCommit, testId, placeholder }: { value: string; onCommit: (v: string) => void; testId?: string; placeholder?: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      className="propspanel-input"
      value={draft}
      placeholder={placeholder}
      data-testid={testId}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          if (draft !== value) onCommit(draft);
          (e.target as HTMLInputElement).blur();
        } else if (e.key === "Escape") {
          setDraft(value);
          (e.target as HTMLInputElement).blur();
        }
        e.stopPropagation();
      }}
    />
  );
}

function round(v: number): number {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? 0 : r;
}

/** A world length shown in the display unit; typed back with an optional unit suffix. */
function LengthRow({ label, value, unit, onCommit, testId }: { label: string; value: number; unit: DisplayUnit; onCommit: (worldValue: number) => void; testId?: string }) {
  const shown = String(round(value * factorFromMm(unit)));
  return (
    <Row label={`${label} (${unit})`}>
      <TextField
        value={shown}
        testId={testId}
        onCommit={(v) => {
          const w = parseLength(v, unit);
          if (w !== null) onCommit(w);
        }}
      />
    </Row>
  );
}

function NumberRow({ label, value, suffix, onCommit, testId }: { label: string; value: number; suffix?: string; onCommit: (v: number) => void; testId?: string }) {
  return (
    <Row label={`${label}${suffix ? ` (${suffix})` : ""}`}>
      <TextField
        value={String(round(value))}
        testId={testId}
        onCommit={(v) => {
          const n = Number(v.trim());
          if (Number.isFinite(n)) onCommit(n);
        }}
      />
    </Row>
  );
}

function PointRow({ label, p, unit, onCommit, testId }: { label: string; p: { x: number; y: number }; unit: DisplayUnit; onCommit: (p: { x: number; y: number }) => void; testId?: string }) {
  const f = factorFromMm(unit);
  return (
    <Row label={`${label} (${unit})`}>
      <TextField
        value={String(round(p.x * f))}
        testId={testId ? `${testId}-x` : undefined}
        onCommit={(v) => {
          const w = parseLength(v, unit);
          if (w !== null) onCommit({ x: w, y: p.y });
        }}
      />
      <TextField
        value={String(round(p.y * f))}
        testId={testId ? `${testId}-y` : undefined}
        onCommit={(v) => {
          const w = parseLength(v, unit);
          if (w !== null) onCommit({ x: p.x, y: w });
        }}
      />
    </Row>
  );
}

function fmtPoint(p: { x: number; y: number }, unit: DisplayUnit): string {
  return `${formatLength(p.x, unit)}, ${formatLength(p.y, unit)}`;
}

function withTransparency(h: HatchEntity, t: number): HatchEntity {
  const { transparency: _t, ...rest } = h;
  void _t;
  return t > 0 ? { ...rest, transparency: t } : rest;
}

function withBackground(h: HatchEntity, color: string): HatchEntity {
  const { backgroundColor: _b, ...rest } = h;
  void _b;
  return color ? { ...rest, backgroundColor: color } : rest;
}

function HatchActions({ entity }: { entity: HatchEntity }) {
  const [msg, setMsg] = useState("");
  const behind = (entity.drawOrder ?? 0) < 0;
  return (
    <>
      <div className="propspanel-row propspanel-actions">
        <button className="btn ghost sm" data-testid="prop-hatch-edit" title="Open this hatch in the Hatch panel" onClick={() => { const app = useApp.getState(); app.setHatchSettings(settingsFromHatch(entity)); app.setTool("fill"); app.setHatchEdit({ id: entity.id, pickOrigin: false }); }}>
          Edit…
        </button>
        <button className="btn ghost sm" data-testid="prop-hatch-boundary" title="Add the boundary as real entities" onClick={() => { const r = recreateBoundaryCommands(entity); bus.execute({ type: "batch", commands: r.commands }); useApp.getState().setSelection(r.ids); }}>
          Recreate boundary
        </button>
        <button className="btn ghost sm" data-testid="prop-hatch-explode" title="Replace the hatch by its lines (grouped)" onClick={() => { const c = explodeHatchCommands(entity); if (!c) setMsg("Too dense to explode"); else { bus.execute({ type: "batch", commands: c }); setMsg(""); } }}>
          Explode
        </button>
        <button className="btn ghost sm" data-testid="prop-hatch-behind" title="Draw the hatch behind (or back in front of) other geometry" onClick={() => bus.execute({ type: "update-entity", entity: setHatchDrawOrder(entity, behind ? 0 : -1) })}>
          {behind ? "Bring to front" : "Send behind"}
        </button>
      </div>
      {msg && <div className="propspanel-row">{msg}</div>}
    </>
  );
}
