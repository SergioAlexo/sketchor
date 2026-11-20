/**
 * Auto-upgrade rewrites someone else's page. A wrong "yes" swaps a working
 * download link for an error card; a dropped attribute silently ignores what
 * the site author asked for (motion off, no logo). The plan is pure, so both
 * are pinned here without a DOM.
 */
import { describe, expect, it } from "vitest";
import { upgradePlan } from "./autoUpgrade";

describe("upgradePlan", () => {
  it("turns a marked link into a preview labelled by its text", () => {
    const plan = upgradePlan({ tag: "a", attrs: { href: "/f/bracket.glb", "data-sketchor": "" }, href: "https://site.test/f/bracket.glb", text: "  Bracket v2 " });
    expect(plan).toEqual({ src: "https://site.test/f/bracket.glb", attrs: { label: "Bracket v2" } });
  });

  it("ignores links without the marker, and links to formats it can't name", () => {
    expect(upgradePlan({ tag: "a", attrs: { href: "/f/a.glb" }, href: "https://s/f/a.glb" })).toBeNull();
    expect(upgradePlan({ tag: "a", attrs: { href: "/f/report.docx", "data-sketchor": "" }, href: "https://s/f/report.docx" })).toBeNull();
    expect(upgradePlan({ tag: "a", attrs: { href: "/download?id=7", "data-sketchor": "" }, href: "https://s/download?id=7" })).toBeNull();
  });

  it("upgrades an extensionless link when the author names the format", () => {
    const plan = upgradePlan({ tag: "a", attrs: { href: "/download?id=7", "data-sketchor": "", "data-sketchor-format": "stl" }, href: "https://s/download?id=7", text: "Part" });
    expect(plan?.attrs.format).toBe("stl");
  });

  it("still upgrades STEP/DXF links (they get the open-in-Sketchor card, which is what the author opted into)", () => {
    expect(upgradePlan({ tag: "a", attrs: { "data-sketchor": "" }, href: "https://s/x/plate.STEP" })?.src).toBe("https://s/x/plate.STEP");
  });

  it("passes data-sketchor-* through and keeps layout attributes", () => {
    const plan = upgradePlan({
      tag: "a",
      attrs: { "data-sketchor": "", id: "p1", class: "card wide", "data-sketchor-motion": "none", "data-sketchor-autoplay": "", "data-sketchor-logo": "off", "data-sketchor-onclick": "evil()" },
      href: "https://s/a.stl",
      text: "A",
    });
    expect(plan?.attrs).toEqual({ id: "p1", class: "card wide", motion: "none", autoplay: "", logo: "off", label: "A" });
  });

  it("an explicit label beats the link text", () => {
    expect(upgradePlan({ tag: "a", attrs: { "data-sketchor": "", "data-sketchor-label": "Bracket" }, href: "https://s/a.stl", text: "download" })?.attrs.label).toBe("Bracket");
  });

  it("turns a poster image into a preview of its model, keeping its box", () => {
    const plan = upgradePlan({ tag: "img", attrs: { src: "/p.png", "data-sketchor-src": "/m/arm.3mf", alt: "Robot arm", width: "640", height: "360" } });
    expect(plan).toEqual({
      src: "/m/arm.3mf",
      attrs: { width: "640", height: "360", label: "Robot arm", style: "width:640px;height:360px;aspect-ratio:auto" },
    });
  });

  it("never upgrades the same element twice", () => {
    expect(upgradePlan({ tag: "a", attrs: { "data-sketchor": "", "data-sketchor-upgraded": "skipped" }, href: "https://s/a.stl" })).toBeNull();
  });
});
