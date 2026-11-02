import { describe, expect, it } from "vitest";
import { SketchDocument, entityPoints, type Entity } from "@sketchor/core";
import { ALL_SNAPS_ON, apparentIntersections, findSnap, snapMovingSelection, snapRotation } from "./snapping";
import type { View } from "./view";

const view: View = { scale: 1, ox: 0, oy: 0 }; // 1 px = 1 world unit → snap tol = 10

function doc(...entities: Entity[]): SketchDocument {
  const d = new SketchDocument();
  for (const e of entities) d._put(e);
  return d;
}

function rect(id: string, x: number, y: number, w: number, h: number, extra: Partial<Entity> = {}): Entity {
  return {
    id,
    type: "polyline",
    points: [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
    ],
    closed: true,
    ...extra,
  } as Entity;
}

const verts = (...es: Entity[]) => es.flatMap((e) => entityPoints(e));

describe("snapMovingSelection", () => {
  it("leaves the offset alone when nothing is in range", () => {
    const a = rect("a", 0, 0, 100, 100);
    const b = rect("b", 500, 0, 100, 100);
    const out = snapMovingSelection(doc(a, b), view, verts(b), -50, -30, ["b"]);
    expect(out).toEqual({ dx: -50, dy: -30 });
  });

  it("pulls a dragged rect so its corner lands exactly on a neighbour's", () => {
    const a = rect("a", 0, 0, 1000, 1000); // right edge at x = 1000
    const b = rect("b", 1500, 0, 1000, 1000); // left edge at x = 1500
    // drag left by 495 — b's left edge would reach x = 1005, 5 short of a's edge
    const { dx, dy } = snapMovingSelection(doc(a, b), view, verts(b), -495, 0, ["b"]);
    expect(dx).toBeCloseTo(-500); // snapped the last 5 so the corners coincide
    expect(dy).toBeCloseTo(0);
  });

  it("snaps on any selection vertex, not just the first", () => {
    const a = rect("a", 0, 0, 1000, 1000);
    const b = rect("b", 1500, 0, 1000, 1000);
    // b's far corner (2500,1000) is nowhere near a; its near corner (1500,0) is
    // what should catch — order in the vertex list must not matter
    const shuffled = [...verts(b)].reverse();
    const { dx } = snapMovingSelection(doc(a, b), view, shuffled, -496, 0, ["b"]);
    expect(dx).toBeCloseTo(-500);
  });

  it("aligns a pallet's margin guide to a neighbour's guide", () => {
    // pallet A: shape 0..1000, dashed guide -30..1030
    const aShape = rect("as", 0, 0, 1000, 1000, { fill: "#e00" });
    const aGuide = rect("ag", -30, -30, 1060, 1060, { construction: true });
    // pallet B: shape 1700..2700, guide 1670..2730
    const bShape = rect("bs", 1700, 0, 1000, 1000, { fill: "#00e" });
    const bGuide = rect("bg", 1670, -30, 1060, 1060, { construction: true });
    const d = doc(aShape, aGuide, bShape, bGuide);
    // Drag B left by 697: B's guide left edge 1670 → 973, 3 past A's guide right
    // edge (1030)? no — 973 vs 1030 is 57 away. Aim so the guides meet: move
    // 1670 → 1030 needs -640; try -635 (5 short) and expect the guide corners to click.
    const { dx } = snapMovingSelection(d, view, verts(bShape, bGuide), -635, 0, ["bs", "bg"]);
    expect(dx).toBeCloseTo(-640); // B guide's (1670,-30) snapped onto A guide's (1030,-30)
  });

  it("does not snap the selection to its own geometry", () => {
    const b = rect("b", 1500, 50, 1000, 1000); // off both axes
    // only entity present is the one being moved — must be a free move
    const out = snapMovingSelection(doc(b), view, verts(b), -12, -8, ["b"]);
    expect(out).toEqual({ dx: -12, dy: -8 });
  });

  it("snaps the two axes independently — to different lines at once", () => {
    const vbar = rect("v", 1000, -5000, 10, 10000); // vertical edge, corners x ∈ {1000, 1010}
    const hbar = rect("h", -5000, 500, 10000, 10); // horizontal edge, corners y ∈ {500, 510}
    const b = rect("b", 1600, 900, 200, 200); // left edge x = 1600, bottom edge y = 900
    // drag toward x = 1000 (short by 4) and y = 500 (short by 4)
    const { dx, dy } = snapMovingSelection(doc(vbar, hbar, b), view, verts(b), -596, -396, ["b"]);
    expect(dx).toBeCloseTo(-600); // x caught on the vertical bar
    expect(dy).toBeCloseTo(-400); // y caught on the horizontal bar
  });

  it("slides an edge flush along another without pinning the free axis", () => {
    const a = rect("a", 0, 0, 1000, 1000);
    const b = rect("b", 1004, 400, 500, 500);
    const { dx, dy } = snapMovingSelection(doc(a, b), view, verts(b), 0, 250, ["b"]);
    expect(dx).toBeCloseTo(-4);
    expect(dy).toBeCloseTo(250);
  });
});

describe("snapRotation", () => {
  const deg = (d: number) => (d * Math.PI) / 180;
  it("rounds to the nearest 45°", () => {
    expect(snapRotation(deg(40), false)).toBeCloseTo(deg(45));
    expect(snapRotation(deg(20), false)).toBeCloseTo(0);
    expect(snapRotation(deg(80), false)).toBeCloseTo(deg(90));
    expect(snapRotation(deg(-50), false)).toBeCloseTo(deg(-45));
  });
  it("passes the angle through untouched when free (Ctrl held)", () => {
    expect(snapRotation(deg(37), true)).toBeCloseTo(deg(37));
  });
});

/**
 * Object snaps (T-21): what a click near geometry lands on. A missed
 * intersection or perpendicular foot means a line that almost meets — the
 * gap that later breaks a closed-region check or a laser toolpath.
 */
describe("findSnap object snaps", () => {
  const line = (id: string, ax: number, ay: number, bx: number, by: number): Entity => ({ id, type: "line", a: { x: ax, y: ay }, b: { x: bx, y: by } });
  const circle = (id: string, cx: number, cy: number, r: number): Entity => ({ id, type: "circle", center: { x: cx, y: cy }, radius: r });

  it("finds the intersection of a line and a circle, and of two arcs", () => {
    const d = doc(line("l", -100, 0, 100, 0), circle("c", 0, 0, 50));
    const s = findSnap(d, view, { x: 48, y: 3 });
    expect(s.kind).toBe("intersection");
    expect(s.point.x).toBeCloseTo(50, 9);
    expect(s.point.y).toBeCloseTo(0, 9);
    const two = doc(circle("a", 0, 0, 50), circle("b", 60, 0, 50));
    const t = findSnap(two, view, { x: 30, y: 38 });
    expect(t.kind).toBe("intersection");
    expect(t.point.x).toBeCloseTo(30, 9);
    expect(t.point.y).toBeCloseTo(40, 9);
  });

  it("finds the exact intersection of a line with an ellipse and with a spline (C-08), not a chord point", () => {
    const ellipse: Entity = { id: "e", type: "ellipse", center: { x: 0, y: 0 }, majorAxis: { x: 80, y: 0 }, ratio: 0.5, start: 0, end: Math.PI * 2 };
    const s = findSnap(doc(line("l", -100, 20, 100, 20), ellipse), view, { x: 66, y: 22 });
    expect(s.kind).toBe("intersection");
    // y = 20 on x²/80² + y²/40² = 1  →  x = 80·√(1 − 0.25)
    expect(s.point.x).toBeCloseTo(80 * Math.sqrt(0.75), 8);
    expect(s.point.y).toBeCloseTo(20, 8);
    const spline: Entity = { id: "s", type: "spline", degree: 3, closed: false, controlPoints: [{ x: 0, y: 0 }, { x: 30, y: 60 }, { x: 60, y: -60 }, { x: 90, y: 0 }], knots: [0, 0, 0, 0, 1, 1, 1, 1] };
    const hit = findSnap(doc(line("v", 45, -100, 45, 100), spline), view, { x: 46, y: 2 });
    expect(hit.kind).toBe("intersection");
    expect(hit.point.x).toBeCloseTo(45, 8);
  });

  it("snaps to the nearest point on a circle when nothing better is close", () => {
    const s = findSnap(doc(circle("c", 0, 0, 50)), view, { x: 33, y: 33 });
    expect(s.kind).toBe("on-line");
    expect(Math.hypot(s.point.x, s.point.y)).toBeCloseTo(50, 9);
  });

  it("offers the perpendicular foot and tangent points from the anchor", () => {
    const d = doc(line("l", 0, 0, 100, 0));
    const perp = findSnap(d, view, { x: 41, y: 4 }, { anchor: { x: 40, y: 30 } });
    expect(perp.kind).toBe("perpendicular");
    expect(perp.point).toEqual({ x: 40, y: 0 });
    // From (0, 100) the tangents to a radius-50 circle at the origin touch at (±... ) — one of them is near (43.3, 25).
    const c = doc(circle("c", 0, 0, 50));
    const tan = findSnap(c, view, { x: 43, y: 26 }, { anchor: { x: 0, y: 100 } });
    expect(tan.kind).toBe("tangent");
    expect(Math.hypot(tan.point.x, tan.point.y)).toBeCloseTo(50, 9);
    // The tangent line from the anchor really is perpendicular to the radius there.
    const dot = tan.point.x * (tan.point.x - 0) + tan.point.y * (tan.point.y - 100);
    expect(dot).toBeCloseTo(0, 6);
  });

  it("snaps along a line's extension past its end, with the guide from that end", () => {
    const s = findSnap(doc(line("l", 0, 0, 100, 0)), view, { x: 150, y: 3 });
    expect(s.kind).toBe("extension");
    expect(s.point).toEqual({ x: 150, y: 0 });
    expect(s.guideFrom).toEqual({ x: 100, y: 0 });
  });

  it("honours the per-kind switches", () => {
    const d = doc(line("l", 0, 0, 100, 0));
    const off = { ...ALL_SNAPS_ON, endpoint: false, extension: false, grid: false };
    expect(findSnap(d, view, { x: 3, y: 2 }).kind).toBe("endpoint");
    const s = findSnap(d, view, { x: 3, y: 2 }, { settings: off });
    expect(s.kind).not.toBe("endpoint");
    const far = findSnap(d, view, { x: 500, y: 500 }, { settings: off });
    expect(far.kind).toBe("grid");
    expect(far.point).toEqual({ x: 500, y: 500 }); // grid off: the raw cursor
  });

  it("marks point entities as nodes", () => {
    const s = findSnap(doc({ id: "p", type: "point", p: { x: 10, y: 10 } }), view, { x: 12, y: 9 });
    expect(s.kind).toBe("node");
  });

  it("T-21 apparent intersection: lines that stop short of each other snap where they would cross", () => {
    // The horizontal stops at x=40 and the vertical starts at y=20: extended they would cross at (60, 0).
    const d = doc(line("h", 0, 0, 40, 0), line("v", 60, 20, 60, 80));
    const s = findSnap(d, view, { x: 62, y: 3 });
    expect(s.kind).toBe("apparent");
    expect(s.point.x).toBeCloseTo(60, 9);
    expect(s.point.y).toBeCloseTo(0, 9);
  });

  it("apparent intersection outranks the nearest-point and extension tiers, but not a real feature point", () => {
    // The cursor is near both lines' extensions (extension tier) and on the vertical's body (nearest tier).
    const d = doc(line("h", 0, 0, 40, 0), line("v", 60, -30, 60, 80));
    expect(findSnap(d, view, { x: 61, y: 4 }).kind).toBe("apparent");
    // A real endpoint close by still wins.
    const e = doc(line("h", 0, 0, 40, 0), line("v", 60, 3, 60, 80));
    expect(findSnap(e, view, { x: 60, y: 4 }).kind).toBe("endpoint");
  });

  it("a real crossing is an intersection, not an apparent one; parallel lines never cross", () => {
    const crossing = doc(line("a", 0, 0, 100, 100), line("b", 0, 100, 100, 0));
    expect(findSnap(crossing, view, { x: 51, y: 49 }).kind).toBe("intersection");
    expect(apparentIntersections([{ a: { x: 0, y: 0 }, b: { x: 100, y: 100 } }, { a: { x: 0, y: 100 }, b: { x: 100, y: 0 } }], { x: 50, y: 50 }, 10)).toEqual([]);
    expect(apparentIntersections([{ a: { x: 0, y: 0 }, b: { x: 10, y: 0 } }, { a: { x: 0, y: 1 }, b: { x: 10, y: 1 } }], { x: 50, y: 0 }, 10)).toEqual([]);
  });

  it("apparent intersection honours its switch and ignores crossings absurdly far along the lines", () => {
    const d = doc(line("h", 0, 0, 40, 0), line("v", 60, 20, 60, 80));
    expect(findSnap(d, view, { x: 62, y: 3 }, { settings: { ...ALL_SNAPS_ON, apparent: false } }).kind).not.toBe("apparent");
    expect(apparentIntersections([{ a: { x: 0, y: 0 }, b: { x: 1, y: 0 } }, { a: { x: 500, y: 20 }, b: { x: 500, y: 80 } }], { x: 500, y: 0 }, 10)).toEqual([]);
  });

  it("an on-line snap on a straight piece names it, so the viewport can acquire it for a parallel snap", () => {
    const s = findSnap(doc(line("l", 0, 0, 100, 0)), view, { x: 30, y: 3 }, { settings: { ...ALL_SNAPS_ON, grid: false } });
    expect(s.kind).toBe("on-line");
    expect(s.refLine).toEqual({ a: { x: 0, y: 0 }, b: { x: 100, y: 0 } });
  });
});
