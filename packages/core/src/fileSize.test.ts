import { describe, expect, it } from "vitest";
import { classifySize, formatBytes, sizeWarning } from "./fileSize";

describe("fileSize", () => {
  it("classifies by extension thresholds", () => {
    expect(classifySize("a.dxf", 1e6)).toBe("ok");
    expect(classifySize("a.DXF", 30e6)).toBe("large");
    expect(classifySize("C:\\x\\a.dxf", 120e6)).toBe("huge");
    expect(classifySize("a.svg", 12e6)).toBe("large");
    expect(classifySize("a.unknown", 60e6)).toBe("large");
    expect(classifySize("noext", 0)).toBe("ok");
  });
  it("formats sizes", () => {
    expect(formatBytes(12)).toBe("12 B");
    expect(formatBytes(2500)).toBe("3 kB");
    expect(formatBytes(34.5e6)).toBe("34.5 MB");
    expect(formatBytes(2e9)).toBe("2.0 GB");
  });
  it("warns only when needed", () => {
    expect(sizeWarning("a.dxf", 1000)).toBeNull();
    expect(sizeWarning("a.dxf", 30e6)).toMatch(/large file/);
    expect(sizeWarning("a.dxf", 300e6)).toMatch(/very large/);
  });
});
