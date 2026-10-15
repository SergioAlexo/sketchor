// @vitest-environment jsdom
/**
 * Why this matters: the rich editor must hand back exactly the MTEXT codes it
 * was given (or the ones the browser's editing commands imply); a lossy bridge
 * would strip formatting from a drawing every time someone fixes a typo.
 */
import { describe, expect, it } from "vitest";
import { mtextPlain, parseMtext } from "@sketchor/core";
import { htmlToMtext, htmlToParagraphs, mtextToHtml } from "./domCodec";

const root = (html: string): HTMLElement => {
  const d = document.createElement("div");
  d.innerHTML = html;
  return d;
};

describe("mtext editor DOM codec", () => {
  it("round-trips codes through the DOM", () => {
    const src = "{\\fArial|b1|i0|c0|p0;Bold} plain\\P{\\c255;red}\\P\\S1/2; and {\\Lunder\\l}";
    const back = htmlToMtext(root(mtextToHtml(src)));
    // The font name is not an editor concept (bold/italic survive, the face does not).
    const noFont = (code: string) => parseMtext(code).map((p) => ({ runs: p.runs.map((r) => { const fmt = { ...r.fmt }; delete fmt.font; return { ...r, fmt }; }) }));
    expect(noFont(back)).toEqual(noFont(src));
  });

  it("reads what execCommand produces (b, font color, div lines, br)", () => {
    const p = htmlToParagraphs(root('<div>a<b>b</b></div><div><br></div><div><font color="#ff0000">c</font></div>'));
    expect(p).toHaveLength(3);
    expect(p[0].runs).toMatchObject([{ text: "a" }, { text: "b", fmt: { bold: true } }]);
    expect(p[1].runs).toHaveLength(0);
    expect(p[2].runs[0]).toMatchObject({ text: "c", fmt: { color: "#ff0000" } });
    expect(mtextPlain(htmlToMtext(root("one<br>two")))).toBe("one\ntwo");
  });

  it("handles empty and hostile markup", () => {
    expect(htmlToMtext(root(""))).toBe("");
    expect(mtextPlain(htmlToMtext(root('<div>{\\x}</div><script>1</script>')))).toContain("{\\x}");
  });
});
