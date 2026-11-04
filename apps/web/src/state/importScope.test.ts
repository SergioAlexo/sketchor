// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { simplifyPolylineCommands, type Entity, type Point } from "@sketchor/core";
import { bus, doc, lastImportedEntities, overlayEntities } from "./store";

/**
 * P-03b: import-time Simplify must only touch what the import added. An
 * overlay lands on top of geometry the user already had; if Simplify ran on
 * the whole document, that earlier work would be silently altered.
 */
function dense(id: string, y: number): Entity {
  const points: Point[] = [];
  for (let i = 0; i <= 40; i++) points.push({ x: i, y: y + (i % 2 ? 0.001 : 0) });
  return { id, type: "polyline", layer: "0", points, closed: false } as unknown as Entity;
}

describe("import scope for Simplify", () => {
  it("lastImportedEntities excludes pre-existing polylines, even on an id collision", () => {
    bus.execute({ type: "add-entity", entity: dense("old", 0) });
    overlayEntities([dense("old", 10), dense("new2", 20)], "ovl");
    const got = lastImportedEntities();
    expect(got).toHaveLength(2);
    expect(got.every((e) => e.layer === "ovl")).toBe(true);
    expect(got.some((e) => e.id === "old")).toBe(false);
    const cmds = simplifyPolylineCommands(got, 0.1);
    expect(cmds.length).toBeGreaterThan(0);
    // the user's own polyline is untouched by those commands
    expect(JSON.stringify(cmds)).not.toContain('"id":"old"');
    expect(doc.get("old")).toBeDefined();
  });

  it("an empty import yields nothing to simplify", () => {
    overlayEntities([], "empty");
    expect(lastImportedEntities()).toEqual([]);
  });
});
