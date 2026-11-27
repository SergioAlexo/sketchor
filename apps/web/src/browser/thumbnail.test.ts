// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { drawingThumbnail, epsThumbnail, fileThumbnail, fileToDrawing } from "./thumbnail";

/**
 * Why: file-browser cards draw through core render2d (E-01) when there is a
 * canvas, and must still show something — the SVG thumbnail — where there
 * isn't one (jsdom here, a locked-down webview), or for a file that can't be
 * read. The parity fixture has a block insert array, so it also proves a
 * thumbnail keeps blocks as blocks rather than exploding them.
 */
const parity = readFileSync(fileURLToPath(new NodeURL("../../../../native/dxf-parse/tests/parity.dxf", import.meta.url)), "utf8");
const colors = { bg: "#101010", ink: "#eeeeee" };

// jsdom has no 2D canvas (and says so on stderr); answer as a canvas-less webview would.
beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
});

describe("file-browser thumbnails", () => {
  it("reads a DXF with its blocks kept for the inserts to draw through", () => {
    const d = fileToDrawing("parity.dxf", parity);
    expect(d.entities.some((e) => e.type === "insert")).toBe(true);
    expect(d.blocks.length).toBeGreaterThan(0);
  });

  it("reads an SVG", () => {
    const d = fileToDrawing("a.svg", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><line x1="0" y1="0" x2="10" y2="10" stroke="#000"/></svg>');
    expect(d.entities.length).toBe(1);
  });

  it("falls back to the SVG thumbnail without a canvas", () => {
    expect(drawingThumbnail(fileToDrawing("parity.dxf", parity), 64, colors)).toBeNull();
    const svg = fileThumbnail("parity.dxf", parity, 64, colors);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('fill="#101010"');
    expect(svg).toContain('stroke="#eeeeee"');
  });

  it("draws an empty frame for a file it can't read", () => {
    expect(fileThumbnail("broken.svg", "<<not svg", 32, colors)).toContain("<svg");
  });

  it("leaves raster images out of an EPS thumbnail", () => {
    const svg = epsThumbnail(
      [
        { id: "i", type: "image", insert: { x: 0, y: 0 }, width: 10, height: 10, rotation: 0, dataUrl: "data:image/png;base64," } as never,
        { id: "l", type: "line", a: { x: 0, y: 0 }, b: { x: 10, y: 5 } },
      ],
      48,
      colors,
    );
    expect(svg).toContain("<line ");
    expect(svg).not.toContain("<path");
  });
});
