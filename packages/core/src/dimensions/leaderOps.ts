import type { DimensionEntity } from "../entities";
import type { Point } from "../geometry";
import { newEntityId } from "../entities";
import type { DimBuildOptions } from "./build";
import type { BalloonShape } from "./leader";

/**
 * D-05: pure construction and editing of leaders. The tool only collects
 * clicks; which entity those make, and what "add / remove a leader line" or
 * "align" mean, lives here so it is tested without a canvas.
 */

export interface LeaderContent {
  /** Text, or the balloon's number. Empty / absent = a leader with no content. */
  text?: string;
  balloon?: BalloonShape;
  spline?: boolean;
}

/** A leader through `points` (arrow tip first, the last point carries the landing and content). Null with fewer than two distinct points. */
export function buildLeader(points: readonly Point[], content: LeaderContent = {}, o: DimBuildOptions = {}): DimensionEntity | null {
  const pts = points.filter((p, i) => i === 0 || Math.hypot(p.x - points[i - 1].x, p.y - points[i - 1].y) > 1e-9);
  if (pts.length < 2) return null;
  return {
    id: o.id ?? newEntityId(),
    type: "dimension",
    kind: "leader",
    defPoints: pts.map((p) => ({ x: p.x, y: p.y })),
    driving: false,
    ...(o.layer && o.layer !== "0" ? { layer: o.layer } : {}),
    ...(o.style ? { style: o.style } : {}),
    ...(content.text ? { textOverride: content.text } : {}),
    ...(content.balloon ? { balloon: content.balloon } : {}),
    ...(content.spline ? { leaderSpline: true } : {}),
  };
}

/** A multileader gains another line from `tip` to the attach point. */
export function addLeaderLine(d: DimensionEntity, tip: Point): DimensionEntity {
  if (d.kind !== "leader") return d;
  return { ...d, branches: [...(d.branches ?? []), [{ x: tip.x, y: tip.y }]] };
}

/** Number of leader lines (the main one plus branches). */
export function leaderLineCount(d: DimensionEntity): number {
  return d.kind === "leader" ? 1 + (d.branches?.length ?? 0) : 0;
}

/** Drops line `index` (0 = the main line; a branch then takes its place). Null when it is the only line or `index` is out of range. */
export function removeLeaderLine(d: DimensionEntity, index: number): DimensionEntity | null {
  if (d.kind !== "leader") return null;
  const branches = d.branches ?? [];
  if (index < 0 || index > branches.length || branches.length === 0) return null;
  const attach = d.defPoints[d.defPoints.length - 1];
  if (index === 0) {
    const [first, ...rest] = branches;
    const next: DimensionEntity = { ...d, defPoints: [...first, attach] };
    if (rest.length) next.branches = rest;
    else delete next.branches;
    return next;
  }
  const rest = branches.filter((_, i) => i !== index - 1);
  const next: DimensionEntity = { ...d };
  if (rest.length) next.branches = rest;
  else delete next.branches;
  return next;
}

/** The attach point of a leader (where landing and content hang). */
export function leaderAttach(d: DimensionEntity): Point {
  return d.defPoints[d.defPoints.length - 1];
}

/**
 * Aligns the content of several leaders: "horizontal" gives every attach point
 * the first leader's y (a row of callouts), "vertical" its x. Only the attach
 * point moves; tips stay on their geometry.
 */
export function alignLeaders(ds: readonly DimensionEntity[], mode: "horizontal" | "vertical"): DimensionEntity[] {
  const ls = ds.filter((d) => d.kind === "leader" && d.defPoints.length >= 2);
  if (ls.length < 2) return [];
  const ref = leaderAttach(ls[0]);
  return ls.map((d) => {
    const a = leaderAttach(d);
    const to = mode === "horizontal" ? { x: a.x, y: ref.y } : { x: ref.x, y: a.y };
    return { ...d, defPoints: [...d.defPoints.slice(0, -1), to] };
  });
}

/** Balloons stacked in a column below the first one's attach point, `pitch` apart (collect). Order follows the input. */
export function collectLeaders(ds: readonly DimensionEntity[], pitch: number): DimensionEntity[] {
  const ls = ds.filter((d) => d.kind === "leader" && d.defPoints.length >= 2);
  if (ls.length < 2) return [];
  const ref = leaderAttach(ls[0]);
  return ls.map((d, i) => ({ ...d, defPoints: [...d.defPoints.slice(0, -1), { x: ref.x, y: ref.y - i * pitch }] }));
}
