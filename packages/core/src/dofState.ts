import type { Command } from "./commands";
import { constraintEntityIds, type Constraint, type ConstraintId } from "./constraints";
import type { Entity, EntityId } from "./entities";
import type { SolveResult } from "./solver/solve";

/**
 * Degree-of-freedom feedback (roadmap T-44): which geometry the
 * constraints leave free to move (Onshape draws it blue), which they pin
 * down completely (the normal colour), and which sits in a set of
 * constraints that cannot all hold (red).
 *
 * Only geometry that appears in some constraint gets a state: a sketch
 * with no constraints at all is not "under-defined", it is just a drawing.
 */
export type DofState = "under" | "full" | "conflict";

export function entityDofStates(
  constraints: readonly Constraint[],
  solve: Pick<SolveResult, "conflicts" | "underDefined"> | null | undefined,
): Map<EntityId, DofState> {
  const out = new Map<EntityId, DofState>();
  if (!solve) return out;
  const under = new Set(solve.underDefined);
  const bad = new Set(solve.conflicts);
  for (const c of constraints) {
    for (const id of constraintEntityIds(c)) {
      if (out.get(id) === "conflict") continue;
      out.set(id, bad.has(c.id) ? "conflict" : under.has(id) ? "under" : "full");
    }
  }
  return out;
}

/**
 * The command that takes a conflicting constraint out of the way. A
 * driving dimension becomes a reference dimension (it keeps showing the
 * measured value but stops constraining); any other constraint is removed.
 */
export function resolveConflictCommand(constraintId: ConstraintId, lookup: (id: EntityId) => Entity | undefined): Command | null {
  if (constraintId.startsWith("dim:")) {
    const dim = lookup(constraintId.slice(4));
    return dim && dim.type === "dimension" ? { type: "update-entity", entity: { ...dim, driving: false } } : null;
  }
  return { type: "remove-constraint", id: constraintId };
}
