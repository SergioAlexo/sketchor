/**
 * The panel is one big JS string that only runs inside the plugin iframe, so a typo in it
 * is invisible to tsc and shows up as a dead panel. This at least proves every script parses.
 */
import { expect, it } from "vitest";
import { SHEET_NESTING_PANEL_HTML } from "./sheetNestingPanel";

it("panel script parses", () => {
  const scripts = [...SHEET_NESTING_PANEL_HTML.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  expect(scripts.length).toBeGreaterThan(0);
  for (const s of scripts) expect(() => new Function(s)).not.toThrow();
  expect(SHEET_NESTING_PANEL_HTML).toContain("pick-print-folder");
});

it("multi-material: Load CSV groups the file at once, Add drawings marks files as list drawings, and an Amada preset is added by id", () => {
  expect(SHEET_NESTING_PANEL_HTML).toContain('if (f) post({ type: "make-groups", text: await f.text() });');
  expect(SHEET_NESTING_PANEL_HTML).toContain('a === "add-drawings") { partsForGroups = true; $("file-parts").click(); }');
  expect(SHEET_NESTING_PANEL_HTML).toContain('post({ type: "add-files", files: out, forGroups: partsForGroups })');
  expect(SHEET_NESTING_PANEL_HTML).toContain('post({ type: "profile-new", preset: sel.value })');
  expect(SHEET_NESTING_PANEL_HTML).toContain("data-gkerf='1'");
  expect(SHEET_NESTING_PANEL_HTML).toContain("data-gset='thicknessUnit'");
});
