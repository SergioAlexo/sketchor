import { describe, expect, it } from "vitest";
import { CapabilityError, type GrantedCapabilities, type Permission } from "@sketchor/core";
import { assertCapability, UnknownMethodError } from "./capabilityGuard";

/**
 * The capability boundary — the reason an untrusted plugin can't do what it
 * wasn't granted. Every inbound RPC call passes through {@link assertCapability}
 * before it reaches a host method, so this guard *is* the enforcement. These
 * tests pin its three jobs: reject unknown methods outright, reject calls a
 * plugin lacks the permission for, and let granted (and permission-free) calls
 * through.
 */

const grant = (...perms: Permission[]): GrantedCapabilities => new Set(perms);

describe("assertCapability", () => {
  it("rejects a method the host doesn't expose", () => {
    expect(() => assertCapability("document.__proto__", grant("write-document"))).toThrow(UnknownMethodError);
    expect(() => assertCapability("evil.exfiltrate", grant("write-document"))).toThrow(UnknownMethodError);
  });

  it("blocks a mutation from a plugin without write-document", () => {
    // The canonical case: a read-only plugin cannot apply commands.
    expect(() => assertCapability("document.apply", grant("read-document"))).toThrow(CapabilityError);
    try {
      assertCapability("document.apply", grant("read-document"));
    } catch (err) {
      expect((err as CapabilityError).permission).toBe("write-document");
    }
  });

  it("allows a call once the required permission is granted", () => {
    expect(() => assertCapability("document.apply", grant("write-document"))).not.toThrow();
    expect(() => assertCapability("document.read", grant("read-document"))).not.toThrow();
    expect(() => assertCapability("filesystem.writeFile", grant("filesystem"))).not.toThrow();
  });

  it("allows permission-free UI methods with no grants at all", () => {
    expect(() => assertCapability("ui.notify", grant())).not.toThrow();
    expect(() => assertCapability("ui.show", grant())).not.toThrow();
    // NF-03b: throwaway markers over the drawing read and write nothing.
    expect(() => assertCapability("ui.highlight", grant())).not.toThrow();
  });

  it("does not let one permission stand in for another", () => {
    expect(() => assertCapability("network.fetch", grant("storage"))).toThrow(CapabilityError);
    expect(() => assertCapability("storage.get", grant("network"))).toThrow(CapabilityError);
  });
});
