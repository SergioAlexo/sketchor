import { describe, expect, it } from "vitest";
import type { Command, DocumentReadModel } from "@sketchor/plugin-sdk";
import {
  buildNestLayout,
  clearPreviousLayout,
  forPaper,
  LOAD_PLAN_GUIDE_LAYER,
  LOAD_PLAN_LAYER,
  readLivePlacements,
  setDimensionsOnLayout,
} from "./layout";
import { nestByOrders } from "./nest";
import type { Order, TrailerProfile } from "./types";

/** A minimal in-memory reducer standing in for the host's document.apply — enough to test command output against. */
function applyCommands(m: DocumentReadModel, cmds: Command[]): DocumentReadModel {
  let entities = [...m.entities];
  let groups = [...m.groups];
  for (const c of cmds) {
    if (c.type === "add-entity") entities.push(c.entity);
    else if (c.type === "delete-entities") entities = entities.filter((e) => !c.ids.includes(e.id));
    else if (c.type === "group-entities") groups.push({ id: c.groupId, name: c.name ?? "", members: c.ids });
    else if (c.type === "ungroup") groups = groups.filter((g) => g.id !== c.groupId);
  }
  return { revision: m.revision + 1, entities, groups, constraints: m.constraints };
}

const trailer: TrailerProfile = { name: "T", length: 13600, width: 2480 };
const orders: Order[] = [
  {
    id: "leeds",
    jobNumber: "PO-1",
    city: "Leeds",
    state: "",
    color: "#e2554e",
    pallets: [
      { id: "a", width: 1200, length: 800, shape: "rect" },
      { id: "b", width: 1000, length: 1000, shape: "round" },
    ],
  },
  {
    id: "hull",
    jobNumber: "PO-2",
    city: "Hull",
    state: "",
    color: "#4f86d6",
    pallets: [{ id: "c", width: 1200, length: 800, shape: "rect", tag: "FRAGILE" }],
  },
];

function model(over: Partial<DocumentReadModel> = {}): DocumentReadModel {
  return { revision: 1, entities: [], groups: [], constraints: [], ...over };
}

const added = (cmds: ReturnType<typeof buildNestLayout>) => cmds.filter((c) => c.type === "add-entity");
const isColor = (c: ReturnType<typeof buildNestLayout>[number], col: string) =>
  c.type === "add-entity" && c.entity.color === col;

/**
 * A guide is identified by its dedicated layer, not by being white: pallet
 * labels are drawn white too when the order colour behind them is dark, and
 * a colour-based filter quietly counts those as guides.
 */
const isGuide = (c: ReturnType<typeof buildNestLayout>[number]) =>
  c.type === "add-entity" && c.entity.layer === LOAD_PLAN_GUIDE_LAYER;

describe("buildNestLayout", () => {
  it("draws one hatched shape per pallet, each in its own group", () => {
    const result = nestByOrders(trailer, orders);
    const cmds = buildNestLayout(result);
    const pallets = added(cmds).filter((c) => c.type === "add-entity" && "fill" in c.entity && c.entity.fill);
    expect(pallets).toHaveLength(result.placed.length);

    const groups = cmds.filter((c) => c.type === "group-entities");
    // one group per pallet (shape + guide + tag + dims)
    expect(groups.length).toBe(result.placed.length);

    const round = added(cmds).find((c) => c.type === "add-entity" && c.entity.type === "circle" && c.entity.fill);
    expect(round).toBeTruthy();
  });

  it("draws the tag as a text entity", () => {
    const cmds = buildNestLayout(nestByOrders(trailer, orders));
    const texts = added(cmds).filter((c) => c.type === "add-entity" && c.entity.type === "text");
    expect(texts.some((c) => c.type === "add-entity" && c.entity.type === "text" && c.entity.text === "FRAGILE")).toBe(true);
  });

  it("adds W×L dimensions per pallet only when asked", () => {
    const without = buildNestLayout(nestByOrders(trailer, orders));
    const withDims = buildNestLayout(nestByOrders(trailer, orders), { dimensions: true });
    expect(added(withDims).length).toBeGreaterThan(added(without).length);
  });

  it("draws dimensions as plain small text, never lines", () => {
    const cmds = buildNestLayout(nestByOrders(trailer, orders), { dimensions: true });
    const dimEntities = added(cmds)
      .filter((c) => c.type === "add-entity" && c.entity.name === "pallet-dim")
      .map((c) => c.type === "add-entity" && c.entity);
    expect(dimEntities.length).toBeGreaterThan(0);
    for (const e of dimEntities) expect(e && e.type).toBe("text");
  });

  it("labels the door and nose ends of the trailer", () => {
    const cmds = buildNestLayout(nestByOrders(trailer, orders));
    const texts = added(cmds).filter((c) => c.type === "add-entity" && c.entity.type === "text");
    // NOSE is the deep end (x = 0, loaded first); DOOR is where loading
    // starts from — the labels tell the dock which way round the plan goes,
    // so which end carries which word is the whole point.
    const at = (label: string) => {
      const t = texts.find((c) => c.type === "add-entity" && c.entity.type === "text" && c.entity.text === label);
      return t?.type === "add-entity" && t.entity.type === "text" ? t.entity.at.x : null;
    };
    expect(at("NOSE")).toBeLessThan(trailer.length / 2);
    expect(at("DOOR")).toBeGreaterThan(trailer.length / 2);
  });

  it("writes a printable summary block beside the trailer", () => {
    const result = nestByOrders(trailer, orders);
    const cmds = buildNestLayout(result, { findings: [{ level: "info", message: "ok" }] });
    const texts = added(cmds).filter((c) => c.type === "add-entity" && c.entity.type === "text");
    expect(texts.some((c) => c.type === "add-entity" && c.entity.type === "text" && /load plan/i.test(c.entity.text))).toBe(true);
    // the summary sits past the nose
    const summary = texts.find((c) => c.type === "add-entity" && c.entity.type === "text" && /load plan/i.test(c.entity.text));
    if (summary?.type === "add-entity" && summary.entity.type === "text") {
      expect(summary.entity.at.x).toBeGreaterThan(trailer.length);
    }
  });
});

describe("forPaper pallet outlines", () => {
  const drawn = (os: Order[] = orders, margins = false) =>
    buildNestLayout(
      margins ? nestByOrders({ ...trailer, wallMargin: 120 }, os, { palletMargin: 30 }) : nestByOrders(trailer, os),
      { dimensions: true },
    ).flatMap((c) =>
      c.type === "add-entity" ? [c.entity] : [],
    );
  const shapes = (es: readonly ReturnType<typeof drawn>[number][]) => es.filter((e) => e.name === "pallet-shape");

  it("inks every pallet shape (rect and round) dark, keeping fill and geometry", () => {
    const before = drawn();
    const after = shapes(forPaper(before));
    const orig = shapes(before);
    expect(after).toHaveLength(orig.length);
    expect(after.some((e) => e.type === "circle")).toBe(true);
    expect(after.some((e) => e.type === "polyline")).toBe(true);
    for (const e of after) {
      const o = orig.find((x) => x.id === e.id)!;
      expect(o.color).toBe(o.type !== "text" && "fill" in o ? o.fill : undefined); // canvas stroke == fill: no edge
      expect(e.color).toBe("#111111");
      expect({ ...e, color: undefined }).toEqual({ ...o, color: undefined }); // fill, geometry, id untouched
    }
  });

  it("outlines a dark-filled pallet too", () => {
    const dark: Order[] = [{ ...orders[0], color: "#101820", pallets: [orders[0].pallets[0]] }];
    const [shape] = shapes(forPaper(drawn(dark)));
    expect(shape.color).toBe("#111111");
    expect("fill" in shape && shape.fill).toBe("#101820");
  });

  it("does not mutate its input, and still drops guides and the summary", () => {
    const before = drawn(orders, true);
    const snapshot = JSON.parse(JSON.stringify(before));
    const out = forPaper(before);
    expect(before).toEqual(snapshot);
    expect(before.some((e) => e.layer === LOAD_PLAN_GUIDE_LAYER)).toBe(true);
    expect(out.some((e) => e.name === "pallet-guide" || e.layer === LOAD_PLAN_GUIDE_LAYER)).toBe(false);
    expect(out.some((e) => e.type === "text" && /load plan/i.test(e.text))).toBe(false);
  });
});

describe("buildNestLayout margins", () => {
  it("adds no guides when both margins are zero", () => {
    const cmds = buildNestLayout(nestByOrders(trailer, orders));
    expect(added(cmds).filter(isGuide)).toHaveLength(0);
  });

  it("draws dashed white guides for the wall clearance and each pallet slot", () => {
    const result = nestByOrders({ ...trailer, wallMargin: 120 }, orders, { palletMargin: 30 });
    const cmds = buildNestLayout(result);
    const guides = added(cmds).filter(isGuide);
    expect(guides).toHaveLength(1 + result.placed.length);
    for (const g of guides) {
      if (g.type === "add-entity") {
        expect(g.entity.linetype).toBe("DASHED");
        expect(g.entity.construction).toBe(true);
        expect(g.entity.color).toBe("#ffffff");
        if ("fill" in g.entity) expect(g.entity.fill).toBeUndefined();
      }
    }
    // the pallets themselves stay on the main layer
    const pallets = added(cmds).filter((c) => c.type === "add-entity" && "fill" in c.entity && c.entity.fill);
    for (const p of pallets) if (p.type === "add-entity") expect(p.entity.layer).toBe(LOAD_PLAN_LAYER);
  });
});

describe("clearPreviousLayout", () => {
  it("returns nothing when there is no prior plan", () => {
    expect(clearPreviousLayout(model())).toEqual([]);
  });

  it("deletes every plan entity — margins layer included — and ungroups its wrappers, nested groups too", () => {
    const m = model({
      entities: [
        { id: "e1", type: "polyline", layer: LOAD_PLAN_LAYER, points: [], closed: true },
        { id: "e2", type: "circle", layer: LOAD_PLAN_LAYER, center: { x: 0, y: 0 }, radius: 1 },
        { id: "guide", type: "polyline", layer: LOAD_PLAN_GUIDE_LAYER, points: [], closed: true },
        { id: "keep", type: "polyline", layer: "0", points: [], closed: false },
      ] as DocumentReadModel["entities"],
      groups: [
        { id: "pg", name: "Leeds", members: ["e1", "e2", "guide"] },
        { id: "og", name: "Leeds", members: ["pg"] },
        { id: "gkeep", name: "user group", members: ["keep"] },
      ],
    });
    const commands = clearPreviousLayout(m);
    expect(commands.some((c) => c.type === "ungroup" && c.groupId === "pg")).toBe(true);
    expect(commands.some((c) => c.type === "ungroup" && c.groupId === "og")).toBe(true);
    expect(commands.some((c) => c.type === "ungroup" && c.groupId === "gkeep")).toBe(false);
    const del = commands.find((c) => c.type === "delete-entities");
    expect(del && del.type === "delete-entities" && del.ids.sort()).toEqual(["e1", "e2", "guide"]);
  });
});

describe("setDimensionsOnLayout", () => {
  it("adds and removes dimensions on an already-drawn plan without touching pallet positions", () => {
    let m = applyCommands(model(), buildNestLayout(nestByOrders(trailer, orders)));
    expect(m.entities.some((e) => e.name === "pallet-dim")).toBe(false);

    m = applyCommands(m, setDimensionsOnLayout(m, true, {}));
    const dimCount = m.entities.filter((e) => e.name === "pallet-dim").length;
    expect(dimCount).toBeGreaterThan(0);
    const shapesAfterOn = m.entities.filter((e) => e.name === "pallet-shape");

    m = applyCommands(m, setDimensionsOnLayout(m, false, {}));
    expect(m.entities.some((e) => e.name === "pallet-dim")).toBe(false);
    const shapesAfterOff = m.entities.filter((e) => e.name === "pallet-shape");
    // Toggling dimensions off must not move or recreate a single pallet shape.
    expect(shapesAfterOff.map((e) => e.id).sort()).toEqual(shapesAfterOn.map((e) => e.id).sort());
    for (const s of shapesAfterOff) expect(s).toEqual(shapesAfterOn.find((e) => e.id === s.id));

    // A pallet the user drags by hand (simulated: translate one shape's points)
    // must keep that position when dimensions are toggled back on — this is
    // the fix for "adding dimensions re-nests the plan".
    const shape = m.entities.find((e) => e.name === "pallet-shape" && e.type === "polyline");
    if (!shape || shape.type !== "polyline") throw new Error("expected a rect pallet in the fixture");
    const dragged = { ...shape, points: shape.points.map((p) => ({ x: p.x + 1000, y: p.y })) };
    m = { ...m, entities: m.entities.map((e) => (e.id === dragged.id ? dragged : e)) };

    m = applyCommands(m, setDimensionsOnLayout(m, true, {}));
    const shapeAfterDragAndToggle = m.entities.find((e) => e.id === dragged.id);
    expect(shapeAfterDragAndToggle).toEqual(dragged);
    expect(m.entities.some((e) => e.name === "pallet-dim")).toBe(true);
  });

  it("groups the dragged pallet's own dimensions with it, not the original spot", () => {
    let m = applyCommands(model(), buildNestLayout(nestByOrders(trailer, orders)));
    const shape = m.entities.find((e) => e.name === "pallet-shape" && e.type === "polyline");
    if (!shape || shape.type !== "polyline") throw new Error("expected a rect pallet in the fixture");
    const dragged = { ...shape, points: shape.points.map((p) => ({ x: p.x + 500, y: p.y + 500 })) };
    m = { ...m, entities: m.entities.map((e) => (e.id === dragged.id ? dragged : e)) };

    m = applyCommands(m, setDimensionsOnLayout(m, true, {}));
    const group = m.groups.find((g) => g.members.includes(dragged.id));
    expect(group).toBeTruthy();
    const dimIdsInGroup = (group?.members ?? []).filter((id) => m.entities.find((e) => e.id === id)?.name === "pallet-dim");
    expect(dimIdsInGroup.length).toBeGreaterThan(0);
  });
});

describe("readLivePlacements", () => {
  it("returns the solved placements unchanged when nothing was dragged", () => {
    const result = nestByOrders(trailer, orders);
    const m = applyCommands(model(), buildNestLayout(result));
    const live = readLivePlacements(m, result);
    expect(live.map((p) => ({ x: p.x, y: p.y }))).toEqual(result.placed.map((p) => ({ x: p.x, y: p.y })));
  });

  it("picks up a manual drag instead of the stale solver position — the print-desync fix", () => {
    const result = nestByOrders(trailer, orders);
    let m = applyCommands(model(), buildNestLayout(result));

    // Simulate the user dragging pallet #1's rect shape 2000mm down the trailer.
    const shape = m.entities.find((e) => e.name === "pallet-shape" && e.type === "polyline");
    if (!shape || shape.type !== "polyline") throw new Error("expected a rect pallet in the fixture");
    const dragged = { ...shape, points: shape.points.map((p) => ({ x: p.x + 2000, y: p.y })) };
    m = { ...m, entities: m.entities.map((e) => (e.id === dragged.id ? dragged : e)) };

    const live = readLivePlacements(m, result);
    const original = result.placed.find((p) => p.shape === "rect");
    const movedIndex = result.placed.findIndex((p) => p.shape === "rect");
    expect(original).toBeTruthy();
    expect(live[movedIndex].x).toBeCloseTo((original?.x ?? 0) + 2000);
    // Everything else about the item (job/city/color) is preserved from the solved result.
    expect(live[movedIndex].jobNumber).toBe(original?.jobNumber);
  });

  it("keeps a pallet's size after it is turned on the canvas — the vanishing-dimensions bug", () => {
    // Rotating a pallet 90° in the view left p1.x − p0.x = 0, so the pallet
    // read back as 0 mm long: its dimensions disappeared from the plan and
    // the printed size column. Sides are measured as edge lengths now.
    const result = nestByOrders(trailer, orders);
    let m = applyCommands(model(), buildNestLayout(result));
    const shape = m.entities.find((e) => e.name === "pallet-shape" && e.type === "polyline");
    if (!shape || shape.type !== "polyline") throw new Error("expected a rect pallet in the fixture");
    const index = result.placed.findIndex((p) => p.shape === "rect");
    const before = result.placed[index];

    // Turn it a quarter turn about its own first corner.
    const [o] = shape.points;
    const turned = {
      ...shape,
      points: shape.points.map((p) => ({ x: o.x - (p.y - o.y), y: o.y + (p.x - o.x) })),
    };
    m = { ...m, entities: m.entities.map((e) => (e.id === turned.id ? turned : e)) };

    const live = readLivePlacements(m, result);
    expect(live[index].length).toBeCloseTo(before.length, 6);
    expect(live[index].width).toBeCloseTo(before.width, 6);
    expect(live[index].length).toBeGreaterThan(0);
  });

  it("survives a dimension toggle regrouping — pairs by item number, not group array order", () => {
    const result = nestByOrders(trailer, orders);
    let m = applyCommands(model(), buildNestLayout(result));
    m = applyCommands(m, setDimensionsOnLayout(m, true, {}));
    m = applyCommands(m, setDimensionsOnLayout(m, false, {}));
    const live = readLivePlacements(m, result);
    expect(live.map((p) => ({ x: p.x, y: p.y }))).toEqual(result.placed.map((p) => ({ x: p.x, y: p.y })));
  });
});
