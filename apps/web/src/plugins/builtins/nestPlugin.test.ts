import { describe, expect, it } from "vitest";
import type { Entity } from "@sketchor/plugin-sdk";
import {
  asPartSettings,
  asState,
  asStockRow,
  DEFAULT_CUT_TABLE,
  PANEL_HTML,
  resolvePart,
  SEED_STOCK,
  stableKey,
  type PersistedState,
} from "./nestPlugin";

/**
 * The panel runs inside the plugin sandbox, where a test can't reach it (see
 * `truckNestingPlugin.test.ts`'s own note on this) — so these test the pure
 * state/geometry helpers the message handlers are built on directly, plus
 * shallow `PANEL_HTML` content checks for the UI wiring. The one place a
 * bug here is expensive: `asState` silently discarding a user's stock list
 * or working set on a persisted-data shape it doesn't recognize.
 */

function rectPolyline(id: string, x: number, y: number, w: number, h: number): Entity {
  return {
    id,
    type: "polyline",
    closed: true,
    points: [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
    ],
  };
}

describe("asState", () => {
  it("seeds fresh defaults from nothing", () => {
    const state = asState(undefined);
    expect(state.stock).toEqual(SEED_STOCK.map((s) => ({ ...s, size: { ...s.size } })));
    expect(state.workingParts).toEqual([]);
    expect(state.gravity).toBe("bottom-left");
    expect(state.searchLevel).toBe("quick");
  });

  it("falls back to quick for an unrecognized search level", () => {
    expect(asState({ searchLevel: "ludicrous" }).searchLevel).toBe("quick");
    expect(asState({ searchLevel: "thorough" }).searchLevel).toBe("thorough");
  });

  it("treats the previous panel's data shape as absent rather than crashing", () => {
    // The old PersistedState: presets/lastPresetName/rotation/maxSheets —
    // a genuinely different model, not something to field-map from.
    const old = { presets: [{ name: "Ply", width: 2440, height: 1220 }], lastPresetName: "Ply", spacing: 3, rotation: "flip", maxSheets: 2 };
    const state = asState(old);
    expect(state.stock).toEqual(SEED_STOCK.map((s) => ({ ...s, size: { ...s.size } })));
    expect(state.workingParts).toEqual([]);
  });

  it("round-trips a valid stored state", () => {
    const valid: PersistedState = {
      stock: [{ size: { name: "Custom", width: 1000, height: 2000 }, material: "steel", thickness: 3, qty: 5, cost: 40 }],
      workingParts: [
        { key: "a,b", sourceIds: ["a", "b"], settings: { quantity: 2, rotationMode: "any", stepDeg: 5, mirror: true, allowInHoles: true } },
      ],
      spacing: 2,
      edgeMargin: 5,
      kerf: 0.2,
      gravity: "top-right",
      minHoleArea: 25,
      searchLevel: "normal",
      tabCount: 2,
      tabWidth: 4,
    };
    expect(asState(valid)).toEqual(valid);
  });

  it("never lets stock quantity or spacing go negative", () => {
    const state = asState({ stock: [{ size: { name: "x", width: 100, height: 100 }, qty: -5 }], spacing: -10, edgeMargin: -1, kerf: -1 });
    expect(state.stock[0].qty).toBe(0);
    expect(state.spacing).toBe(0);
    expect(state.edgeMargin).toBe(0);
    expect(state.kerf).toBe(0);
  });
});

describe("asStockRow", () => {
  it("null quantity means unlimited, and survives round-tripping", () => {
    const row = asStockRow({ size: { name: "Big", width: 1000, height: 2000 }, qty: null });
    expect(row?.qty).toBeNull();
  });

  it("drops empty optional fields instead of storing them as empty strings", () => {
    const row = asStockRow({ size: { name: "s", width: 1, height: 1 }, material: "", thickness: "", cost: "", qty: "" });
    expect(row?.material).toBeUndefined();
    expect(row?.thickness).toBeUndefined();
    expect(row?.cost).toBeUndefined();
    expect(row?.qty).toBeNull();
  });
});

describe("asPartSettings", () => {
  it("falls back to quarter-turn rotation for an unrecognized mode", () => {
    expect(asPartSettings({ rotationMode: "sideways" }).rotationMode).toBe("quarter");
  });

  it("defaults quantity to 1 when absent, never negative", () => {
    expect(asPartSettings({}).quantity).toBe(1);
    expect(asPartSettings({ quantity: -5 }).quantity).toBe(0);
  });

  it("defaults allowInHoles to false", () => {
    expect(asPartSettings({}).allowInHoles).toBe(false);
    expect(asPartSettings({ allowInHoles: true }).allowInHoles).toBe(true);
  });
});

describe("stableKey", () => {
  it("is order-independent", () => {
    expect(stableKey(["b", "a", "c"])).toBe(stableKey(["c", "a", "b"]));
  });

  it("distinguishes different id sets", () => {
    expect(stableKey(["a"])).not.toBe(stableKey(["a", "b"]));
  });
});

describe("resolvePart", () => {
  it("resolves a plain rectangle's outline, bbox and area", () => {
    const rect = rectPolyline("r1", 0, 0, 20, 10);
    const resolved = resolvePart([rect], ["r1"]);
    expect(resolved).not.toBeNull();
    expect(resolved!.w).toBeCloseTo(20, 6);
    expect(resolved!.h).toBeCloseTo(10, 6);
    expect(resolved!.area).toBeCloseTo(200, 6);
    expect(resolved!.holes).toHaveLength(0);
  });

  it("resolves a rectangle with a hole nested inside it", () => {
    const outer = rectPolyline("outer", 0, 0, 20, 20);
    const hole = rectPolyline("hole", 5, 5, 5, 5);
    const resolved = resolvePart([outer, hole], ["outer", "hole"]);
    expect(resolved).not.toBeNull();
    expect(resolved!.holes).toHaveLength(1);
    expect(resolved!.area).toBeCloseTo(400, 6); // net area from partExtraction is the outer's own area (holes tracked separately)
  });

  it("splits outer vs. hole source ids (N-31: routes each to its own DXF layer)", () => {
    const outer = rectPolyline("outer", 0, 0, 20, 20);
    const hole = rectPolyline("hole", 5, 5, 5, 5);
    const resolved = resolvePart([outer, hole], ["outer", "hole"]);
    expect(resolved!.outerSourceIds).toEqual(["outer"]);
    expect(resolved!.holeSourceIds).toEqual([["hole"]]);
  });

  it("returns null when the source entities no longer exist (e.g. deleted)", () => {
    expect(resolvePart([], ["gone"])).toBeNull();
  });

  it("is keyed the same way regardless of which entities array instance is passed, given the same ids", () => {
    const rect = rectPolyline("r1", 0, 0, 20, 10);
    const a = resolvePart([rect], ["r1"]);
    const b = resolvePart([{ ...rect }], ["r1"]);
    expect(a!.key).toBe(b!.key);
    expect(a!.key).toBe(stableKey(["r1"]));
  });
});

describe("the sheet metal nest panel", () => {
  it("has all four tabs", () => {
    for (const tab of ["parts", "sheets", "settings", "results"]) {
      expect(PANEL_HTML).toContain(`data-tab="${tab}"`);
    }
  });

  it("sends the message types the plugin side actually handles", () => {
    for (const type of ["ready", "persist", "add-selection", "remove-part", "update-part-settings", "clear", "check-nest", "nest", "cancel-nest", "export-dxf", "export-gcode", "print"]) {
      expect(PANEL_HTML).toContain(`type: "${type}"`);
    }
  });

  it("offers locked/quarter/any rotation, a mirror toggle and an in-holes toggle, not placeholders", () => {
    expect(PANEL_HTML).toContain("value='locked'");
    expect(PANEL_HTML).toContain("value='quarter'");
    expect(PANEL_HTML).toContain("value='any'");
    expect(PANEL_HTML).toContain("class='mirror'");
    // N-12: wired to a real settings field and message, not a dead checkbox.
    expect(PANEL_HTML).toContain("class='in-holes'");
    expect(PANEL_HTML).toContain("entry.settings.allowInHoles = e.target.checked");
    expect(PANEL_HTML).toContain('id="set-minhole"');
  });

  it("does not ship controls for features this pass doesn't back", () => {
    // N-30's report is now real (no separate "export-pdf" — Print produces
    // the PDF), N-40's G-code export is now real, and N-14's search level
    // is now a real setting (see the dedicated tests below for it).
    expect(PANEL_HTML).not.toContain("export-pdf");
  });

  it("offers a Quick/Normal/Thorough search level, wired to a real setting", () => {
    expect(PANEL_HTML).toContain('id="set-search"');
    expect(PANEL_HTML).toContain('<option value="quick">Quick</option>');
    expect(PANEL_HTML).toContain('<option value="normal">Normal</option>');
    expect(PANEL_HTML).toContain('<option value="thorough">Thorough</option>');
    expect(PANEL_HTML).toContain('state.searchLevel = $("set-search").value');
  });

  it("offers a Cancel button for an in-progress search, sent as its own message", () => {
    expect(PANEL_HTML).toContain('id="cancel-nest"');
    expect(PANEL_HTML).toContain('post({ type: "cancel-nest" })');
  });

  it("offers all four gravity corners", () => {
    for (const corner of ["bottom-left", "bottom-right", "top-left", "top-right"]) {
      expect(PANEL_HTML).toContain(`value="${corner}"`);
    }
  });

  it("offers a sheet picker for DXF export (N-31: all sheets or one), sent with the export request", () => {
    expect(PANEL_HTML).toContain('id="dxf-sheet"');
    expect(PANEL_HTML).toContain("All sheets");
    expect(PANEL_HTML).toContain('post({ type: "export-dxf", sheetIndex: Number($("dxf-sheet").value) })');
  });

  it("offers a per-sheet G-code export (N-40/43: one .nc per sheet, no all-sheets option)", () => {
    expect(PANEL_HTML).toContain('id="gcode-sheet"');
    expect(PANEL_HTML).toContain('post({ type: "export-gcode", sheetIndex: Number($("gcode-sheet").value) })');
  });
});

describe("DEFAULT_CUT_TABLE", () => {
  it("marks every seed row as an estimate", () => {
    expect(DEFAULT_CUT_TABLE.length).toBeGreaterThan(0);
    for (const row of DEFAULT_CUT_TABLE) expect(row.estimated).toBe(true);
  });
});
