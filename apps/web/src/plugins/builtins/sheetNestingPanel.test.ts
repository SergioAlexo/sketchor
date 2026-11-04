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
