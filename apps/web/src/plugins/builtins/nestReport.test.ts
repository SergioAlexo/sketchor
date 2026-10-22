import { describe, expect, it } from "vitest";
import type { Entity } from "@sketchor/core";
import type { JobMetrics, TrueNestResult, TrueNestSheet } from "@sketchor/plugin-nest";
import { buildNestReportHtml, buildNestReportPdf, type LastNest, type LastNestPlacement } from "./nestReport";

/**
 * The report is the deliverable a fabricator actually works from — a wrong
 * part count or a page that silently drops a sheet is worse than no report
 * at all. These pin it against a synthetic (but structurally real) nest
 * result, the same way `truckNestingPlugin.test.ts` tests its own
 * `buildPrintHtml`/`buildPrintPdf` directly rather than through the panel
 * (which a test can't reach — see that file's own note on this).
 */

function rectEntity(id: string, x: number, y: number, w: number, h: number): Entity {
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

function sheets(): TrueNestSheet[] {
  return [
    { stockIndex: 0, width: 200, height: 100 },
    { stockIndex: 0, width: 200, height: 100 },
  ];
}

function placements(): LastNestPlacement[] {
  return [
    {
      sheet: 0,
      number: 1,
      id: "0",
      outerEntities: [rectEntity("a-outer", 10, 10, 30, 20)],
      holeEntities: [],
      label: { at: { x: 20, y: 15 }, height: 5 },
      partId: "p-a",
      name: "Bracket",
      rotationDeg: 0,
      mirrored: false,
      area: 600,
    },
    {
      sheet: 1,
      number: 2,
      id: "1",
      outerEntities: [rectEntity("b-outer", 5, 5, 10, 10)],
      holeEntities: [rectEntity("b-hole", 7, 7, 2, 2)],
      label: { at: { x: 8, y: 8 }, height: 3 },
      partId: "p-b",
      name: "Washer plate",
      rotationDeg: 90,
      mirrored: true,
      area: 96,
    },
  ];
}

function result(): TrueNestResult {
  return {
    sheets: sheets(),
    placed: [
      { partId: "p-a", sheet: 0, rotationDeg: 0, mirrored: false, translation: { x: 10, y: 10 } },
      { partId: "p-b", sheet: 1, rotationDeg: 90, mirrored: true, translation: { x: 5, y: 5 } },
    ],
    unplaced: [{ partId: "p-c", count: 2 }],
    utilisation: 0.35,
  };
}

function metrics(): JobMetrics {
  const sheetMetrics = (i: number) => ({
    sheet: i,
    sheetArea: 20000,
    netPartArea: i === 0 ? 600 : 96,
    utilisation: i === 0 ? 0.03 : 0.005,
    remnant: i === 0 ? { width: 200, height: 60, area: 12000 } : null,
    trueScrapArea: 5000,
    cutLengthMm: 100,
    pierceCount: 1,
    cuttingTimeSec: i === 0 ? 42 : null,
    weightKg: i === 0 ? 1.2 : null,
    costEstimate: i === 0 ? 15.5 : null,
  });
  return {
    sheets: [sheetMetrics(0), sheetMetrics(1)],
    totalUtilisation: 0.35,
    totalCuttingTimeSec: null, // one sheet has no cut-table match
    totalCost: null,
  };
}

function lastNest(): LastNest {
  return {
    sheets: sheets(),
    sheetLabels: ["Sheet 1/2 – 200x100 mm", "Sheet 2/2 – 200x100 mm"],
    placements: placements(),
    metrics: metrics(),
    result: result(),
    ordered: [
      { key: "p-a", name: "Bracket", quantity: 1 },
      { key: "p-b", name: "Washer plate", quantity: 1 },
      { key: "p-c", name: "Bolt hole cover", quantity: 2 },
    ],
    unit: { perMm: 1, label: "mm" },
  };
}

describe("buildNestReportHtml", () => {
  it("names every sheet, and every part on both its sheet page and the summary", () => {
    const html = buildNestReportHtml(lastNest());
    for (const label of lastNest().sheetLabels) expect(html).toContain(label);
    // Once in its sheet's part table, once in the ordered-vs-placed summary.
    expect(html.match(/Bracket/g)).toHaveLength(2);
    expect(html.match(/Washer plate/g)).toHaveLength(2);
  });

  it("carries the ordered-vs-placed summary, including the part that never got placed", () => {
    const html = buildNestReportHtml(lastNest());
    expect(html).toContain("Bolt hole cover");
    expect(html).toContain("<td>Bolt hole cover</td><td>2</td><td>0</td><td>2</td>");
  });

  it("shows the mirrored/rotated part's rotation on its sheet page", () => {
    const html = buildNestReportHtml(lastNest());
    expect(html).toContain("90°");
    expect(html).toContain("mirrored");
  });

  it("escapes a part name that would otherwise break the markup", () => {
    const withHtml = lastNest();
    withHtml.ordered[0].name = '<script>alert(1)</script>';
    const html = buildNestReportHtml(withHtml);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("shows no fabricated cutting time for the sheet with no matching cut-table row", () => {
    const html = buildNestReportHtml(lastNest());
    // Sheet 2's row must show the "no data" placeholder, not a bogus number.
    const rows = html.split("<tbody>")[1].split("</tbody>")[0];
    expect(rows).toContain("—");
  });
});

describe("buildNestReportPdf", () => {
  const asText = (bytes: Uint8Array) => String.fromCharCode(...bytes);

  it("is a well-formed PDF whose xref points at its objects", () => {
    const text = asText(buildNestReportPdf(lastNest()));
    expect(text.startsWith("%PDF-1.")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    const startxref = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(startxref, startxref + 4)).toBe("xref");
    const offsets = [...text.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(offsets.length).toBeGreaterThan(4);
    offsets.forEach((off, i) => expect(text.slice(off, off + 8)).toContain(`${i + 1} 0 obj`));
  });

  it("has one page per sheet plus a cover and a summary page", () => {
    const pdf = buildNestReportPdf(lastNest());
    const text = asText(pdf);
    // Every /Type /Page (not /Pages) object marks one page.
    const pageCount = (text.match(/\/Type\s*\/Page[^s]/g) || []).length;
    expect(pageCount).toBe(1 /* cover */ + 2 /* one per sheet */ + 1 /* summary */);
  });

  it("carries the job's own numbers, not a blank report", () => {
    const text = asText(buildNestReportPdf(lastNest()));
    expect(text).toContain("(Bracket)");
    expect(text).toContain("(Washer plate)");
    expect(text).toContain("(Bolt hole cover)");
  });
});

describe("RN-42 report additions", () => {
  const asText = (bytes: Uint8Array) => String.fromCharCode(...bytes);
  const withSummary = (): LastNest => ({
    ...lastNest(),
    footer: "Nesting engine based on the Sheet Nesting Calculator by Oleksandr Borenko",
    summary: {
      kpis: { sheets: 2, toPurchase: 1, utilisation: 0.512, placed: 3, required: 4, cutLengthMm: 1234, pierces: 9, unplaced: 1 },
      stock: [{ name: "s", size: "200 x 100", used: 2, purchased: 1, available: 1 }],
      groups: ['AL 5052 0.125"', "Stainless"],
    },
  });

  it("prints KPIs, stock usage, groups and the credit in both HTML and PDF", () => {
    const html = buildNestReportHtml(withSummary());
    for (const s of ["To purchase", "51.2%", "3 of 4", "1234 mm", "Stock usage", "200 x 100: 2 used, 1 to purchase, 1 in stock", "Groups: AL 5052", "Oleksandr Borenko"]) expect(html).toContain(s);
    const pdf = asText(buildNestReportPdf(withSummary()));
    expect(pdf).toContain("Oleksandr Borenko");
    expect(pdf).toContain("Cut length: 1234 mm");
  });

  it("is unchanged for callers without a summary (the older nest panel)", () => {
    const html = buildNestReportHtml(lastNest());
    expect(html).not.toContain("Stock usage");
    expect(html).not.toContain("Oleksandr");
  });
});
