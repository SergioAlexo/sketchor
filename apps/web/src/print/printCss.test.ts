import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The app pins html/body/#root to one viewport (height:100% + overflow:hidden)
 * and the print preview is a 100vh flex column. Printed as-is, a long sheet is
 * clipped to page 1 and the rest of the pallet list never reaches paper. The
 * `@media print` block must put the whole chain back to normal flow.
 */
describe("print stylesheet", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  const print = css.slice(css.indexOf("@media print"));

  it("releases the viewport pinning for the root, page and sheet so the sheet paginates", () => {
    for (const sel of ["body.sketchor-printing #sketchor-print-root", ".print-preview-page", ".print-preview-sheet"]) {
      const rule = print.split("}").find((r) => r.includes(sel) && r.includes("overflow: visible"));
      expect(rule, sel).toBeDefined();
      expect(rule).toContain("height: auto");
    }
    expect(print).toMatch(/html,[^{]*\{[^}]*overflow: visible/);
    expect(print).toMatch(/#sketchor-print-root[^{]*\{[^}]*display: block;[^}]*flex: none/);
  });
});
