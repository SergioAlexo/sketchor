/**
 * `?open=` takes a URL from a link anyone can craft, so only http(s) URLs
 * naming a format Sketchor reads may reach fetch() — never javascript:,
 * data: or file: URLs, and never a guess at a format.
 */
import { describe, expect, it } from "vitest";
import { openTarget } from "./openTarget";

describe("openTarget", () => {
  it("accepts an http(s) URL to a readable file and names it from the path", () => {
    expect(openTarget("?open=" + encodeURIComponent("https://tech.sergioalexo.com/models/ASM-4019.glb"))).toEqual({
      url: "https://tech.sergioalexo.com/models/ASM-4019.glb",
      name: "ASM-4019.glb",
    });
    expect(openTarget("?open=http%3A%2F%2Flocalhost%3A3000%2Fa%2520b.dxf")?.name).toBe("a b.dxf");
  });
  it("refuses other schemes, unknown formats and junk", () => {
    expect(openTarget("?open=javascript%3Aalert(1)%2F%2Fx.dxf")).toBeNull();
    expect(openTarget("?open=data%3Atext%2Fplain%2Cx.dxf")).toBeNull();
    expect(openTarget("?open=file%3A%2F%2F%2Fc%3A%2Fx.dxf")).toBeNull();
    expect(openTarget("?open=https%3A%2F%2Fx.com%2Fnotes.docx")).toBeNull();
    expect(openTarget("?open=https%3A%2F%2Fx.com%2F")).toBeNull();
    expect(openTarget("?open=not a url")).toBeNull();
    expect(openTarget("")).toBeNull();
  });
});
