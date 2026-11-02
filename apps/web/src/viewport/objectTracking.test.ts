import { describe, expect, it } from "vitest";
import { acquireLine, acquirePoint, parallelTrack, trackAlignment, trackingAngles } from "./objectTracking";

/**
 * Object snap tracking is the difference between "roughly above that
 * corner" and exactly above it. If the projection is wrong the drawing is
 * quietly out of alignment by a pixel's worth of world units — the kind of
 * error that survives to the cutting machine — and if the two-point
 * intersection misfires, the cursor jumps somewhere the user never aimed,
 * which is worse than no tracking at all. Both are pinned here, along with
 * the guard rails that stop a guide firing when nothing really lines up.
 */

const corner = { x: 100, y: 100 };
const other = { x: 300, y: 40 };
const ortho = trackingAngles(90);

describe("trackAlignment", () => {
  it("pulls the cursor onto a vertical alignment and says where the guide starts", () => {
    const hit = trackAlignment({ x: 102, y: 250 }, [corner], ortho, 5);
    expect(hit).not.toBeNull();
    expect(hit!.point.x).toBeCloseTo(100, 9);
    expect(hit!.point.y).toBeCloseTo(250, 9);
    expect(hit!.rays).toHaveLength(1);
    expect(hit!.rays[0].from).toEqual(corner);
  });

  it("tracks backwards through the point as readily as forwards", () => {
    const hit = trackAlignment({ x: 98, y: -400 }, [corner], ortho, 5);
    expect(hit!.point.x).toBeCloseTo(100, 9);
    expect(hit!.point.y).toBeCloseTo(-400, 9);
  });

  it("stays out of the way when nothing lines up", () => {
    expect(trackAlignment({ x: 140, y: 250 }, [corner], ortho, 5)).toBeNull();
  });

  it("ignores the acquired point itself — that is the snap's job", () => {
    expect(trackAlignment({ x: 101, y: 101 }, [corner], ortho, 5)).toBeNull();
  });

  it("takes the crossing of two alignments over either one alone", () => {
    // Vertically above `corner`, horizontally level with `other`.
    const hit = trackAlignment({ x: 103, y: 38 }, [corner, other], ortho, 5);
    expect(hit!.rays).toHaveLength(2);
    expect(hit!.point.x).toBeCloseTo(100, 9);
    expect(hit!.point.y).toBeCloseTo(40, 9);
    expect(hit!.rays.map((r) => r.from)).toEqual(expect.arrayContaining([corner, other]));
  });

  it("won't cross two alignments that are nearly parallel", () => {
    // Both points offer the same vertical; their "intersection" is meaningless.
    const twin = { x: 100.5, y: -200 };
    const hit = trackAlignment({ x: 101, y: 400 }, [corner, twin], ortho, 5);
    expect(hit!.rays).toHaveLength(1);
  });

  it("follows polar increments when asked, not just the four ortho rays", () => {
    const at45 = trackAlignment({ x: 200, y: 201 }, [corner], trackingAngles(45), 5);
    expect(at45!.rays[0].angleDeg).toBe(45);
    expect(at45!.point.x).toBeCloseTo(200.5, 6);
    expect(at45!.point.y).toBeCloseTo(200.5, 6);
    // The same cursor has no ortho alignment at all.
    expect(trackAlignment({ x: 200, y: 201 }, [corner], ortho, 5)).toBeNull();
  });

  it("prefers the alignment the cursor is closest to", () => {
    // Two verticals in the aperture: the cursor is 1 off one and 5 off the
    // other. They are parallel, so there is no crossing to prefer instead.
    const near = { x: 100, y: 0 };
    const far = { x: 96, y: 0 };
    const hit = trackAlignment({ x: 101, y: 300 }, [far, near], ortho, 6);
    expect(hit!.rays).toHaveLength(1);
    expect(hit!.rays[0].from).toEqual(near);
    expect(hit!.point.x).toBeCloseTo(100, 9);
  });

  it("returns nothing rather than guessing when it has nothing to work from", () => {
    expect(trackAlignment({ x: 0, y: 0 }, [], ortho, 5)).toBeNull();
    expect(trackAlignment({ x: 0, y: 0 }, [corner], [], 5)).toBeNull();
    expect(trackAlignment({ x: 0, y: 0 }, [corner], ortho, 0)).toBeNull();
  });
});

describe("trackingAngles", () => {
  it("is the four ortho rays by default", () => {
    expect(trackingAngles(null)).toEqual([0, 90, 180, 270]);
  });

  it("walks the whole circle at the polar step", () => {
    expect(trackingAngles(45)).toEqual([0, 45, 90, 135, 180, 225, 270, 315]);
    expect(trackingAngles(30)).toHaveLength(12);
  });
});

describe("acquirePoint", () => {
  it("keeps the newest first and caps the list", () => {
    let acquired: { x: number; y: number }[] = [];
    for (const x of [1, 2, 3, 4]) acquired = acquirePoint(acquired, { x, y: 0 }, 3);
    expect(acquired.map((p) => p.x)).toEqual([4, 3, 2]);
  });

  it("re-acquiring a point promotes it instead of duplicating it", () => {
    // The cursor rests on a point across many move events; that must not
    // flush everything else out of the list.
    let acquired = [{ x: 1, y: 0 }, { x: 2, y: 0 }];
    for (let i = 0; i < 5; i++) acquired = acquirePoint(acquired, { x: 2, y: 0 }, 3);
    expect(acquired).toEqual([{ x: 2, y: 0 }, { x: 1, y: 0 }]);
  });
});

/**
 * Parallel snap (T-21): hover a line, then the cursor locks onto the ray from
 * the last point that runs parallel to it. A wrong direction here draws a
 * line a degree off "parallel" that no constraint check will catch later.
 */
describe("parallelTrack", () => {
  const ref = { a: { x: 0, y: 0 }, b: { x: 100, y: 50 } };
  const anchor = { x: 10, y: 200 };
  const dir = { x: 100 / Math.hypot(100, 50), y: 50 / Math.hypot(100, 50) };

  it("projects the cursor onto the parallel ray and reports the guide from the anchor", () => {
    const hit = parallelTrack({ x: 210, y: 301 }, anchor, [ref], 5)!;
    expect(hit).not.toBeNull();
    const v = { x: hit.point.x - anchor.x, y: hit.point.y - anchor.y };
    expect(v.x * dir.y - v.y * dir.x).toBeCloseTo(0, 9);
    expect(hit.ray.from).toEqual(anchor);
    expect(hit.ray.angleDeg).toBeCloseTo(Math.atan2(50, 100) * 180 / Math.PI, 9);
  });

  it("works backwards from the anchor too, and flips the guide angle", () => {
    const hit = parallelTrack({ x: -190, y: 100 }, anchor, [ref], 5)!;
    expect(hit.point.x).toBeLessThan(anchor.x);
    expect(Math.abs(hit.ray.angleDeg)).toBeGreaterThan(90);
  });

  it("says nothing when the cursor is off the ray, on the anchor, or there is no anchor / line", () => {
    expect(parallelTrack({ x: 210, y: 340 }, anchor, [ref], 5)).toBeNull();
    expect(parallelTrack({ x: 12, y: 201 }, anchor, [ref], 5)).toBeNull();
    expect(parallelTrack({ x: 210, y: 301 }, null, [ref], 5)).toBeNull();
    expect(parallelTrack({ x: 210, y: 301 }, anchor, [], 5)).toBeNull();
  });

  it("ignores a line the anchor sits on, and a zero-length line", () => {
    expect(parallelTrack({ x: 200, y: 100 }, { x: 40, y: 20 }, [ref], 5)).toBeNull();
    expect(parallelTrack({ x: 210, y: 301 }, anchor, [{ a: { x: 3, y: 3 }, b: { x: 3, y: 3 } }], 5)).toBeNull();
  });

  it("the nearest of several acquired lines wins", () => {
    const flat = { a: { x: 0, y: 0 }, b: { x: 50, y: 0 } };
    const hit = parallelTrack({ x: 300, y: 201 }, anchor, [ref, flat], 8)!;
    expect(hit.line).toBe(flat);
    expect(hit.point.y).toBeCloseTo(200, 9);
  });
});

describe("acquireLine", () => {
  const l1 = { a: { x: 0, y: 0 }, b: { x: 1, y: 0 } };
  const l2 = { a: { x: 0, y: 1 }, b: { x: 1, y: 1 } };
  it("newest first, no duplicates (either end order), capped", () => {
    let acq = acquireLine([], l1);
    acq = acquireLine(acq, l2);
    acq = acquireLine(acq, { a: l1.b, b: l1.a });
    expect(acq.length).toBe(2);
    expect(acq[0].a).toEqual(l1.b);
    const many = [1, 2, 3, 4].reduce((a, k) => acquireLine(a, { a: { x: 0, y: k }, b: { x: 1, y: k } }), [] as ReturnType<typeof acquireLine>);
    expect(many.length).toBe(3);
  });
});
