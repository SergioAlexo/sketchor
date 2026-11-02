import type { Entity, LineEntity } from "../entities";
import type { DynamicSpec } from "./dynamic";
import type { BlockDefinition } from "./types";

/**
 * Fixture dynamic blocks authored with our own spec (B-27): used by the
 * evaluator, authoring and DXF round-trip tests, and as the "Test block" the
 * editor can load. Clean-room, no AutoCAD-derived geometry.
 */

const line = (id: string, ax: number, ay: number, bx: number, by: number): LineEntity => ({ id, type: "line", a: { x: ax, y: ay }, b: { x: bx, y: by } });
const block = (name: string, entities: Entity[], dynamic: DynamicSpec, over: Partial<BlockDefinition> = {}): BlockDefinition => ({
  name,
  basePoint: { x: 0, y: 0 },
  entities,
  attributeDefs: [],
  explodable: true,
  scaleUniformly: false,
  dynamic,
  ...over,
});

/** A 900 x 100 window frame: stretchable width (600..1800 step 100) and a flip of the sill. */
export function fixtureWindow(): BlockDefinition {
  return block(
    "FX_WINDOW",
    [line("bot", 0, 0, 900, 0), line("top", 0, 100, 900, 100), line("l", 0, 0, 0, 100), line("r", 900, 0, 900, 100), line("sill", 0, 0, 900, -20)],
    {
      params: [
        { kind: "linear", name: "Width", label: "Width", base: { x: 0, y: 0 }, end: { x: 900, y: 0 }, values: { min: 600, max: 1800, increment: 100 } },
        { kind: "flip", name: "Flip", base: { x: 0, y: 50 }, end: { x: 900, y: 50 } },
      ],
      actions: [
        { kind: "stretch", param: "Width", frame: { min: { x: 800, y: -50 }, max: { x: 1000, y: 150 } } },
        { kind: "flip", param: "Flip" },
      ],
    },
  );
}

/** A door leaf with visibility states (single/double) and a lookup of standard widths. */
export function fixtureDoor(): BlockDefinition {
  return block(
    "FX_DOOR",
    [line("jambL", 0, 0, 0, 40), line("jambR", 900, 0, 900, 40), line("leafA", 0, 0, 450, 0), line("leafB", 450, 0, 900, 0)],
    {
      params: [
        { kind: "visibility", name: "Type" },
        { kind: "lookup", name: "Size", table: "sizes" },
        { kind: "linear", name: "Opening", base: { x: 0, y: 0 }, end: { x: 900, y: 0 }, values: { list: [700, 800, 900, 1000] } },
      ],
      actions: [
        { kind: "lookup", param: "Size" },
        { kind: "stretch", param: "Opening", frame: { min: { x: 800, y: -10 }, max: { x: 1000, y: 50 } } },
      ],
      visibilityStates: [
        { name: "Single", visible: ["leafA"] },
        { name: "Double", visible: ["leafA", "leafB"] },
      ],
      lookup: [
        {
          name: "sizes",
          inputs: ["Opening"],
          rows: [
            { label: "Standard", values: { Opening: 900 } },
            { label: "Narrow", values: { Opening: 700 } },
          ],
        },
      ],
    },
  );
}

/** Parametric route: a slot axis whose length is a constraint value. */
export function fixtureSlot(): BlockDefinition {
  return block(
    "FX_SLOT",
    [line("axis", 0, 0, 20, 0)],
    { params: [{ kind: "dimension", name: "Length", constraintId: "len" }], actions: [] },
    {
      constraints: [
        { id: "len", type: "distance", a: { entityId: "axis", point: "a" }, b: { entityId: "axis", point: "b" }, value: 20 },
        { id: "hz", type: "horizontal", entityId: "axis" },
      ],
    },
  );
}

export const fixtureBlocks = (): BlockDefinition[] => [fixtureWindow(), fixtureDoor(), fixtureSlot()];
