import type { Command } from "./commands";
import type { ArcEntity, Entity, LineEntity, PolylineEntity } from "./entities";
import { newEntityId, polylineSegments } from "./entities";
import { arcPointAt, bulgeToArc, dist, type Point } from "./geometry";
import { curveEnd, curveStart, entityFromPath, exactPathOf, joinContiguous, pathOf, type Curve, type XCurve } from "./intersect";
import { isFullEllipse, tessellateEllipse } from "./ellipse";
import type { NurbsData } from "./nurbs";

/**
 * Join and explode (roadmap T-22). Join chains lines, arcs and polylines
 * that meet end to end into one polyline (arcs become bulged legs) — the
 * step before offset, fillet-all-corners, or a cutter that wants one
 * closed contour. Explode is the inverse: a polyline back into lines and
 * arcs. Both are pure: they return the replacement entities, the caller
 * wraps them in one batch.
 */

const JOIN_TOL = 1e-6;

/**
 * Chains as many of `entities` as connect end to end into polylines. Each
 * chain becomes one polyline (closed when its ends meet); entities that
 * connect to nothing are left out of the result — the caller keeps them.
 * Returns the chains found (at least two members each), with the ids of
 * what each replaced.
 */
export function joinEntities(entities: Entity[], tolerance = JOIN_TOL): { polyline: PolylineEntity; replaced: string[] }[] {
  return chainEntities(entities, tolerance, false).map((c) => ({ polyline: c.entity as PolylineEntity, replaced: c.replaced }));
}

/**
 * Like {@link joinEntities}, but ellipses and splines take part and keep
 * their exactness: a chain of end-to-end splines of one degree becomes one
 * spline, and a chain that mixes curve kinds falls back to a polyline of
 * chords (a polyline cannot hold a true ellipse or NURBS).
 */
export function joinEntitiesExact(entities: Entity[], tolerance = JOIN_TOL): { entity: Entity; replaced: string[] }[] {
  return chainEntities(entities, tolerance, true);
}

function chainEntities(entities: Entity[], tolerance: number, exact: boolean): { entity: Entity; replaced: string[] }[] {
  const pieces: { id: string; curves: XCurve[]; source: Entity }[] = [];
  for (const e of entities) {
    const curved = e.type === "ellipse" || e.type === "spline";
    if (e.type !== "line" && e.type !== "arc" && e.type !== "polyline" && !curved) continue;
    if (e.type === "polyline" && e.closed) continue; // a closed loop can't chain further
    if (e.type === "ellipse" && isFullEllipse(e)) continue; // a full ellipse is a loop
    if (e.type === "spline" && e.closed) continue;
    const path = exact ? exactPathOf(e) : pathOf(e);
    if (path && path.curves.length > 0) pieces.push({ id: e.id, curves: path.curves, source: e });
  }
  const used = new Set<number>();
  const out: { entity: Entity; replaced: string[] }[] = [];
  for (let i = 0; i < pieces.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    let chain = [...pieces[i].curves];
    const replaced = [pieces[i].id];
    let grew = true;
    while (grew) {
      grew = false;
      const head = curveStart(chain[0]);
      const tail = curveEnd(chain[chain.length - 1]);
      if (dist(head, tail) < tolerance && chain.length > 1) break; // closed: done
      for (let j = 0; j < pieces.length; j++) {
        if (used.has(j)) continue;
        const c = pieces[j].curves;
        const s = curveStart(c[0]);
        const e = curveEnd(c[c.length - 1]);
        if (dist(tail, s) < tolerance) chain = [...chain, ...c];
        else if (dist(tail, e) < tolerance) chain = [...chain, ...reversed(c)];
        else if (dist(head, e) < tolerance) chain = [...c, ...chain];
        else if (dist(head, s) < tolerance) chain = [...reversed(c), ...chain];
        else continue;
        used.add(j);
        replaced.push(pieces[j].id);
        grew = true;
        break;
      }
    }
    if (replaced.length < 2) continue;
    const closed = dist(curveStart(chain[0]), curveEnd(chain[chain.length - 1])) < tolerance;
    const merged = exact ? joinContiguous(chain, closed) : chain;
    const built = entityFromPath({ curves: merged, closed }, pieces[i].source, newEntityId());
    if (!built) continue;
    const entity: Entity =
      built.type === "spline" || built.type === "ellipse"
        ? built
        : built.type === "polyline"
          ? built
          : // Two collinear lines join into one line by entityFromPath; keep it as a polyline for consistency.
            fromSingle(built);
    out.push({ entity, replaced });
  }
  return out;
}

function reversed(curves: XCurve[]): XCurve[] {
  return [...curves].reverse().flatMap((c): XCurve[] => {
    if (c.kind === "segment") return [{ kind: "segment", a: c.b, b: c.a }];
    // An ellipse is always stored counter-clockwise, so a reversed one has no exact form: its chords stand in.
    if (c.kind === "ellipse") {
      const pts = tessellateEllipse(c.e, 0.01);
      const out: XCurve[] = [];
      for (let i = pts.length - 1; i > 0; i--) out.push({ kind: "segment", a: pts[i], b: pts[i - 1] });
      return out;
    }
    if (c.kind === "nurbs") return [{ kind: "nurbs", s: reverseNurbs(c.s) }];
    return [{ ...c, startAngle: c.endAngle, endAngle: c.startAngle, ccw: !c.ccw }];
  });
}

function reverseNurbs(s: NurbsData): NurbsData {
  const lo = s.knots[0];
  const hi = s.knots[s.knots.length - 1];
  return {
    degree: s.degree,
    controlPoints: [...s.controlPoints].reverse(),
    knots: [...s.knots].reverse().map((k) => lo + hi - k),
    ...(s.weights ? { weights: [...s.weights].reverse() } : {}),
  };
}

function fromSingle(e: Entity): PolylineEntity {
  const props = {
    ...(e.layer !== undefined ? { layer: e.layer } : {}),
    ...(e.color !== undefined ? { color: e.color } : {}),
    ...(e.linetype !== undefined ? { linetype: e.linetype } : {}),
    ...(e.lineweight !== undefined ? { lineweight: e.lineweight } : {}),
    ...(e.linetypeScale !== undefined ? { linetypeScale: e.linetypeScale } : {}),
    ...(e.construction !== undefined ? { construction: e.construction } : {}),
  };
  if (e.type === "line") return { id: e.id, type: "polyline", ...props, points: [e.a, e.b], closed: false };
  if (e.type === "arc") {
    const a = arcPointAt(e.center, e.radius, e.startAngle);
    const b = arcPointAt(e.center, e.radius, e.endAngle);
    const sweep = e.ccw ? e.endAngle - e.startAngle : e.startAngle - e.endAngle;
    const norm = ((sweep % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    return { id: e.id, type: "polyline", ...props, points: [a, b], closed: false, bulges: [(e.ccw ? 1 : -1) * Math.tan(norm / 4)] };
  }
  return { id: e.id, type: "polyline", ...props, points: [], closed: false };
}

/** A polyline as separate lines and arcs (fresh ids), inheriting layer/colour/construction. */
export function explodePolyline(pl: PolylineEntity): (LineEntity | ArcEntity)[] {
  const props = {
    ...(pl.layer !== undefined ? { layer: pl.layer } : {}),
    ...(pl.color !== undefined ? { color: pl.color } : {}),
    ...(pl.linetype !== undefined ? { linetype: pl.linetype } : {}),
    ...(pl.lineweight !== undefined ? { lineweight: pl.lineweight } : {}),
    ...(pl.linetypeScale !== undefined ? { linetypeScale: pl.linetypeScale } : {}),
    ...(pl.construction !== undefined ? { construction: pl.construction } : {}),
  };
  const out: (LineEntity | ArcEntity)[] = [];
  for (const seg of polylineSegments(pl)) {
    if (dist(seg.a, seg.b) < 1e-12) continue;
    const arc = bulgeToArc(seg.a, seg.b, seg.bulge);
    if (arc) out.push({ id: newEntityId(), type: "arc", ...props, ...arc });
    else out.push({ id: newEntityId(), type: "line", ...props, a: seg.a, b: seg.b });
  }
  return out;
}

/** Commands for joining a selection: one batch replacing every chained entity with its polyline. Empty when nothing chains. */
export function joinCommands(entities: Entity[]): Command[] {
  const chains = joinEntitiesExact(entities);
  if (chains.length === 0) return [];
  const commands: Command[] = [];
  for (const c of chains) {
    commands.push({ type: "delete-entities", ids: c.replaced });
    commands.push({ type: "add-entity", entity: c.entity });
  }
  return commands;
}

/** Commands for exploding every polyline in a selection. Empty when there are none. */
export function explodeCommands(entities: Entity[]): Command[] {
  const commands: Command[] = [];
  for (const e of entities) {
    if (e.type !== "polyline") continue;
    const parts = explodePolyline(e);
    if (parts.length === 0) continue;
    commands.push({ type: "delete-entities", ids: [e.id] });
    for (const p of parts) commands.push({ type: "add-entity", entity: p });
  }
  return commands;
}

/** Points along an entity's path: `count` equal divisions (count−1 interior points), or every `spacing` from the start. */
export function pointsAlong(entity: Entity, opts: { divisions?: number; spacing?: number }): Point[] {
  const path = pathOf(entity);
  if (!path) return [];
  const lengths = path.curves.map((c) => (c.kind === "segment" ? dist(c.a, c.b) : c.radius * arcSweepOf(c)));
  const total = lengths.reduce((a, b) => a + b, 0);
  if (total <= 0) return [];
  const targets: number[] = [];
  if (opts.divisions && opts.divisions >= 2) {
    for (let i = 1; i < opts.divisions; i++) targets.push((total * i) / opts.divisions);
    if (path.closed) targets.push(0);
  } else if (opts.spacing && opts.spacing > 0) {
    for (let d = opts.spacing; d <= total + 1e-9; d += opts.spacing) targets.push(Math.min(d, total));
  }
  const out: Point[] = [];
  for (const t of targets) {
    let acc = 0;
    for (let i = 0; i < path.curves.length; i++) {
      if (t <= acc + lengths[i] + 1e-9) {
        const u = lengths[i] > 0 ? (t - acc) / lengths[i] : 0;
        out.push(pointOn(path.curves[i], Math.max(0, Math.min(1, u))));
        break;
      }
      acc += lengths[i];
    }
  }
  return out;
}

function arcSweepOf(c: Extract<Curve, { kind: "arc" }>): number {
  if (c.full) return Math.PI * 2;
  const raw = c.ccw ? c.endAngle - c.startAngle : c.startAngle - c.endAngle;
  const s = ((raw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  return s === 0 ? Math.PI * 2 : s;
}

function pointOn(c: Curve, t: number): Point {
  if (c.kind === "segment") return { x: c.a.x + (c.b.x - c.a.x) * t, y: c.a.y + (c.b.y - c.a.y) * t };
  const sweep = arcSweepOf(c) * (c.ccw || c.full ? 1 : -1);
  return arcPointAt(c.center, c.radius, c.startAngle + sweep * t);
}
