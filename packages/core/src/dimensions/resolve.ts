import { pointRefAt } from "../constraintDisplay";
import type { DimensionEntity, Entity, EntityId } from "../entities";
import type { Point } from "../geometry";
import { arcPointAt } from "../geometry";
import { activeDimHost, type DimHost } from "./context";
import { layoutDimension, type DimCircle, type DimGeometry, type DimLayout } from "./layout";
import { dimStyleOf, type DimStyle } from "./style";

/**
 * Turns a dimension's stored data plus the (optional) document into the plain
 * geometry the layout needs: associative references are followed when the
 * document holds the entities they name, otherwise `defPoints` stand.
 */

type Lookup = (id: EntityId) => Entity | undefined;

/** Circle/arc → what radial-family layouts need. */
function circleOf(e: Entity | undefined): DimCircle | undefined {
  if (!e) return undefined;
  if (e.type === "circle") return { center: e.center, radius: e.radius };
  if (e.type === "arc") return { center: e.center, radius: e.radius, start: e.startAngle, end: e.endAngle, ccw: e.ccw };
  return undefined;
}

export function resolveGeometry(e: DimensionEntity, lookup?: Lookup): DimGeometry {
  const pts: Point[] = e.defPoints.map((p, i) => {
    const ref = e.refs?.[i];
    if (ref && lookup) return pointRefAt(lookup, ref) ?? p;
    return p;
  });
  if (!lookup || !e.target) return { pts };
  const circle = circleOf(lookup(e.target));
  if (!circle) return { pts };
  // The circle's own centre / radius win; the stored second point keeps the direction.
  const next = pts.slice();
  next[0] = circle.center;
  if (e.kind === "arclength" && circle.start !== undefined && circle.end !== undefined && next.length >= 3) {
    next[1] = arcPointAt(circle.center, circle.radius, circle.start);
    next[2] = arcPointAt(circle.center, circle.radius, circle.end);
  }
  return { pts: next, circle };
}

export function dimStyleFor(e: DimensionEntity, host?: Pick<DimHost, "getRecord"> | null): DimStyle {
  const rec = e.style && host ? host.getRecord("dimStyles", e.style) : undefined;
  return dimStyleOf(rec, e.overrides, e.kind);
}

/** Layout of `e` against a host (default: the active document). */
export function layoutOf(e: DimensionEntity, host: DimHost | null = activeDimHost()): DimLayout {
  return layoutDimension(e, dimStyleFor(e, host), resolveGeometry(e, host ? (id) => host.get(id) : undefined));
}

/** The measured value of `e` right now (mm or radians); NaN if its geometry is degenerate. */
export function measureOf(e: DimensionEntity, host: DimHost | null = activeDimHost()): number {
  return layoutOf(e, host).measure;
}
