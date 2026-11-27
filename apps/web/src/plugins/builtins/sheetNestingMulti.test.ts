import { describe, expect, it } from "vitest";
import { entitiesToDxf } from "@sketchor/core";
import { polyline, type Command } from "@sketchor/plugin-sdk";
import plugin from "./sheetNestingPlugin";

/**
 * Multi-material nesting end to end, through the plugin's own message
 * handlers: drawings added for a list, a CSV with two thicknesses of mild
 * steel and one of stainless, an Amada machine file, Calculate, then the
 * exports. What this guards: every thickness must come out on sheets of its
 * own (a 3 mm part on a 10 mm sheet is scrap), each group must be spaced and
 * cut with *its* kerf (the machine file's row for that thickness, or the
 * group's own), and the exports must say which group a sheet belongs to.
 * The panel cannot run here, so a fake host stands in for the app.
 */

const rect = (w: number, h: number) => polyline([{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }], true);

interface Saved {
  name: string;
  data: string | Uint8Array;
}

async function startPlugin() {
  const store = new Map<string, unknown>();
  const posted: Record<string, unknown>[] = [];
  const notes: { message: string; error: boolean }[] = [];
  const tabs: { title: string; commands: Command[] }[] = [];
  const saved: Saved[] = [];
  let onMessage: ((m: unknown) => Promise<void> | void) | null = null;
  const noop = () => undefined;
  const sketchor = {
    app: {
      displayUnit: async () => ({ unit: "mm", perMm: 1, label: "mm" }),
      onDisplayUnitChange: async () => noop,
      openDocumentTab: async (title: string, commands: Command[]) => {
        tabs.push({ title, commands });
      },
    },
    storage: {
      get: async (k: string) => store.get(k),
      set: async (k: string, v: unknown) => void store.set(k, JSON.parse(JSON.stringify(v))),
    },
    ui: {
      show: async () => undefined,
      postMessage: async (m: Record<string, unknown>) => void posted.push(m),
      onMessage: (fn: (m: unknown) => Promise<void> | void) => {
        onMessage = fn;
        return noop;
      },
      notify: (message: string, o?: { error?: boolean }) => void notes.push({ message, error: !!o?.error }),
      highlight: async () => undefined,
      saveFile: async (name: string, data: string | Uint8Array) => {
        saved.push({ name, data });
        return { saved: true, name };
      },
      pickFolder: async () => null,
      readPickedFile: async () => "",
      print: noop,
      printFolder: async () => null,
      pickPrintFolder: async () => null,
    },
    selection: { onChange: async () => noop, read: async () => [] as string[] },
    document: { read: async () => ({ entities: [] }), onChange: async () => noop, apply: async () => undefined },
    commands: { register: noop },
  };
  await plugin.activate(sketchor as never);
  const send = async (m: Record<string, unknown>) => {
    posted.length = 0;
    await onMessage!(m);
  };
  const lastView = () => [...posted].reverse().find((m) => m.type === "view") as Record<string, any> | undefined;
  return { send, posted, notes, tabs, saved, lastView };
}

const CSV = ["Part,Qty,Material,Thickness (mm)", "plate-a,3,S235,3", "plate-b,2,S235,10", "plate-a,2,AISI 304,2", "plate-b,1,S235,3"].join("\n");

describe("multi-material nesting from a CSV", () => {
  it("nests each material + thickness on its own sheets with its own kerf, and tags the exports", async () => {
    const h = await startPlugin();
    await h.send({ type: "job-set", patch: { mode: "groups", timeMs: 0, outputUnit: "mm" } });
    await h.send({
      type: "add-files",
      forGroups: true,
      files: [
        { name: "plate-a.dxf", text: entitiesToDxf([rect(200, 100)], 4, 1) },
        { name: "plate-b.dxf", text: entitiesToDxf([rect(300, 150)], 4, 1) },
      ],
    });
    // Drawings for a list are not manual parts.
    expect(h.lastView()!.job.parts).toEqual([]);
    expect(h.lastView()!.addedDrawings).toBe(2);

    // An Amada machine file supplies the kerf per thickness.
    await h.send({ type: "profile-new", preset: "amada-ensis-3015aj-6kw" });
    const view = h.lastView()!;
    const prof = view.profiles.find((p: { name: string }) => /ENSIS-3015 AJ 6 kW/.test(p.name));
    expect(prof).toBeDefined();
    await h.send({ type: "job-set", patch: { profileId: prof.id } });

    await h.send({ type: "make-groups", text: CSV });
    const groups = h.lastView()!.groups as { id: string; label: string; kerfAuto: string; kerfFrom: string; items: { num: string; qty: number; state: string }[] }[];
    expect(groups.map((g) => g.label)).toEqual(["Carbon steel 3 mm", "Carbon steel 10 mm", "Stainless 2 mm"]);
    expect(groups.map((g) => g.items.map((i) => `${i.num}x${i.qty}`).join(" "))).toEqual(["plate-ax3 plate-bx1", "plate-bx2", "plate-ax2"]);
    expect(groups.every((g) => g.items.every((i) => i.state === "ok"))).toBe(true);
    // The ENSIS 6 kW table: mild steel 3 mm 0.15, 10 mm 0.4, stainless 2 mm 0.12.
    expect(groups.map((g) => [g.kerfAuto, g.kerfFrom])).toEqual([
      ["0.15 mm", "machine"],
      ["0.4 mm", "machine"],
      ["0.12 mm", "machine"],
    ]);

    // The stainless group gets its own kerf typed in; it wins over the machine file.
    await h.send({ type: "group-set", id: groups[2]!.id, patch: { kerf: "0.2" } });
    expect(h.lastView()!.groups[2]).toMatchObject({ kerfAuto: "0.2 mm", kerfFrom: "group" });

    await h.send({ type: "nest" });
    const result = h.posted.find((m) => m.type === "result") as Record<string, any>;
    expect(result, JSON.stringify(h.notes)).toBeDefined();
    expect(result.unplaced).toEqual([]);
    expect(result.kpis.placed).toBe(3 + 1 + 2 + 2);
    // Each sheet belongs to exactly one group, and every group has a sheet.
    const sheetGroups = new Set((result.cards as { group: string }[]).map((c) => c.group));
    expect([...sheetGroups].sort()).toEqual(["Carbon steel 10 mm", "Carbon steel 3 mm", "Stainless 2 mm"]);
    expect((result.sheetLabels as string[]).every((l) => /Carbon steel 3 mm|Carbon steel 10 mm|Stainless 2 mm/.test(l))).toBe(true);
    expect(h.tabs).toHaveLength(1);

    // ZIP: one folder per group.
    await h.send({ type: "export-dxf", sheetIndex: -1, preset: "laser" });
    const zip = h.saved.find((f) => f.name === "nest-sheets.zip")!;
    const names = new TextDecoder().decode(zip.data as Uint8Array);
    expect(names).toContain("Carbon-steel-3mm/nest-sheet-01.dxf");
    expect(names).toMatch(/Carbon-steel-10mm\/nest-sheet-0\d\.dxf/);
    expect(names).toMatch(/Stainless-2mm\/nest-sheet-0\d\.dxf/);

    // G-code: the path is offset by the sheet's own kerf. Same 300 x 150 part on a 3 mm and a 10 mm sheet:
    // the cut outline grows by the kerf, so the two programs' outlines differ by 0.4 - 0.15 mm.
    const labels = result.sheetLabels as string[];
    const sheetOf = (g: string) => labels.findIndex((l) => l.includes(g));
    const gcodeFor = async (i: number) => {
      await h.send({ type: "export-gcode", sheetIndex: i });
      return h.saved[h.saved.length - 1]!;
    };
    const thin = await gcodeFor(sheetOf("Carbon steel 3 mm"));
    const thick = await gcodeFor(sheetOf("Carbon steel 10 mm"));
    expect(thin.name).toMatch(/^Carbon-steel-3mm_nest-sheet-\d+\.nc$/);
    expect(thick.name).toMatch(/^Carbon-steel-10mm_nest-sheet-\d+\.nc$/);
    expect(String(thick.data)).toContain("Carbon steel 10 mm");
    const widestCut = (text: string): number => {
      // Group the G1 moves of each contour and return the largest contour's X extent.
      let best = 0, xs: number[] = [];
      for (const ln of text.split("\n")) {
        const x = /^G1\b.*X(-?[\d.]+)/.exec(ln);
        if (x) xs.push(Number(x[1]));
        else if (/^G0\b/.test(ln) && xs.length) {
          best = Math.max(best, Math.max(...xs) - Math.min(...xs));
          xs = [];
        }
      }
      if (xs.length) best = Math.max(best, Math.max(...xs) - Math.min(...xs));
      return best;
    };
    expect(widestCut(String(thick.data)) - widestCut(String(thin.data))).toBeCloseTo(0.4 - 0.15, 2);
  }, 60_000);

  it("a pasted CAD BOM with SHEET materials keeps its old reading", async () => {
    const h = await startPlugin();
    await h.send({ type: "make-groups", text: "Part Number,Qty,Material\nPN-1,2,\"SHEET, AL 5052 .125\"\nPN-2,1,TUBE 1x1\n" });
    const groups = h.lastView()!.groups as { label: string; thicknessUnit: string; items: unknown[] }[];
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ label: 'AL 5052 0.125"', thicknessUnit: "in" });
    expect(h.notes.some((n) => /non-sheet row/.test(n.message))).toBe(true);
  });

  it("a sheet size from the list is offered (and selected) even when it is not in the catalog", async () => {
    const h = await startPlugin();
    await h.send({ type: "make-groups", text: "Part,Qty,Material,Thickness,Sheet\nA,1,S235,3 mm,3000x1500 mm\n" });
    const g = h.lastView()!.groups[0] as { sheet: { w: number; h: number }; sheetOptions: { w: number; h: number; label: string }[] };
    expect(g.sheetOptions[0]!.label).toMatch(/from the list/);
    expect(g.sheetOptions[0]!.w).toBeCloseTo(g.sheet.w, 9);
    expect(g.sheet.w * 25.4).toBeCloseTo(1500, 2);
  });

  it("an unreadable list is an error message, not a throw", async () => {
    const h = await startPlugin();
    await h.send({ type: "make-groups", text: "\n\n;;;\n" });
    expect(h.posted.some((m) => m.type === "error")).toBe(true);
  });
});
