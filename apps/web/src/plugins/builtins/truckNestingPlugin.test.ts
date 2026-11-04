import { describe, expect, it } from "vitest";
import {
  buildNestLayout,
  forPaper,
  LOAD_PLAN_LAYER,
  nestByOrders,
  type NestResult,
  type Order,
  type TrailerProfile,
} from "@sketchor/plugin-truck-nesting";
import type { Entity } from "@sketchor/plugin-sdk";
import { autosaveFileName, buildPrintHtml, buildPrintPdf, PANEL_HTML } from "./truckNestingPlugin";

/**
 * The printed load plan is the deliverable: it goes to a dock, on paper,
 * and whoever loads the truck works from it without the app. So the things
 * that make it usable are worth pinning — which end of the trailer is
 * which, whether a pallet's instruction tag is on the nest itself rather
 * than only in a table, and that the size column survives (it has gone
 * missing before, when a pallet was turned on the canvas).
 *
 * The sheet is rendered from the *drawing* — the entities `buildNestLayout`
 * puts on the "Load Plan" layer, which are also what the DXF export writes.
 * These tests go through that same path, so a plan that prints right is a
 * plan that exports right.
 */

const trailer: TrailerProfile = { name: "Test 13.6m", length: 13600, width: 2480 };

const orders: Order[] = [
  {
    id: "o1",
    jobNumber: "PO-1",
    city: "Leeds",
    state: "",
    color: "#e69f00",
    pallets: [{ id: "a", width: 1200, length: 800, shape: "rect", tag: "FRAGILE" }],
  },
  {
    id: "o2",
    jobNumber: "PO-2",
    city: "Hull",
    state: "",
    color: "#0072b2",
    pallets: [{ id: "b", width: 1000, length: 1000, shape: "round" }],
  },
];

const info = { loadName: "Load", truckInfo: "", loadDate: "2026-09-23", perMm: 1, unitLabel: "mm" };

/** The plan as drawn, then re-inked for white paper — what the sheet renders. */
function drawn(result: NestResult, opts: { dimensions?: boolean } = {}): Entity[] {
  const entities = buildNestLayout(result, { ...opts, perMm: 1, unitLabel: "mm" })
    .flatMap((c) => (c.type === "add-entity" ? [c.entity] : []))
    .filter((e) => e.layer === LOAD_PLAN_LAYER);
  return forPaper(entities) as Entity[];
}

const html = () => {
  const result = nestByOrders(trailer, orders);
  return buildPrintHtml(drawn(result), result, [], info);
};

/** The x attribute of the `<text>` element carrying `label`. */
function labelX(svg: string, label: string): number | null {
  const m = new RegExp(`<text x="([-0-9.]+)"[^>]*>${label}</text>`).exec(svg);
  return m ? Number(m[1]) : null;
}

describe("the printed load plan", () => {
  it("marks the nose at the deep end and the door where loading starts", () => {
    const out = html();
    const nose = labelX(out, "NOSE");
    const door = labelX(out, "DOOR");
    expect(nose).not.toBeNull();
    expect(door).not.toBeNull();
    expect(nose!).toBeLessThan(trailer.length / 2);
    expect(door!).toBeGreaterThan(trailer.length / 2);
  });

  it("draws the end labels big enough to read on paper", () => {
    // Small enough to fit, large enough not to need squinting: a fair
    // fraction of the trailer's width, which is how the plan is scaled.
    const sizes = [...html().matchAll(/<text[^>]*font-size="([\d.]+)"[^>]*>(NOSE|DOOR)</g)].map((m) => Number(m[1]));
    expect(sizes).toHaveLength(2);
    for (const s of sizes) expect(s).toBeGreaterThan(trailer.width * 0.08);
  });

  it("puts the pallet's tag on the nest, not only in the table", () => {
    const out = html();
    const svg = out.slice(out.indexOf("<svg"), out.indexOf("</svg>"));
    expect(svg).toContain(">FRAGILE<");
  });

  it("lists sizes and drops the shape column", () => {
    const out = html();
    expect(out).toContain("<th>Size</th>");
    expect(out).not.toContain("<th>Shape</th>");
    expect(out).not.toContain("<td>Rect</td>");
    // The sizes themselves are still there.
    expect(out).toContain("1200 mm × 800 mm");
    expect(out).toContain("Ø 1000 mm");
  });

  it("calls the colour key a load sequence", () => {
    expect(html()).toContain("Legend — load sequence");
    expect(html()).not.toContain("unload sequence");
  });

  it("writes light text on dark pallets and dark text on light ones", () => {
    const out = html();
    // The dark blue order must not be labelled in near-black.
    expect(out).toMatch(/fill="#ffffff"/);
    expect(out).toMatch(/fill="#111111"/);
  });

  it("fills the pallets solid, or the labels chosen for those colours stop reading", () => {
    expect(html()).toMatch(/fill="#0072b2" fill-opacity="1"/);
  });

  it("shows the plan that was drawn, not a second one built for the page", () => {
    const result = nestByOrders(trailer, orders);
    const moved = drawn(result).map((e) =>
      e.type === "polyline" ? { ...e, points: e.points.map((pt) => ({ x: pt.x + 5000, y: pt.y })) } : e,
    );
    const out = buildPrintHtml(moved, result, [], info);
    // The trailer outline moved 5 m to the right, so the sheet is 5 m wider:
    // the picture follows the entities, with nothing re-derived from the nest.
    const width = Number(/viewBox="0 0 ([\d.]+)/.exec(out)![1]);
    expect(width).toBeGreaterThan(trailer.length + 4000);
  });

  it("leaves the white clearance guides and the on-canvas summary off the paper", () => {
    const result = nestByOrders({ ...trailer, wallMargin: 100 }, orders);
    const paper = drawn(result);
    expect(paper.some((e) => "construction" in e && e.construction)).toBe(false);
    expect(paper.some((e) => e.type === "text" && /load plan/i.test(e.text))).toBe(false);
    // …while the plan itself is still there.
    expect(paper.some((e) => e.type === "text" && e.text === "NOSE")).toBe(true);
  });

  it("turns the workspace's light lettering black for paper", () => {
    const result = nestByOrders(trailer, orders);
    const drawnDark = buildNestLayout(result, { dimensions: true, perMm: 1, unitLabel: "mm" })
      .flatMap((c) => (c.type === "add-entity" ? [c.entity] : []))
      .filter((e) => e.layer === LOAD_PLAN_LAYER);
    const dims = drawnDark.filter((e) => e.name === "pallet-dim");
    expect(dims.length).toBeGreaterThan(0);
    for (const d of dims) expect(d.color).toBe("#e8eaed"); // reads on the dark canvas
    const onPaper = forPaper(drawnDark).filter((e) => e.name === "pallet-dim");
    for (const d of onPaper) expect(d.color).toBe("#111111");
  });
});

/**
 * The PDF is the copy that lands in the office's folder without anyone
 * choosing a filename, so it has to be a *file a reader opens* — a truncated
 * or mis-offset one fails silently, days later, when someone goes looking.
 */
describe("the filed PDF", () => {
  const pdf = () => {
    const result = nestByOrders(trailer, orders);
    return buildPrintPdf(drawn(result), result, [], info);
  };
  const asText = (bytes: Uint8Array) => String.fromCharCode(...bytes);

  it("is a well-formed PDF whose xref points at its objects", () => {
    const text = asText(pdf());
    expect(text.startsWith("%PDF-1.")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    const startxref = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(startxref, startxref + 4)).toBe("xref");
    // Every offset in the table must land on the object it claims.
    const offsets = [...text.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(offsets.length).toBeGreaterThan(4);
    offsets.forEach((off, i) => expect(text.slice(off, off + 8)).toContain(`${i + 1} 0 obj`));
  });

  it("carries the load's own paperwork, not a blank page", () => {
    const text = asText(pdf());
    expect(text).toContain("(Load)");
    expect(text).toContain("(FRAGILE)"); // the tag, in the pallet list
    expect(text).toContain("(NOSE)"); // the drawing's own lettering
  });

  it("continues the pallet list onto further pages instead of stopping after the first", () => {
    // 120 pallets cannot fit under the plan on one landscape page; a writer that
    // stopped at the page bottom would silently drop the last rows from the paper.
    const many: Order[] = Array.from({ length: 120 }, (_, i) => ({
      id: `m${i}`,
      jobNumber: `JOB-${String(i + 1).padStart(3, "0")}`,
      city: "Leeds",
      state: "",
      color: "#e69f00",
      pallets: [{ id: `p${i}`, width: 1200, length: 800, shape: "rect" as const }],
    }));
    const result = nestByOrders({ ...trailer, length: 200000 }, many);
    const text = asText(buildPrintPdf(drawn(result), result, [], info));
    const pages = Number(/\/Type \/Pages \/Count (\d+)/.exec(text)![1]);
    expect(pages).toBeGreaterThan(1);
    expect(text).toContain("(JOB-120)");
    expect(text).toContain("(120)"); // its row number
  });

  it("escapes a job number that would otherwise end the string early", () => {
    const awkward: Order[] = [{ ...orders[0], jobNumber: "PO (rush) \\ 7" }];
    const result = nestByOrders(trailer, awkward);
    const text = asText(buildPrintPdf(drawn(result), result, [], info));
    expect(text).toContain("(PO \\(rush\\) \\\\ 7)");
  });
});

/**
 * The autosaved copy is filed by filename alone — a dispatcher scans a
 * folder of these without opening one, so the name has to carry when it was
 * made and what's on the load: the states it crosses and its job numbers,
 * each appearing once even when several pallets share a state or job.
 */
describe("the autosaved filename", () => {
  it("carries the load name, every distinct state and every distinct job, each once", () => {
    const withStates: Order[] = [
      { ...orders[0], jobNumber: "PO-1", state: "NY" },
      { ...orders[1], jobNumber: "PO-1", state: "NY" }, // same job & state as above — must not repeat
      { id: "o3", jobNumber: "PO-2", city: "Denver", state: "CO", color: "#009e73", pallets: orders[0].pallets },
    ];
    const result = nestByOrders(trailer, withStates);
    const name = autosaveFileName("Load 42", result);
    expect(name).toContain("Load 42");
    expect(name).toContain("NY-CO");
    expect(name).toContain("PO-1-PO-2");
    // Job/state each appear exactly once despite two pallets sharing them.
    expect(name.match(/NY/g)).toHaveLength(1);
    expect(name.match(/PO-1/g)).toHaveLength(1);
  });

  it("drops empty states/jobs instead of leaving a blank segment", () => {
    const result = nestByOrders(trailer, orders); // orders[] has state: "" throughout
    const name = autosaveFileName("Load", result);
    expect(name).not.toMatch(/—\s*—/); // no adjacent separators from an empty segment
  });

  it("starts with a generated-at timestamp so a folder of these sorts by when they were made", () => {
    const result = nestByOrders(trailer, orders);
    const name = autosaveFileName("Load", result);
    expect(name).toMatch(/^\d{4}-\d{2}-\d{2} \d{4}/);
  });
});

/**
 * The panel runs inside the plugin sandbox, where a test can't reach it —
 * so these assert on the markup that is shipped into that sandbox. Shallow
 * by nature, but they do catch the thing worth catching: a control or a
 * label that was renamed in one place and not the other.
 */
describe("the load-plan panel", () => {
  it("offers an orientation lock per pallet", () => {
    expect(PANEL_HTML).toContain("p-orient");
    expect(PANEL_HTML).toContain('{ v: "auto"');
    expect(PANEL_HTML).toContain('{ v: "fixed"');
    expect(PANEL_HTML).toContain('{ v: "turned"');
    // And writes the choice back onto the pallet.
    expect(PANEL_HTML).toContain("p.orientation = e.target.value");
  });

  it("talks about loading, not unloading", () => {
    expect(PANEL_HTML).toContain("to set load order");
    expect(PANEL_HTML).toContain("Load sequence");
    expect(PANEL_HTML).not.toContain("unload");
    expect(PANEL_HTML).not.toContain("Unload");
  });
});
