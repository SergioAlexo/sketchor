import { useMemo } from "react";
import type { Constraint, Entity } from "@sketchor/core";
import {
  buildConstraints,
  constraintEntityIds,
  constraintOptions,
  newConstraintId,
  resolveConflictCommand,
  CONSTRAINT_LABELS,
  type ConstraintKind,
} from "@sketchor/core";
import { bus, doc, useApp } from "../state/store";
import { formatLength } from "../units";

/**
 * The constraints panel (roadmap T-41): apply a constraint to what's
 * selected, and see what the sketch already has.
 *
 * Onshape's model — select the geometry, then press the constraint —
 * rather than a modal tool per constraint. Which buttons light up is
 * decided by `constraintBuilder.ts` in the core, and a disabled one says
 * what it would need instead of just being grey.
 *
 * The list below is the other half of the feature: constraints are
 * invisible by nature, so a sketch you can't inspect is a sketch you
 * can't fix. Hovering a row highlights the geometry it holds; the ✕
 * removes it; conflicting ones are called out, since those are the reason
 * a sketch stops behaving.
 */

/** Compact glyphs, in the spirit of the ones every CAD app draws next to constrained geometry. */
export const CONSTRAINT_GLYPHS: Record<ConstraintKind, string> = {
  coincident: "●",
  horizontal: "—",
  vertical: "|",
  parallel: "∥",
  perpendicular: "⊥",
  tangent: "◡",
  equal: "=",
  distance: "↔",
  radius: "R",
  angle: "∠",
  fix: "⚓",
  concentric: "◎",
  midpoint: "◐",
  symmetric: "⋈",
  collinear: "⋯",
  "point-on-curve": "⊙",
};

export function ConstraintPanel({ onClose }: { onClose: () => void }) {
  const selection = useApp((s) => s.selection);
  const revision = useApp((s) => s.revision);
  const unit = useApp((s) => s.displayUnit);
  const setSelection = useApp((s) => s.setSelection);
  const showGlyphs = useApp((s) => s.showConstraintGlyphs);
  const setShowGlyphs = useApp((s) => s.setShowConstraintGlyphs);
  const highlight = useApp((s) => s.highlightedConstraint);
  const setHighlight = useApp((s) => s.setHighlightedConstraint);

  const entities = useMemo(
    () => selection.map((id) => doc.get(id)).filter((e): e is Entity => !!e),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selection, revision],
  );
  const options = useMemo(() => constraintOptions(entities), [entities]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const constraints = useMemo(() => doc.constraints(), [revision]);
  const solve = useMemo(() => bus.lastSolve, [revision]); // eslint-disable-line react-hooks/exhaustive-deps
  const conflicts = new Set(solve?.conflicts ?? []);
  const redundant = new Set(solve?.redundant ?? []);
  const showDof = useApp((s) => s.showDofColours);
  const setShowDof = useApp((s) => s.setShowDofColours);
  // Conflicts can include constraints derived from driving dimensions, which doc.constraints() doesn't list.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const conflicting = useMemo(() => doc.solverConstraints().filter((c) => conflicts.has(c.id)), [revision, solve]);

  const apply = (kind: ConstraintKind) => {
    const result = buildConstraints(kind, entities, { newId: newConstraintId });
    if ("error" in result) return;
    // One batch: the constraints and the geometry the solver then moves
    // are a single act, and a single undo.
    bus.execute(
      result.constraints.length === 1
        ? { type: "add-constraint", constraint: result.constraints[0] }
        : { type: "batch", commands: result.constraints.map((constraint) => ({ type: "add-constraint", constraint })) },
    );
  };

  const describe = (c: Constraint): string => {
    const label = CONSTRAINT_LABELS[c.type];
    if (c.type === "distance") return `${label} ${formatLength(c.value, unit)}`;
    if (c.type === "radius") return `${label} ${formatLength(c.value, unit)}`;
    if (c.type === "angle") return `${label} ${Math.round((c.value * 180) / Math.PI)}°`;
    return label;
  };

  return (
    <aside className="propspanel" data-testid="constraint-panel">
      <div className="layerpanel-header">
        <span>Constraints</span>
        <button className="btn ghost sm" onClick={onClose} title="Close">
          ✕
        </button>
      </div>

      <div className="constraint-grid" data-testid="constraint-buttons">
        {options.map((option) => (
          <button
            key={option.kind}
            className="constraint-btn"
            disabled={!option.enabled}
            title={`${CONSTRAINT_LABELS[option.kind]} — ${option.hint}`}
            data-testid={`constraint-${option.kind}`}
            onClick={() => apply(option.kind)}
          >
            <span className="constraint-glyph">{CONSTRAINT_GLYPHS[option.kind]}</span>
            <span className="constraint-name">{CONSTRAINT_LABELS[option.kind]}</span>
          </button>
        ))}
      </div>

      <div className="constraint-listhead">
        <span>{constraints.length} in this sketch</span>
        <label title="Draw a glyph next to each constrained entity">
          <input type="checkbox" checked={showGlyphs} onChange={(e) => setShowGlyphs(e.target.checked)} data-testid="toggle-glyphs" />
          Glyphs
        </label>
        <label title="Tint constrained geometry: blue = still free to move, red = in conflict">
          <input type="checkbox" checked={showDof} onChange={(e) => setShowDof(e.target.checked)} data-testid="toggle-dof-colours" />
          DOF colours
        </label>
      </div>

      {conflicting.length > 0 && (
        <div className="constraint-conflicts" data-testid="constraint-conflicts">
          <div className="constraint-listhead">
            <span>{conflicting.length} conflicting</span>
          </div>
          {conflicting.map((c) => {
            const isDim = c.id.startsWith("dim:");
            const fix = resolveConflictCommand(c.id, (id) => doc.get(id));
            return (
              <div key={c.id} className="constraint-row conflict" onPointerEnter={() => setHighlight(c.id)} data-testid={`conflict-row-${c.id}`}>
                <span className="constraint-glyph">{CONSTRAINT_GLYPHS[c.type]}</span>
                <span className="constraint-name">{describe(c)}</span>
                <button
                  className="btn ghost sm"
                  disabled={!fix}
                  title={isDim ? "Keep the dimension but stop it driving the geometry" : "Remove this constraint"}
                  data-testid={`conflict-fix-${c.id}`}
                  onClick={() => fix && bus.execute(fix)}
                >
                  {isDim ? "Make reference" : "Delete"}
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div className="constraint-list" onPointerLeave={() => setHighlight(null)}>
        {constraints.length === 0 && <div className="constraint-empty">Select geometry above and apply a constraint.</div>}
        {constraints.map((c) => (
          <div
            key={c.id}
            className={`constraint-row ${conflicts.has(c.id) ? "conflict" : ""} ${redundant.has(c.id) ? "redundant" : ""} ${highlight === c.id ? "hovered" : ""}`}
            data-testid={`constraint-row-${c.id}`}
            onPointerEnter={() => setHighlight(c.id)}
            onClick={() => setSelection(constraintEntityIds(c).filter((id) => !!doc.get(id)))}
            title={
              conflicts.has(c.id)
                ? "Part of a set of constraints that can't all hold at once"
                : redundant.has(c.id)
                  ? "Already implied by the other constraints"
                  : "Click to select the geometry this holds"
            }
          >
            <span className="constraint-glyph">{CONSTRAINT_GLYPHS[c.type]}</span>
            <span className="constraint-name">{describe(c)}</span>
            <button
              className="layer-del"
              title="Remove this constraint"
              data-testid={`constraint-remove-${c.id}`}
              onClick={(e) => {
                e.stopPropagation();
                bus.execute({ type: "remove-constraint", id: c.id });
              }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </aside>
  );
}
