import { describe, expect, it } from "vitest";
import { HOST_API_VERSION, satisfiesHostApi } from "./engine";

/**
 * The compatibility gate: the host refuses a plugin whose `engines.sketchor`
 * doesn't cover the current host API, at load, rather than failing mid-run. On a
 * pre-1.0 line the caret pins the minor, so an older API range must be rejected.
 */

describe("satisfiesHostApi", () => {
  it("accepts a caret range over the current host API version", () => {
    expect(satisfiesHostApi(`^${HOST_API_VERSION}`)).toBe(true);
    expect(satisfiesHostApi("^0.13.0")).toBe(true);
  });

  it("rejects a different major version", () => {
    expect(satisfiesHostApi("^99.0.0")).toBe(false);
  });

  it("rejects a 0.x range asking for a different minor than the host", () => {
    // On 0.x the caret pins the minor; the host is 0.3.x, so ^0.2.0 is out.
    expect(satisfiesHostApi("^0.2.0")).toBe(false);
  });

  it("rejects ranges it can't parse (only caret ranges are supported)", () => {
    expect(satisfiesHostApi("1.0.0")).toBe(false);
    expect(satisfiesHostApi(">=0.3.0")).toBe(false);
    expect(satisfiesHostApi("")).toBe(false);
  });
});
