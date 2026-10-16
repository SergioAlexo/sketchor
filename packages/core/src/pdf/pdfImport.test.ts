/**
 * Why: vendors send PDFs, and a wrong import silently corrupts a drawing
 * (wrong scale, mirrored, lost curves) or hangs the app on a hostile file.
 * Fixtures are built inline here (never real customer files); they cover the
 * three physical layouts a PDF can have (classic xref, xref + object streams,
 * no usable xref at all), the operators CAD exports use, and input that must
 * terminate.
 */
import { describe, expect, it } from "vitest";
import type { Entity, PolylineEntity, SplineEntity, TextEntity } from "../entities";
import { inflate } from "./inflate";
import { importPdf } from "./index";

const enc = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0) & 255);
const cat = (...p: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(p.reduce((n, b) => n + b.length, 0));
  let o = 0;
  for (const b of p) {
    out.set(b, o);
    o += b.length;
  }
  return out;
};
const b64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
/** zlib stream made of stored blocks (no compression) - exercises the container, not Huffman. */
function zstore(d: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [Uint8Array.of(0x78, 0x01)];
  for (let i = 0; i === 0 || i < d.length; i += 65535) {
    const n = Math.min(65535, d.length - i);
    parts.push(Uint8Array.of(i + n >= d.length ? 1 : 0, n & 255, n >> 8, ~n & 255, (~n >> 8) & 255), d.subarray(i, i + n));
  }
  parts.push(new Uint8Array(4));
  return cat(...parts);
}
// real zlib output (Node deflateSync, generated once): a fixed-Huffman and a dynamic-Huffman stream
const FIXED = b64("eJwzUDBQyFUwN1IwUMhRCAYAFG0C5g==");
const DYN_SRC = Array.from({ length: 60 }, (_, i) => `${i * 3} ${(i * 7) % 50} m ${i * 2 + 5} ${(i * 11) % 90} l S\n`).join("");
const DYN = b64("eJw9k8uR4DAIRO8bRYcgBAiIY9JY8r9OtZDn5PKzS3p8emGh4Vj4j59/ikAjIHJfD8TQKOx93wtb0PyqeoFs7CRRmA1xqJM43IckbJMEzrlkC6xIChFDDAfN0zMHBM9sbEWN2cKm6XY+L1Fs2u6Ajq4eKH138cZLCkZjFfgY24bRWBVnjM1BYXXECFtCKKyBHGEXuja0ML5u2BQ2gYywB49smPL627wFo7E5n5cojMYW8NfgAwpb4YzwKXa3+T1GODavaPrnCIezC83+jnAklMIekBFOoWvDi+25xGA0PgId4wxQmFIjXAtC4eM4I1zKqTVOIEa4DjaNTyHfThS72/zh7cTavKJZgLylWM42NEZ9UILOEdBxFhHQOYoNGmIsqJECz4eCO9FIpcPs4ILSOx25HlJOr5EBeeRwQxtZHO6gAsVLeOIlukHxUu7REOcmN+oWMCgZh0YF/JmbcOiNKrZqkLGuhixBPHcLrgeZ0mPism4A2SF58j4plBUMxKCXRFnFUQ/7S6Pw2MvOl0dR+CvhfIkU52iHfZmUQLwi4kulFPs2bHIpDOYjL5hssUwNv8sk2XU=");

type Obj = string | { dict: string; data: Uint8Array | string; raw?: boolean };

/** Builds a classic-xref PDF. `objs[n]` is object n+1; object 1 must be the catalog. */
function buildPdf(objs: Obj[], opts: { brokenXref?: boolean; trailerExtra?: string; noStartxref?: boolean } = {}): Uint8Array {
  const parts: Uint8Array[] = [enc("%PDF-1.7\n")];
  let off = parts[0].length;
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(off);
    let b: Uint8Array;
    if (typeof o === "string") b = enc(`${i + 1} 0 obj\n${o}\nendobj\n`);
    else {
      const d = typeof o.data === "string" ? enc(o.data) : o.data;
      b = cat(enc(`${i + 1} 0 obj\n<< ${o.dict} /Length ${d.length} >>\nstream\n`), d, enc("\nendstream\nendobj\n"));
    }
    parts.push(b);
    off += b.length;
  });
  const xrefAt = opts.brokenXref ? off + 12345 : off;
  let x = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) x += `${String(o).padStart(10, "0")} 00000 n \n`;
  x += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R ${opts.trailerExtra ?? ""}>>\n`;
  if (!opts.noStartxref) x += `startxref\n${xrefAt}\n%%EOF\n`;
  parts.push(enc(x));
  return cat(...parts);
}

/** Single-page document around a content stream. */
function pageDoc(content: string, extra = "", opts: { compress?: Uint8Array; mediaBox?: string; pageExtra?: string; extraObjs?: Obj[] } = {}): Uint8Array {
  const data = opts.compress ?? enc(content);
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox ${opts.mediaBox ?? "[0 0 200 100]"} /Contents 4 0 R /Resources << ${extra} >> ${opts.pageExtra ?? ""}>>`,
    { dict: opts.compress ? "/Filter /FlateDecode" : "", data },
    ...(opts.extraObjs ?? []),
  ]);
}

const poly = (es: Entity[]): PolylineEntity[] => es.filter((e): e is PolylineEntity => e.type === "polyline");
const MM = 25.4 / 72;
const near = (a: number, b: number, d = 1e-4) => expect(Math.abs(a - b)).toBeLessThan(d);

describe("PDF import: paths", () => {
  it("imports a stroked line in mm with the origin at the page's lower-left", () => {
    const r = importPdf(pageDoc("72 0 m 144 72 l S"));
    expect(r.error).toBeUndefined();
    const [p] = poly(r.entities);
    near(p.points[0].x, 25.4);
    near(p.points[0].y, 0);
    near(p.points[1].x, 50.8);
    near(p.points[1].y, 25.4);
    expect(p.closed).toBe(false);
    near(r.pageSize!.width, 200 * MM);
    near(r.pageSize!.height, 100 * MM);
  });

  it("uses the MediaBox origin and CropBox, so offsets do not leak into the drawing", () => {
    const r = importPdf(pageDoc("100 50 m 110 50 l S", "", { mediaBox: "[100 50 300 150]" }));
    const [p] = poly(r.entities);
    near(p.points[0].x, 0);
    near(p.points[0].y, 0);
    near(p.points[1].x, 10 * MM);
  });

  it("applies /Rotate so the drawing looks as the page displays", () => {
    const r = importPdf(pageDoc("0 0 m 100 0 l S", "", { pageExtra: "/Rotate 90 " }));
    const [p] = poly(r.entities);
    // page 200x100 rotated 90 cw -> 100 wide, 200 tall; a bottom edge line becomes a left-edge line running down->..
    near(r.pageSize!.width, 100 * MM);
    near(r.pageSize!.height, 200 * MM);
    near(p.points[0].x, 0);
    near(p.points[0].y, 200 * MM);
    near(p.points[1].x, 0);
    near(p.points[1].y, 100 * MM);
  });

  it("closed rectangles become closed polylines; fill carries the colour", () => {
    const r = importPdf(pageDoc("1 0 0 rg 10 10 40 20 re f"));
    const [p] = poly(r.entities);
    expect(p.closed).toBe(true);
    expect(p.points).toHaveLength(4);
    expect(p.fill).toBe("#ff0000");
  });

  it("curves stay exact cubic splines (c, v, y)", () => {
    const r = importPdf(pageDoc("0 0 m 10 20 30 20 40 0 c 50 -20 70 0 80 0 v 90 0 100 10 100 10 y S"));
    const sp = r.entities.filter((e): e is SplineEntity => e.type === "spline");
    expect(sp).toHaveLength(1);
    expect(sp[0].controlPoints).toHaveLength(10);
    near(sp[0].controlPoints[1].x, 10 * MM);
    // v: first control point is the current point
    near(sp[0].controlPoints[4].x, 40 * MM);
    // y: second control point equals the end point
    near(sp[0].controlPoints[8].x, 100 * MM);
    near(sp[0].controlPoints[9].x, 100 * MM);
  });

  it("four quarter-turn Béziers are recognised as a circle", () => {
    const k = 0.5522847498 * 20;
    const c = `120 50 m 120 ${50 + k} ${100 + k} 70 100 70 c ${100 - k} 70 80 ${50 + k} 80 50 c 80 ${50 - k} ${100 - k} 30 100 30 c ${100 + k} 30 120 ${50 - k} 120 50 c h S`;
    const r = importPdf(pageDoc(c));
    const circ = r.entities.find((e) => e.type === "circle") as { center: { x: number; y: number }; radius: number } | undefined;
    expect(circ).toBeDefined();
    near(circ!.radius, 20 * MM, 1e-3);
    near(circ!.center.x, 100 * MM, 1e-3);
  });

  it("cm transforms and nested q/Q restore state correctly", () => {
    const r = importPdf(pageDoc("q 2 0 0 2 10 10 cm 0 0 m 10 0 l S q 1 0 0 1 100 0 cm 0 0 m 5 0 l S Q 0 5 m 10 5 l S Q 0 90 m 10 90 l S"));
    const ps = poly(r.entities);
    expect(ps).toHaveLength(4);
    near(ps[0].points[1].x, 30 * MM); // 2*10+10
    near(ps[1].points[0].x, 210 * MM); // 2*100+10 -> nested cm composes
    near(ps[2].points[0].y, 20 * MM); // after Q the 2x scale is back: 2*5+10
    near(ps[3].points[0].y, 90 * MM); // after the outer Q the identity is back
  });

  it("line width and dash map to lineweight and a builtin linetype", () => {
    const r = importPdf(pageDoc("2.8346457 w [6 3] 0 d 0 0 m 50 0 l S"));
    const [p] = poly(r.entities);
    near(p.lineweight!, 1, 1e-3);
    expect(p.linetype).toBeTruthy();
    expect(p.linetype).not.toBe("CONTINUOUS");
  });

  it("black is automatic (no colour); coloured strokes keep CSS colour; CMYK converts", () => {
    const r = importPdf(pageDoc("0 0 m 10 0 l S 0 1 0 RG 0 5 m 10 5 l S 0 1 1 0 K 0 9 m 10 9 l S"));
    const ps = poly(r.entities);
    expect(ps[0].color).toBeUndefined();
    expect(ps[1].color).toBe("#00ff00");
    expect(ps[2].color).toBe("#ff0000");
  });

  it("fill+stroke (B) of one shape is one entity with both styles", () => {
    const r = importPdf(pageDoc("1 0 0 rg 0 0 1 RG 0 0 10 10 re B"));
    expect(r.entities).toHaveLength(1);
    const e = r.entities[0] as PolylineEntity;
    expect(e.fill).toBe("#ff0000");
    expect(e.color).toBe("#0000ff");
  });

  it("a compound filled path becomes one hatch", () => {
    const r = importPdf(pageDoc("0 0 100 100 re 25 25 50 50 re f*"));
    expect(r.entities.filter((e) => e.type === "hatch")).toHaveLength(1);
  });

  it("clipping paths smaller than the page are reported, not applied", () => {
    const r = importPdf(pageDoc("10 10 20 20 re W n 0 0 m 100 0 l S"));
    expect(poly(r.entities)).toHaveLength(1);
    expect(r.warnings.join("\n")).toMatch(/clipping/);
  });
});

describe("PDF import: structure", () => {
  it("reads FlateDecode content streams", () => {
    const r = importPdf(pageDoc("", "", { compress: FIXED }));
    expect(poly(r.entities)).toHaveLength(1);
    near(poly(r.entities)[0].points[1].x, 25.4);
  });

  it("reads dynamic-Huffman streams and stored blocks", () => {
    expect(new TextDecoder().decode(inflate(DYN))).toBe(DYN_SRC);
    expect(poly(importPdf(pageDoc("", "", { compress: DYN })).entities)).toHaveLength(60);
    expect(poly(importPdf(pageDoc("", "", { compress: zstore(enc("0 0 m 5 5 l S")) })).entities)).toHaveLength(1);
  });

  it("follows Form XObjects with their Matrix and own resources", () => {
    const form = { dict: "/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Matrix [1 0 0 1 50 0]", data: "0 0 m 10 0 l S" };
    const r = importPdf(pageDoc("q 2 0 0 2 0 0 cm /F1 Do Q /F1 Do", "/XObject << /F1 5 0 R >>", { extraObjs: [form] }));
    const ps = poly(r.entities);
    expect(ps).toHaveLength(2);
    near(ps[0].points[0].x, 100 * MM); // (0+50)*2
    near(ps[0].points[1].x, 120 * MM);
    near(ps[1].points[0].x, 50 * MM);
  });

  it("a Form XObject that draws itself terminates", () => {
    const form = { dict: "/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Resources << /XObject << /F1 5 0 R >> >>", data: "0 0 m 1 1 l S /F1 Do /F1 Do" };
    const r = importPdf(pageDoc("/F1 Do", "/XObject << /F1 5 0 R >>", { extraObjs: [form] }));
    expect(r.error).toBeUndefined();
    expect(poly(r.entities).length).toBeGreaterThan(0);
  });

  it("recovers when the xref is wrong (rebuild scan)", () => {
    const good = pageDoc("0 0 m 72 0 l S");
    const bad = buildPdf(
      [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R >>",
        { dict: "", data: "0 0 m 72 0 l S" },
      ],
      { brokenXref: true },
    );
    expect(poly(importPdf(good).entities)).toHaveLength(1);
    expect(poly(importPdf(bad).entities)).toHaveLength(1);
    const noStart = buildPdf(["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] /Contents 4 0 R >>", { dict: "", data: "0 0 m 5 5 l S" }], { noStartxref: true });
    expect(poly(importPdf(noStart).entities)).toHaveLength(1);
  });

  it("reads xref streams and object streams (PDF 1.5 layout)", () => {
    // objects 1..3 live in object stream 5; stream 4 is the content; 6 is the xref stream
    const content = enc("0 0 m 72 36 l S");
    const inner = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R >>"];
    let head = "";
    let body = "";
    inner.forEach((s, i) => {
      head += `${i + 1} ${body.length} `;
      body += s + "\n";
    });
    const objstm = zstore(enc(head + body));
    const parts: Uint8Array[] = [enc("%PDF-1.5\n")];
    let off = parts[0].length;
    const offs: Record<number, number> = {};
    const push = (n: number, b: Uint8Array) => {
      offs[n] = off;
      parts.push(b);
      off += b.length;
    };
    push(4, cat(enc(`4 0 obj\n<< /Length ${content.length} >>\nstream\n`), content, enc("\nendstream\nendobj\n")));
    push(5, cat(enc(`5 0 obj\n<< /Type /ObjStm /N 3 /First ${head.length} /Filter /FlateDecode /Length ${objstm.length} >>\nstream\n`), objstm, enc("\nendstream\nendobj\n")));
    const xrefOff = off;
    const row = (t: number, a: number, b: number) => [t, (a >> 16) & 255, (a >> 8) & 255, a & 255, b];
    const rows = [row(0, 0, 255), row(2, 5, 0), row(2, 5, 1), row(2, 5, 2), row(1, offs[4], 0), row(1, offs[5], 0), row(1, xrefOff, 0)].flat();
    const xs = zstore(Uint8Array.from(rows));
    push(6, cat(enc(`6 0 obj\n<< /Type /XRef /Size 7 /W [1 3 1] /Root 1 0 R /Filter /FlateDecode /Length ${xs.length} >>\nstream\n`), xs, enc("\nendstream\nendobj\n")));
    parts.push(enc(`startxref\n${xrefOff}\n%%EOF\n`));
    const r = importPdf(cat(...parts));
    expect(r.error).toBeUndefined();
    const [p] = poly(r.entities);
    near(p.points[1].x, 25.4);
    near(p.points[1].y, 12.7);
  });

  it("selects pages and reports the count", () => {
    const bytes = buildPdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 5 0 R >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 6 0 R >>",
      { dict: "", data: "0 0 m 10 0 l S" },
      { dict: "", data: "0 0 m 0 20 l S" },
    ]);
    const a = importPdf(bytes);
    const b = importPdf(bytes, { page: 2 });
    expect(a.pageCount).toBe(2);
    near(poly(a.entities)[0].points[1].x, 10 * MM);
    near(poly(b.entities)[0].points[1].y, 20 * MM);
    expect(a.warnings.join()).toMatch(/2 pages/);
    expect(importPdf(bytes, { page: 3 }).error).toMatch(/page 3 does not exist/);
  });

  it("inherits MediaBox from the page tree and concatenates content arrays", () => {
    const bytes = buildPdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 50 50] >>",
      "<< /Type /Page /Parent 2 0 R /Contents [4 0 R 5 0 R] >>",
      { dict: "", data: "0 0 m 10 " },
      { dict: "", data: "10 l S" },
    ]);
    const r = importPdf(bytes);
    near(r.pageSize!.width, 50 * MM);
    expect(poly(r.entities)).toHaveLength(1);
  });
});

describe("PDF import: text", () => {
  const font = "/Font << /F1 5 0 R >>";
  const f1 = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /FirstChar 32 /LastChar 34 /Widths [278 278 355] >>";

  it("shows text as TEXT entities with position, height and rotation", () => {
    const r = importPdf(pageDoc("BT /F1 12 Tf 1 0 0 1 72 36 Tm (Hello) Tj ET", font, { extraObjs: [f1] }));
    const t = r.entities.find((e): e is TextEntity => e.type === "text")!;
    expect(t.text).toBe("Hello");
    near(t.at.x, 25.4);
    near(t.at.y, 12.7);
    near(t.height, 12 * MM);
    near(t.rotation, 0);
    const r2 = importPdf(pageDoc("BT /F1 10 Tf 0 1 -1 0 20 20 Tm [(A) -300 (B)] TJ ET", font, { extraObjs: [f1] }));
    const t2 = r2.entities.find((e): e is TextEntity => e.type === "text")!;
    expect(t2.text).toBe("A B");
    near(t2.rotation, Math.PI / 2);
  });

  it("decodes hex strings via a ToUnicode CMap on a composite font", () => {
    const cmap = "/CIDInit /ProcSet findresource begin 12 dict begin begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange 2 beginbfchar <0001> <0058> <0002> <0059> endbfchar 1 beginbfrange <0003> <0005> <0041> endbfrange endcmap end end";
    const type0 = "<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>";
    const cid = "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /X /DW 600 >>";
    const r = importPdf(pageDoc("BT /F1 10 Tf 10 10 Td <00010002000300040005> Tj ET", font, { extraObjs: [type0, cid, { dict: "", data: cmap }] }));
    expect((r.entities.find((e) => e.type === "text") as TextEntity).text).toBe("XYABC");
  });

  it("applies /Differences glyph names", () => {
    const f = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Type /Encoding /Differences [65 /bullet /endash] >> >>";
    const r = importPdf(pageDoc("BT /F1 10 Tf 10 10 Td (AB) Tj ET", font, { extraObjs: [f] }));
    expect((r.entities.find((e) => e.type === "text") as TextEntity).text).toBe("•–");
  });

  it("invisible text (Tr 3) is not imported", () => {
    const r = importPdf(pageDoc("BT /F1 12 Tf 3 Tr 10 10 Td (ghost) Tj ET", font, { extraObjs: [f1] }));
    expect(r.entities.filter((e) => e.type === "text")).toHaveLength(0);
  });
});

describe("PDF import: layers and colour spaces", () => {
  it("optional-content groups name the layer; OFF groups are skipped", () => {
    const bytes = buildPdf([
      "<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [5 0 R 6 0 R] /D << /OFF [6 0 R] >> >> >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R /Resources << /Properties << /L1 5 0 R /L2 6 0 R >> >> >>",
      { dict: "", data: "/OC /L1 BDC 0 0 m 10 0 l S EMC /OC /L2 BDC 0 5 m 10 5 l S EMC 0 9 m 10 9 l S" },
      "<< /Type /OCG /Name (Cut) >>",
      "<< /Type /OCG /Name (Hidden) >>",
    ]);
    const r = importPdf(bytes);
    const ps = poly(r.entities);
    expect(ps).toHaveLength(2);
    expect(ps[0].layer).toBe("Cut");
    expect(ps[1].layer).toBeUndefined();
    expect(r.warnings.join()).toMatch(/hidden layers/);
  });

  it("ICCBased, Indexed and Separation colours resolve to RGB", () => {
    const icc = { dict: "/N 3", data: "" };
    const r = importPdf(
      pageDoc(
        "/CS1 cs 1 0 0 sc 0 0 5 5 re f /CS2 cs 1 sc 0 10 5 5 re f /CS3 cs 1 sc 0 20 5 5 re f",
        "/ColorSpace << /CS1 [/ICCBased 5 0 R] /CS2 [/Indexed /DeviceRGB 1 <000000 00FF00>] /CS3 [/Separation /Spot /DeviceRGB << /FunctionType 2 /Domain [0 1] /C0 [1 1 1] /C1 [0 0 1] /N 1 >>] >>",
        { extraObjs: [icc] },
      ),
    );
    const fills = poly(r.entities).map((p) => p.fill);
    expect(fills).toEqual(["#ff0000", "#00ff00", "#0000ff"]);
  });
});

describe("PDF import: hostile and malformed input", () => {
  it("rejects non-PDF and empty input with a message", () => {
    expect(importPdf(new Uint8Array(0)).error).toMatch(/not a PDF/);
    expect(importPdf(enc("hello world")).error).toMatch(/not a PDF/);
  });

  it("reports encrypted PDFs cleanly", () => {
    const bytes = buildPdf(["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >>", "<< /Filter /Standard /V 1 /R 2 >>"], { trailerExtra: "/Encrypt 4 0 R " });
    const r = importPdf(bytes);
    expect(r.error).toMatch(/password-protected|encrypted/);
    expect(r.entities).toHaveLength(0);
  });

  it("survives truncation at every length of a valid file without throwing", () => {
    const good = pageDoc("", "", { compress: DYN });
    for (let n = 0; n < good.length; n += 7) {
      const r = importPdf(good.subarray(0, n));
      expect(Array.isArray(r.entities)).toBe(true);
    }
  });

  it("survives garbage bytes after a PDF header", () => {
    const junk = new Uint8Array(4000);
    for (let i = 0; i < junk.length; i++) junk[i] = (i * 7919 + 13) & 255;
    expect(() => importPdf(cat(enc("%PDF-1.4\n"), junk))).not.toThrow();
    expect(importPdf(cat(enc("%PDF-1.4\n"), junk)).error).toBeTruthy();
  });

  it("a circular page tree and self-referencing objects terminate", () => {
    const bytes = buildPdf(["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [2 0 R 3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox 3 0 R /Contents 3 0 R >>"]);
    expect(() => importPdf(bytes)).not.toThrow();
  });

  it("deeply nested arrays/dicts and q-storms do not overflow the stack", () => {
    const deep = "[".repeat(50000) + "]".repeat(50000);
    expect(() => importPdf(pageDoc(`${deep} 0 m 1 1 l S`))).not.toThrow();
    const qs = "q ".repeat(100000) + "0 0 m 10 0 l S " + "Q ".repeat(100000);
    const r = importPdf(pageDoc(qs));
    expect(poly(r.entities)).toHaveLength(1);
  });

  it("non-finite and absurd numbers are dropped", () => {
    const r = importPdf(pageDoc("1e999 0 m 1e30 5 l 0 0 m 10 0 l 99999999999999999999999999 0 0 1 0 0 cm S"));
    for (const e of r.entities) for (const p of (e as PolylineEntity).points ?? []) expect(Number.isFinite(p.x) && Math.abs(p.x) < 1e8).toBe(true);
  });

  it("the op budget stops a huge content stream and says so", () => {
    const big = "0 0 m 1 1 l S ".repeat(5000);
    const r = importPdf(pageDoc(big), { maxOps: 1000 });
    expect(r.warnings.join()).toMatch(/too complex/);
    expect(r.entities.length).toBeLessThan(1000);
  });

  it("the entity cap stops import with a warning", () => {
    const r = importPdf(pageDoc("0 0 m 1 1 l S ".repeat(100)), { maxEntities: 10 });
    expect(r.entities).toHaveLength(10);
    expect(r.warnings.join()).toMatch(/entity limit/);
  });

  it("a decompression bomb is capped instead of exhausting memory", () => {
    // fixed-Huffman block: one literal 0, then 5000 x (length 258, distance 1) = 1.29 MB from ~8 KB
    const bits: number[] = [1, 1, 0]; // BFINAL, BTYPE=01 (LSB first)
    const code = (v: number, n: number) => {
      for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1); // Huffman codes are MSB first
    };
    code(0x30, 8);
    for (let i = 0; i < 5000; i++) {
      code(0xc5, 8); // symbol 285 = length 258
      code(0, 5); // distance code 0 = 1
    }
    code(0, 7); // end of block
    const raw = new Uint8Array(Math.ceil(bits.length / 8));
    bits.forEach((bit, i) => (raw[i >> 3] |= bit << (i & 7)));
    expect(raw.length).toBeLessThan(10_000);
    expect(inflate(cat(Uint8Array.of(0x78, 0x01), raw)).length).toBe(1 + 5000 * 258);
    expect(inflate(cat(Uint8Array.of(0x78, 0x01), raw), 100_000).length).toBe(100_000);
  });
});
