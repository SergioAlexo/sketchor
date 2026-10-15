import { constraintEntityIds, type Constraint, type ConstraintId, type PointRef } from "../constraints";
import type { Entity, EntityId } from "../entities";
import type { Point } from "../geometry";
import { applyModel, buildModel, freeIndices, freezeEntity, pointOf, type SketchModel } from "./model";
import { addFootParams } from "./footCurves";
import { allRows, type Row } from "./residuals";
import { konst, sub, type Num } from "./num";

/**
 * The constraint solver (roadmap T-40).
 *
 * Constraints are equations (see residuals.ts) and the sketch's numbers
 * are the unknowns (see model.ts); solving is least squares by
 * Levenberg–Marquardt, which is the standard choice for this shape of
 * problem: it behaves like Gauss–Newton near a solution, where it
 * converges in a handful of iterations, and like gradient descent far
 * from one, where Gauss–Newton would fly off. Sketches have tens of
 * unknowns, so dense linear algebra is not worth avoiding.
 *
 * The public face is {@link solveSketch}: hand it the document's entities
 * and constraints, get back the entities that moved, the remaining
 * degrees of freedom, and the constraints it could not satisfy. It is
 * deliberately a pure function over plain data so it can run anywhere —
 * on the bus after a command, inside a drag, or one day in a worker —
 * and so that a different engine could be dropped in behind it.
 */

/** The constraint id the drag's temporary pull is filed under; never a real constraint. */
const DRAG = "@drag";

export type SolveStatus =
  /** Free to move: the sketch has degrees of freedom left. */
  | "under-constrained"
  /** Exactly determined — every degree of freedom is accounted for. */
  | "fully-constrained"
  /** Constraints that can't all hold at once; `conflicts` names them. */
  | "over-constrained";

export interface SolveResult {
  /** Entities whose geometry changed, ready to become `update-entity` commands. */
  updates: Entity[];
  status: SolveStatus;
  /** Remaining degrees of freedom: free parameters minus independent equations. */
  dof: number;
  /** Constraints still violated after solving (empty unless over-constrained). */
  conflicts: ConstraintId[];
  /** Constraints that add no information — satisfied, but implied by the others. */
  redundant: ConstraintId[];
  /** Entities with a parameter the constraints leave free to move (T-44); fixed and fully pinned ones are absent. */
  underDefined: EntityId[];
  /** Largest residual left, in mm or radians; below `tolerance` means solved. */
  residual: number;
  iterations: number;
  /** False when the solver ran out of iterations without converging. */
  converged: boolean;
}

export interface SolveOptions {
  /** Entities to hold still (in addition to any `fix` constraints) — the rest of a drag. */
  fixed?: readonly EntityId[];
  /**
   * A point being dragged and where the cursor wants it. Solved in two
   * passes (see {@link solveSketch}) so the sketch follows the cursor as
   * far as its constraints allow, instead of either refusing to move or
   * bending a constraint to get there.
   */
  drag?: { ref: PointRef; to: Point };
  /** Convergence threshold, in mm / radians. */
  tolerance?: number;
  maxIterations?: number;
}

// Tight enough that a radius constraint of 4 comes back as 4, not
// 3.9999999999994: Gauss–Newton converges quadratically near the
// solution, so the last digits cost an iteration or two, and a sketch
// that can't reach this still reports its real residual.
const DEFAULT_TOLERANCE = 1e-12;
const DEFAULT_MAX_ITERATIONS = 64;

/**
 * Solves `constraints` over `entities`, returning what moved and how constrained the sketch now is.
 *
 * K-02: the sketch is first split into independent connected components
 * (entities linked by a constraint) and each is solved on its own, so a
 * drawing with twenty constrained sketches in it costs twenty small solves
 * rather than one system whose dense linear algebra grows with the cube of
 * everything. Entities no constraint mentions are not solved at all; they
 * only contribute their free parameters to the DoF count.
 */
export function solveSketch(
  entities: readonly Entity[],
  constraints: readonly Constraint[],
  options: SolveOptions = {},
): SolveResult {
  const groups = components(constraints);

  const owner = new Map<EntityId, number>();
  groups.forEach((g, i) => g.entities.forEach((id) => owner.set(id, i)));
  const members: Entity[][] = groups.map(() => []);
  const loose: Entity[] = [];
  for (const e of entities) {
    const i = owner.get(e.id);
    if (i === undefined) loose.push(e);
    else members[i].push(e);
  }
  const dragAt = options.drag ? owner.get(options.drag.ref.entityId) : undefined;
  const parts: SolveResult[] = groups.map((g, i) =>
    solveComponent(members[i], g.constraints, {
      ...options,
      fixed: options.fixed?.filter((id) => owner.get(id) === i),
      drag: i === dragAt ? options.drag : undefined,
    }),
  );
  // Unconstrained geometry: nothing to solve, but its freedom still counts.
  if (loose.length > 0) parts.push(solveComponent(loose, [], { ...options, drag: undefined, fixed: options.fixed?.filter((id) => !owner.has(id)) }));

  const out: SolveResult = {
    updates: [],
    status: "fully-constrained",
    dof: 0,
    conflicts: [],
    redundant: [],
    underDefined: [],
    residual: 0,
    iterations: 0,
    converged: true,
  };
  for (const r of parts) {
    out.updates.push(...r.updates);
    out.dof += r.dof;
    out.conflicts.push(...r.conflicts);
    out.redundant.push(...r.redundant);
    out.underDefined.push(...r.underDefined);
    out.residual = Math.max(out.residual, r.residual);
    out.iterations += r.iterations;
    out.converged = out.converged && r.converged;
  }
  out.status = out.conflicts.length > 0 ? "over-constrained" : out.dof === 0 ? "fully-constrained" : "under-constrained";
  return out;
}

/** Constraints grouped by shared entities (union-find), each with the entity ids it touches. */
function components(constraints: readonly Constraint[]): { constraints: Constraint[]; entities: Set<EntityId> }[] {
  const parent = new Map<EntityId, EntityId>();
  const find = (x: EntityId): EntityId => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = x;
    while (cur !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  for (const c of constraints) {
    const ids = constraintEntityIds(c);
    for (const id of ids) if (!parent.has(id)) parent.set(id, id);
    for (let i = 1; i < ids.length; i++) parent.set(find(ids[i]), find(ids[0]));
  }
  const byRoot = new Map<EntityId, { constraints: Constraint[]; entities: Set<EntityId> }>();
  for (const c of constraints) {
    const ids = constraintEntityIds(c);
    if (ids.length === 0) continue;
    const root = find(ids[0]);
    let g = byRoot.get(root);
    if (!g) byRoot.set(root, (g = { constraints: [], entities: new Set() }));
    g.constraints.push(c);
    for (const id of ids) g.entities.add(id);
  }
  return [...byRoot.values()];
}

function solveComponent(
  entities: readonly Entity[],
  constraints: readonly Constraint[],
  options: SolveOptions = {},
): SolveResult {
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const referenced = new Set<EntityId>();
  for (const c of constraints) for (const id of constraintEntityIds(c)) referenced.add(id);
  const model = buildModel(entities, referenced);
  addFootParams(model, constraints);
  for (const c of constraints) if (c.type === "fix") freezeEntity(model, c.entityId);
  for (const id of options.fixed ?? []) freezeEntity(model, id);

  const free = freeIndices(model);
  const column = new Map<number, number>();
  free.forEach((paramIndex, col) => column.set(paramIndex, col));

  const rowsAt = (values: readonly number[], withDrag: boolean): Row[] => {
    const at: SketchModel = { ...model, values: [...values] };
    const rows = allRows(at, constraints);
    const drag = withDrag ? options.drag : undefined;
    if (drag) {
      const p = pointOf(at, drag.ref);
      if (p) {
        rows.push(
          { constraint: DRAG, residual: sub(p.x, konst(drag.to.x)) },
          { constraint: DRAG, residual: sub(p.y, konst(drag.to.y)) },
        );
      }
    }
    return rows;
  };

  /** Levenberg–Marquardt from `start`, returning where it got to. */
  const run = (start: readonly number[], withDrag: boolean) => {
    const values = [...start];
    let rows = rowsAt(values, withDrag);
    let lambda = 1e-6;
    let stalled = 0;
    let iterations = 0;
    let converged = maxResidual(rows) <= tolerance;
    while (!converged && iterations < maxIterations && rows.length > 0 && free.length > 0) {
      iterations += 1;
      const step = lmStep(rows, column, free.length, lambda);
      if (!step) break;
      const candidate = [...values];
      for (let i = 0; i < free.length; i++) candidate[free[i]] += step[i];
      const next = rowsAt(candidate, withDrag);
      if (sumSquares(next) < sumSquares(rows)) {
        // Downhill: accept, and trust the linear model a little more.
        for (let i = 0; i < candidate.length; i++) values[i] = candidate[i];
        rows = next;
        lambda = Math.max(lambda * 0.3, 1e-12);
        converged = maxResidual(rows) <= tolerance;
      } else {
        // Uphill: the step was too long — damp harder and try again.
        lambda *= 8;
        stalled += 1;
        if (lambda > 1e12 || stalled > 12) break;
      }
    }
    return { values, rows, iterations };
  };

  /**
   * A drag is solved in two passes. The first includes the cursor's pull
   * as just another equation, which lands somewhere between what the
   * cursor wants and what the constraints allow. The second drops the
   * pull and re-solves the constraints alone from there: because each
   * step is the minimum-norm one, that projects the sketch back onto
   * exactly-satisfied constraints without giving up the ground the drag
   * gained. Weighting the pull instead — one soft equation against the
   * hard ones — is the obvious approach and the wrong one: it leaves
   * every constraint slightly violated in proportion to how hard the user
   * is pulling.
   */
  const first = run(model.values, !!options.drag);
  const second = options.drag ? run(first.values, false) : null;
  const values = second ? second.values : first.values;
  const rows = second ? second.rows : first.rows;
  const iterations = first.iterations + (second?.iterations ?? 0);

  const residual = maxResidual(rows);
  // Diagnosis is done on the *constraint* rows only: the drag's pull is a
  // temporary wish, not a statement about how constrained the sketch is.
  const constraintRows = rows.filter((r) => r.constraint !== DRAG);
  const rank = jacobianRank(constraintRows, column, free.length);
  const dof = Math.max(0, free.length - rank);
  const violated = new Set<ConstraintId>();
  for (const r of constraintRows) if (Math.abs(r.residual.v) > Math.max(tolerance, 1e-6)) violated.add(r.constraint);

  const under = underDefinedColumns(constraintRows, column, free.length);
  const underDefined: EntityId[] = [];
  for (const [id, ep] of model.byEntity) {
    for (let k = ep.start; k < ep.start + ep.count; k++) {
      const col = column.get(k);
      if (col !== undefined && under.has(col)) {
        underDefined.push(id);
        break;
      }
    }
  }

  const status: SolveStatus =
    violated.size > 0 ? "over-constrained" : dof === 0 ? "fully-constrained" : "under-constrained";

  return {
    updates: applyModel(model, values),
    status,
    dof,
    conflicts: [...violated],
    underDefined,
    redundant: violated.size === 0 ? redundantConstraints(constraintRows, column, free.length, rank) : [],
    residual,
    iterations,
    converged: residual <= Math.max(tolerance, 1e-6),
  };
}

function maxResidual(rows: readonly Row[]): number {
  let worst = 0;
  for (const r of rows) worst = Math.max(worst, Math.abs(r.residual.v));
  return worst;
}

function sumSquares(rows: readonly Row[]): number {
  let total = 0;
  for (const r of rows) total += r.residual.v * r.residual.v;
  return total;
}

/**
 * One Levenberg–Marquardt step: solve (JᵀJ + λ‖diag‖∞ I) δ = −Jᵀr.
 *
 * The damping is **uniform**, scaled by the largest diagonal entry rather
 * than by each entry individually. A sketch is almost always rank
 * deficient — one `parallel` constraint against four free coordinates
 * leaves three directions the equations say nothing about — and
 * per-entry damping leaves those directions damped by nearly nothing, so
 * the solve returns an enormous step through the null space: the line
 * comes back parallel *and* three times longer. Uniform damping makes
 * the step the minimum-norm one, which is also the answer a user wants —
 * move the geometry as little as the constraint allows.
 */
function lmStep(rows: readonly Row[], column: ReadonlyMap<number, number>, n: number, lambda: number): number[] | null {
  const a: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const b = new Array<number>(n).fill(0);
  for (const row of rows) {
    const grad: [number, number][] = [];
    for (const [paramIndex, g] of row.residual.d) {
      const col = column.get(paramIndex);
      if (col !== undefined && g !== 0) grad.push([col, g]);
    }
    for (const [i, gi] of grad) {
      b[i] -= gi * row.residual.v;
      for (const [j, gj] of grad) a[i][j] += gi * gj;
    }
  }
  let maxDiag = 0;
  for (let i = 0; i < n; i++) maxDiag = Math.max(maxDiag, a[i][i]);
  const damping = lambda * Math.max(maxDiag, 1e-12);
  for (let i = 0; i < n; i++) a[i][i] += damping;
  return solveLinear(a, b);
}

/** Gaussian elimination with partial pivoting; null when the system is singular. */
function solveLinear(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  // Singularity is judged relative to the matrix's own scale, so the same
  // sketch drawn in metres and in millimetres is solved the same way.
  let biggest = 1e-300;
  for (const row of a) for (const v of row) biggest = Math.max(biggest, Math.abs(v));
  const epsilon = biggest * 1e-14;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    if (Math.abs(a[pivot][col]) < epsilon) return null;
    if (pivot !== col) {
      [a[pivot], a[col]] = [a[col], a[pivot]];
      [b[pivot], b[col]] = [b[col], b[pivot]];
    }
    for (let r = col + 1; r < n; r++) {
      const factor = a[r][col] / a[col][col];
      if (factor === 0) continue;
      for (let c = col; c < n; c++) a[r][c] -= factor * a[col][c];
      b[r] -= factor * b[col];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row--) {
    let sum = b[row];
    for (let c = row + 1; c < n; c++) sum -= a[row][c] * x[c];
    x[row] = sum / a[row][row];
  }
  return x.every((v) => Number.isFinite(v)) ? x : null;
}

/** Dense Jacobian rows, in solver column order. */
function denseRows(rows: readonly Row[], column: ReadonlyMap<number, number>, n: number): number[][] {
  return rows.map((row) => {
    const dense = new Array<number>(n).fill(0);
    for (const [paramIndex, g] of row.residual.d) {
      const col = column.get(paramIndex);
      if (col !== undefined) dense[col] += g;
    }
    return dense;
  });
}

/**
 * How many independent equations the constraints actually amount to —
 * the number that decides the degrees of freedom. Row echelon with
 * partial pivoting; the tolerance is relative to the largest pivot, so a
 * sketch in metres and one in millimetres are diagnosed the same way.
 */
export function jacobianRank(rows: readonly Row[], column: ReadonlyMap<number, number>, n: number): number {
  const m = denseRows(rows, column, n);
  return rankOf(m, n);
}

function rankOf(m: number[][], n: number): number {
  return reduce(m, n).rank;
}

/** Gauss–Jordan elimination in place; returns the rank and which column each independent row pivots on. */
function reduce(m: number[][], n: number): { rank: number; pivots: number[]; epsilon: number } {
  const pivots: number[] = [];
  let scale = 1e-12;
  for (const row of m) for (const v of row) scale = Math.max(scale, Math.abs(v));
  const epsilon = scale * 1e-9;
  let rank = 0;
  for (let col = 0; col < n && rank < m.length; col++) {
    let pivot = -1;
    let best = epsilon;
    for (let r = rank; r < m.length; r++) {
      if (Math.abs(m[r][col]) > best) {
        best = Math.abs(m[r][col]);
        pivot = r;
      }
    }
    if (pivot < 0) continue;
    pivots.push(col);
    [m[rank], m[pivot]] = [m[pivot], m[rank]];
    for (let r = 0; r < m.length; r++) {
      if (r === rank || m[r][col] === 0) continue;
      const factor = m[r][col] / m[rank][col];
      for (let c = col; c < n; c++) m[r][c] -= factor * m[rank][c];
    }
    rank += 1;
  }
  return { rank, pivots, epsilon };
}

/**
 * Columns (solver parameters) the constraints do not pin down: those that
 * can still move along some direction the equations say nothing about.
 * With the Jacobian in reduced row-echelon form, a non-pivot column is
 * free outright, and a pivot column is free if its row still leans on a
 * free column — i.e. it is not determined by the constraints alone.
 */
export function underDefinedColumns(rows: readonly Row[], column: ReadonlyMap<number, number>, n: number): Set<number> {
  const m = denseRows(rows, column, n);
  const { rank, pivots, epsilon } = reduce(m, n);
  const isPivot = new Set(pivots);
  const out = new Set<number>();
  for (let c = 0; c < n; c++) if (!isPivot.has(c)) out.add(c);
  for (let r = 0; r < rank; r++) {
    const lead = Math.abs(m[r][pivots[r]]);
    for (const f of out) {
      if (isPivot.has(f)) continue;
      if (Math.abs(m[r][f]) > Math.max(epsilon, lead * 1e-9)) {
        out.add(pivots[r]);
        break;
      }
    }
  }
  return out;
}

/**
 * Constraints that are satisfied but add nothing — a rectangle told twice
 * that two sides are parallel. Found by dropping each constraint's rows
 * and seeing whether the rank survives; that is O(constraints × rank) and
 * fine at sketch scale, and it names the constraint rather than merely
 * reporting that one of them is redundant.
 */
function redundantConstraints(
  rows: readonly Row[],
  column: ReadonlyMap<number, number>,
  n: number,
  rank: number,
): ConstraintId[] {
  if (rows.length === 0 || rank === rows.length) return [];
  const ids = [...new Set(rows.map((r) => r.constraint))];
  const out: ConstraintId[] = [];
  for (const id of ids) {
    const without = rows.filter((r) => r.constraint !== id);
    if (without.length === rows.length) continue;
    if (jacobianRank(without, column, n) === rank) out.push(id);
  }
  return out;
}
