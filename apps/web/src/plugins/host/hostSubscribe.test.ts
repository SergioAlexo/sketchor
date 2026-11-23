// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { bus, getSessions, newTab, switchToSession } from "../../state/store";
import { dispatchSubscribe } from "./hostMethods";

/**
 * A plugin's `document.onChange` must follow the active tab: Sheet Nesting
 * opens its result in a new tab and watches the user's edits there, which a
 * subscription stuck on the tab that was open at subscribe time never hears.
 */
describe("document.onChange", () => {
  it("hears edits on a tab opened after subscribing, and stops when unsubscribed", () => {
    const seen: number[] = [];
    const first = getSessions()[0]!.id;
    const off = dispatchSubscribe({ pluginId: "t" } as never, "document.onChange", [], (m) => seen.push((m as { entities: unknown[] }).entities.length));
    newTab();
    const afterSwitch = seen.length;
    expect(afterSwitch).toBeGreaterThan(0); // the switch itself is reported
    bus.execute({ type: "add-entity", entity: { id: "x1", type: "point", p: { x: 0, y: 0 } } });
    expect(seen.length).toBe(afterSwitch + 1);
    expect(seen[seen.length - 1]).toBe(1);
    switchToSession(first);
    off();
    const n = seen.length;
    bus.execute({ type: "add-entity", entity: { id: "x2", type: "point", p: { x: 1, y: 0 } } });
    expect(seen.length).toBe(n);
  });
});
