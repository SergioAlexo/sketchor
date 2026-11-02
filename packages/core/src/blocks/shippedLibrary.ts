import type { ArcEntity, CircleEntity, Entity, LineEntity, PolylineEntity } from "../entities";
import type { Point } from "../geometry";
import type { BlockAction, BlockParam, DynamicSpec, LookupTable, ValueSet, VisibilityState } from "./dynamic";
import type { LibraryEntry } from "./library";
import type { AttributeDef, BlockDefinition } from "./types";

/**
 * B-23: the library Sketchor ships ("Sketchor library" source of the Block
 * library panel; also the template for plugin block packs, B-24). Every block
 * is authored here from plain geometry with our own dynamic spec — doors,
 * windows, fasteners, sheet-metal features, drawing symbols, structural
 * sections and title blocks — and dimensions are public standard values
 * (nominal sizes), nothing copied from any vendor's library. Sizes that come
 * as families (bolt M3..M24, sheet A4..ANSI E, beam sections) are lookup
 * tables, so one block covers the family.
 *
 * Authoring conventions: geometry is drawn at one reference size and the
 * actions turn parameter values into changes. Uniform families use `scale`
 * about the param's base; section/sheet families use `stretch` frames whose
 * boxes only contain the points that must travel (frames are in definition
 * coordinates and actions run in listed order, so e.g. a wall thickness is
 * applied before the overall size moves the points the frame would catch).
 */

const line = (id: string, ax: number, ay: number, bx: number, by: number, extra: Partial<LineEntity> = {}): LineEntity => ({ id, type: "line", a: { x: ax, y: ay }, b: { x: bx, y: by }, ...extra });
const circle = (id: string, cx: number, cy: number, radius: number, extra: Partial<CircleEntity> = {}): CircleEntity => ({ id, type: "circle", center: { x: cx, y: cy }, radius, ...extra });
const deg = (d: number): number => (d * Math.PI) / 180;
const arc = (id: string, cx: number, cy: number, radius: number, a0: number, a1: number): ArcEntity => ({ id, type: "arc", center: { x: cx, y: cy }, radius, startAngle: deg(a0), endAngle: deg(a1), ccw: true });
const poly = (id: string, pts: [number, number][], closed = true): PolylineEntity => ({ id, type: "polyline", points: pts.map(([x, y]) => ({ x, y })), closed });
const pt = (x: number, y: number): Point => ({ x, y });

const attr = (tag: string, x: number, y: number, height: number, prompt: string, def = ""): AttributeDef => ({ tag, prompt, ...(def ? { default: def } : {}), at: pt(x, y), height, rotation: 0, flags: {} });

interface Make {
  name: string;
  description: string;
  entities: Entity[];
  params: BlockParam[];
  actions: BlockAction[];
  visibilityStates?: VisibilityState[];
  lookup?: LookupTable[];
  attributeDefs?: AttributeDef[];
}
const make = (m: Make): BlockDefinition => {
  const dynamic: DynamicSpec = { params: m.params, actions: m.actions, ...(m.visibilityStates ? { visibilityStates: m.visibilityStates } : {}), ...(m.lookup ? { lookup: m.lookup } : {}) };
  return { name: m.name, basePoint: pt(0, 0), entities: m.entities, attributeDefs: m.attributeDefs ?? [], description: m.description, explodable: true, scaleUniformly: false, dynamic };
};

const linear = (name: string, label: string, base: Point, end: Point, values?: ValueSet): BlockParam => ({ kind: "linear", name, label, base, end, ...(values ? { values } : {}) });
const stretch = (param: string, x0: number, y0: number, x1: number, y1: number, multiplier?: number): BlockAction => ({ kind: "stretch", param, frame: { min: pt(x0, y0), max: pt(x1, y1) }, ...(multiplier !== undefined ? { multiplier } : {}) });

// ---- Doors and windows (wall thickness 100, reference opening 900) ----

export function doorBlock(): BlockDefinition {
  return make({
    name: "SK_DOOR",
    description: "Door in plan: width, hinge side, swing side and type (single / double / sliding).",
    entities: [
      line("jambL", 0, -50, 0, 50),
      line("jambR", 900, -50, 900, 50),
      line("leafS", 0, 0, 0, 900),
      arc("swingS", 0, 0, 900, 0, 90),
      line("leafDL", 0, 0, 0, 450),
      arc("swingDL", 0, 0, 450, 0, 90),
      line("leafDR", 900, 0, 900, 450),
      arc("swingDR", 900, 0, 450, 90, 180),
      poly("slideA", [[0, 10], [500, 10], [500, 30], [0, 30]]),
      poly("slideB", [[400, -30], [900, -30], [900, -10], [400, -10]]),
    ],
    params: [
      { kind: "visibility", name: "Type", label: "Type" },
      linear("Width", "Width", pt(0, 0), pt(900, 0), { min: 600, max: 2400, increment: 50 }),
      { kind: "flip", name: "Hinge", label: "Hinge side", base: pt(450, -100), end: pt(450, 100) },
      { kind: "flip", name: "Swing", label: "Swing side", base: pt(0, 0), end: pt(900, 0) },
    ],
    actions: [
      { kind: "flip", param: "Hinge" },
      { kind: "flip", param: "Swing" },
      { kind: "scale", param: "Width" },
    ],
    visibilityStates: [
      { name: "Single", visible: ["leafS", "swingS"] },
      { name: "Double", visible: ["leafDL", "swingDL", "leafDR", "swingDR"] },
      { name: "Sliding", visible: ["slideA", "slideB"] },
    ],
  });
}

export function windowBlock(): BlockDefinition {
  return make({
    name: "SK_WINDOW",
    description: "Window in plan (200 wall): width and type (fixed / with mullion).",
    entities: [
      line("head", 0, 100, 900, 100),
      line("sill", 0, -100, 900, -100),
      line("endL", 0, -100, 0, 100),
      line("endR", 900, -100, 900, 100),
      line("glassA", 0, -10, 900, -10),
      line("glassB", 0, 10, 900, 10),
      line("mullion", 450, -100, 450, 100),
    ],
    params: [{ kind: "visibility", name: "Type", label: "Type" }, linear("Width", "Width", pt(0, 0), pt(900, 0), { min: 400, max: 3000, increment: 50 })],
    actions: [stretch("Width", 800, -150, 1000, 150), { kind: "move", param: "Width", entities: ["mullion"], multiplier: 0.5 }],
    visibilityStates: [
      { name: "Fixed", visible: ["glassA", "glassB"] },
      { name: "With mullion", visible: ["glassA", "glassB", "mullion"] },
    ],
  });
}

// ---- Fasteners (reference size M10; Diameter scales the block) ----

interface FastenerSize {
  label: string;
  d: number;
}
/** Nominal diameters in mm: ISO metric coarse M3-M24 and the common inch sizes. */
export const FASTENER_SIZES: readonly FastenerSize[] = [
  ...[3, 4, 5, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24].map((d) => ({ label: `M${d}`, d })),
  { label: '1/4"', d: 6.35 },
  { label: '5/16"', d: 7.9375 },
  { label: '3/8"', d: 9.525 },
  { label: '1/2"', d: 12.7 },
  { label: '5/8"', d: 15.875 },
  { label: '3/4"', d: 19.05 },
  { label: '1"', d: 25.4 },
];
const sizeLookup = (): LookupTable => ({ name: "sizes", inputs: ["Diameter"], rows: FASTENER_SIZES.map((s) => ({ label: s.label, values: { Diameter: s.d } })) });
const sizeParams = (): BlockParam[] => [{ kind: "lookup", name: "Size", label: "Size", table: "sizes", default: "M10" }, linear("Diameter", "Diameter", pt(0, 0), pt(10, 0))];

export function boltBlock(): BlockDefinition {
  return make({
    name: "SK_BOLT_HEX",
    description: "Hex head bolt, side view. Size from the metric/inch table; length in multiples of the diameter.",
    entities: [
      poly("head", [[0, -8.5], [7, -8.5], [7, 8.5], [0, 8.5]]),
      line("shankT", 7, 5, 57, 5),
      line("shankB", 7, -5, 57, -5),
      line("tip", 57, -5, 57, 5),
      line("threadT", 7, 4, 57, 4, { linetype: "DASHED" }),
      line("threadB", 7, -4, 57, -4, { linetype: "DASHED" }),
      line("axis", -3, 0, 60, 0, { linetype: "CENTER", construction: true }),
    ],
    params: [...sizeParams(), linear("Length", "Length (x d)", pt(0, 0), pt(5, 0), { list: [2, 3, 4, 5, 6, 8, 10, 12] })],
    actions: [{ kind: "lookup", param: "Size" }, stretch("Length", 50, -12, 70, 12, 10), { kind: "scale", param: "Diameter" }],
    lookup: [sizeLookup()],
  });
}

export function nutBlock(): BlockDefinition {
  const R = 17 / Math.sqrt(3);
  const hex: [number, number][] = Array.from({ length: 6 }, (_, i) => [R * Math.cos(deg(60 * i)), R * Math.sin(deg(60 * i))]);
  return make({
    name: "SK_NUT_HEX",
    description: "Hex nut, top view.",
    entities: [poly("hex", hex), circle("bore", 0, 0, 5), circle("thread", 0, 0, 4.2, { linetype: "DASHED" })],
    params: sizeParams(),
    actions: [{ kind: "lookup", param: "Size" }, { kind: "scale", param: "Diameter" }],
    lookup: [sizeLookup()],
  });
}

export function washerBlock(): BlockDefinition {
  return make({
    name: "SK_WASHER",
    description: "Plain washer, top view (outer 2d, hole d + 0.5).",
    entities: [circle("outer", 0, 0, 10), circle("inner", 0, 0, 5.25)],
    params: sizeParams(),
    actions: [{ kind: "lookup", param: "Size" }, { kind: "scale", param: "Diameter" }],
    lookup: [sizeLookup()],
  });
}

// ---- Sheet-metal features ----

export function holeBlock(): BlockDefinition {
  return make({
    name: "SK_HOLE",
    description: "Round hole with centre marks; the diameter scales it.",
    entities: [circle("hole", 0, 0, 5), line("cx", -8, 0, 8, 0, { linetype: "CENTER", construction: true }), line("cy", 0, -8, 0, 8, { linetype: "CENTER", construction: true })],
    params: [linear("Diameter", "Diameter", pt(0, 0), pt(10, 0), { min: 1, max: 200, increment: 0.5 })],
    actions: [{ kind: "scale", param: "Diameter" }],
  });
}

export function slotBlock(): BlockDefinition {
  return make({
    name: "SK_SLOT",
    description: "Obround slot (width 10): centre-to-centre length is the parameter.",
    entities: [line("top", 0, 5, 30, 5), line("bottom", 0, -5, 30, -5), arc("capL", 0, 0, 5, 90, 270), arc("capR", 30, 0, 5, -90, 90), line("axis", -8, 0, 38, 0, { linetype: "CENTER", construction: true })],
    params: [linear("Length", "Centre distance", pt(0, 0), pt(30, 0), { min: 2, max: 400, increment: 1 })],
    actions: [stretch("Length", 20, -12, 60, 12)],
  });
}

// ---- Drawing symbols ----

export function northArrowBlock(): BlockDefinition {
  return make({
    name: "SK_NORTH_ARROW",
    description: "North arrow; the size is the circle radius.",
    entities: [circle("ring", 0, 0, 50), poly("needle", [[0, 50], [-15, -30], [0, -15], [15, -30]]), line("n1", -8, 60, -8, 80), line("n2", -8, 80, 8, 60), line("n3", 8, 60, 8, 80)],
    params: [linear("Size", "Radius", pt(0, 0), pt(50, 0), { list: [25, 50, 75, 100, 150] })],
    actions: [{ kind: "scale", param: "Size" }],
  });
}

export function sectionMarkerBlock(): BlockDefinition {
  return make({
    name: "SK_SECTION_MARKER",
    description: "Section / detail callout bubble with a view arrow; attributes NUM and SHEET.",
    entities: [circle("bubble", 0, 0, 6), line("bar", -6, 0, 6, 0), line("stem", 6, 0, 14, 0), poly("arrow", [[14, -3], [14, 3], [22, 0]])],
    params: [linear("Size", "Bubble radius", pt(0, 0), pt(6, 0), { list: [3, 4.5, 6, 9, 12] }), { kind: "flip", name: "Direction", label: "Arrow side", base: pt(0, -10), end: pt(0, 10) }],
    actions: [{ kind: "flip", param: "Direction", entities: ["stem", "arrow"] }, { kind: "scale", param: "Size" }],
    attributeDefs: [attr("NUM", -1.2, 1.2, 3.5, "Number", "1"), attr("SHEET", -1.2, -4.6, 2.5, "Sheet", "A1")],
  });
}

export function elevationMarkerBlock(): BlockDefinition {
  return make({
    name: "SK_ELEVATION_MARKER",
    description: "Level marker; attribute LEVEL; flips to point either way.",
    entities: [poly("tri", [[0, 0], [-5, 8], [5, 8]]), line("ext", -5, 8, 30, 8)],
    params: [{ kind: "flip", name: "Side", label: "Mirror", base: pt(0, 0), end: pt(0, 10) }],
    actions: [{ kind: "flip", param: "Side" }],
    attributeDefs: [attr("LEVEL", 8, 9.5, 3, "Level", "+0.000")],
  });
}

export function revisionTriangleBlock(): BlockDefinition {
  return make({
    name: "SK_REVISION_TRIANGLE",
    description: "Revision triangle; attribute REV.",
    entities: [poly("tri", [[-8, 0], [8, 0], [0, 14]])],
    params: [linear("Size", "Size", pt(-8, 0), pt(8, 0), { list: [8, 12, 16, 24] })],
    actions: [{ kind: "scale", param: "Size" }],
    attributeDefs: [attr("REV", -2, 3, 5, "Revision", "A")],
  });
}

export function surfaceFinishBlock(): BlockDefinition {
  return make({
    name: "SK_SURFACE_FINISH",
    description: "Surface texture symbol: basic, material removal required, removal prohibited. Attribute RA.",
    entities: [line("legL", 0, 0, -5, 8.66), line("legR", 0, 0, 10, 17.32), line("bar", 10, 17.32, 25, 17.32), line("close", -5, 8.66, 5, 8.66), circle("prohibited", 0, 7, 3.2)],
    params: [{ kind: "visibility", name: "Type", label: "Type" }],
    actions: [],
    visibilityStates: [
      { name: "Basic", visible: ["legL", "legR", "bar"] },
      { name: "Removal required", visible: ["legL", "legR", "bar", "close"] },
      { name: "Removal prohibited", visible: ["legL", "legR", "bar", "prohibited"] },
    ],
    attributeDefs: [attr("RA", 11, 19, 3.5, "Roughness", "Ra 1.6")],
  });
}

export function weldFilletBlock(): BlockDefinition {
  return make({
    name: "SK_WELD_FILLET",
    description: "Fillet weld symbol: arrow side or both sides; flips to the other side.",
    entities: [line("ref", 0, 0, 60, 0), line("arrow", 5, 0, -12, -18), poly("head", [[-12, -18], [-12, -12], [-6, -17]]), poly("triA", [[15, 0], [15, -8], [23, 0]]), poly("triB", [[15, 0], [15, 8], [23, 0]])],
    params: [{ kind: "visibility", name: "Sides", label: "Sides" }, { kind: "flip", name: "Side", label: "Other side", base: pt(0, 0), end: pt(60, 0) }],
    actions: [{ kind: "flip", param: "Side", entities: ["triA", "triB"] }],
    visibilityStates: [
      { name: "Arrow side", visible: ["triA"] },
      { name: "Both sides", visible: ["triA", "triB"] },
    ],
  });
}

// ---- Structural sections (centred on the origin; every row is nominal mm) ----

const I_ROWS: [string, number, number, number, number][] = [
  ["I-100", 100, 55, 4.1, 5.7],
  ["I-140", 140, 73, 4.7, 6.9],
  ["I-180", 180, 91, 5.3, 8],
  ["I-200", 200, 100, 5.6, 8.5],
  ["I-240", 240, 120, 6.2, 9.8],
  ["I-300", 300, 150, 7.1, 10.7],
  ["I-400", 400, 180, 8.6, 13.5],
];

export function beamIBlock(): BlockDefinition {
  const pts: [number, number][] = [[-50, -100], [50, -100], [50, -91], [3, -91], [3, 91], [50, 91], [50, 100], [-50, 100], [-50, 91], [-3, 91], [-3, -91], [-50, -91]];
  return make({
    name: "SK_BEAM_I",
    description: "I-section (depth H, flange width B, web tw, flange tf), centred. Sizes from the table.",
    entities: [poly("outline", pts)],
    params: [
      { kind: "lookup", name: "Size", label: "Section", table: "sections", default: "I-200" },
      linear("H", "Depth H", pt(0, 0), pt(0, 200)),
      linear("B", "Flange width B", pt(0, 0), pt(100, 0)),
      linear("tw", "Web tw", pt(0, 0), pt(6, 0)),
      linear("tf", "Flange tf", pt(0, 0), pt(0, 9)),
    ],
    actions: [
      { kind: "lookup", param: "Size" },
      stretch("tf", -120, 85, 120, 96, -1),
      stretch("tf", -120, -96, 120, -85, 1),
      stretch("tw", 1, -120, 12, 120, 0.5),
      stretch("tw", -12, -120, -1, 120, -0.5),
      stretch("B", 40, -400, 400, 400, 0.5),
      stretch("B", -400, -400, -40, 400, -0.5),
      stretch("H", -400, 50, 400, 600, 0.5),
      stretch("H", -400, -600, 400, -50, -0.5),
    ],
    lookup: [{ name: "sections", inputs: ["H", "B", "tw", "tf"], rows: I_ROWS.map(([label, H, B, tw, tf]) => ({ label, values: { H, B, tw, tf } })) }],
  });
}

const HSS_ROWS: [string, number, number, number, number][] = [
  ["HSS 40x40x3", 40, 40, 3, 3],
  ["HSS 60x40x3", 60, 40, 3, 3],
  ["HSS 100x50x4", 100, 50, 4, 4],
  ["HSS 100x100x5", 100, 100, 5, 5],
  ["HSS 200x100x6", 200, 100, 6, 6],
  ["HSS 200x200x8", 200, 200, 8, 8],
];

export function hssBlock(): BlockDefinition {
  return make({
    name: "SK_HSS",
    description: "Rectangular hollow section (H x B, wall sides / top and bottom), centred.",
    entities: [poly("outer", [[-25, -50], [25, -50], [25, 50], [-25, 50]]), poly("inner", [[-21, -46], [21, -46], [21, 46], [-21, 46]])],
    params: [
      { kind: "lookup", name: "Size", label: "Section", table: "sections", default: "HSS 100x50x4" },
      linear("H", "Height H", pt(0, 0), pt(0, 100)),
      linear("B", "Width B", pt(0, 0), pt(50, 0)),
      linear("tx", "Wall (sides)", pt(0, 0), pt(4, 0)),
      linear("ty", "Wall (top/bottom)", pt(0, 0), pt(0, 4)),
    ],
    actions: [
      { kind: "lookup", param: "Size" },
      stretch("tx", 8, -60, 24, 60, -1),
      stretch("tx", -24, -60, -8, 60, 1),
      stretch("ty", -60, 8, 60, 48, -1),
      stretch("ty", -60, -48, 60, -8, 1),
      stretch("B", 8, -400, 400, 400, 0.5),
      stretch("B", -400, -400, -8, 400, -0.5),
      stretch("H", -400, 8, 400, 600, 0.5),
      stretch("H", -400, -600, 400, -8, -0.5),
    ],
    lookup: [{ name: "sections", inputs: ["H", "B", "tx", "ty"], rows: HSS_ROWS.map(([label, H, B, tx, ty]) => ({ label, values: { H, B, tx, ty } })) }],
  });
}

const ANGLE_ROWS: [string, number, number, number][] = [
  ["L50x50x5", 50, 50, 5],
  ["L65x65x6", 65, 65, 6],
  ["L75x75x8", 75, 75, 8],
  ["L100x100x10", 100, 100, 10],
  ["L125x75x8", 125, 75, 8],
  ["L150x100x12", 150, 100, 12],
];

export function angleBlock(): BlockDefinition {
  return make({
    name: "SK_ANGLE",
    description: "Angle section (legs A and B, thicknesses), corner at the origin.",
    entities: [poly("outline", [[0, 0], [75, 0], [75, 8], [8, 8], [8, 75], [0, 75]])],
    params: [
      { kind: "lookup", name: "Size", label: "Section", table: "sections", default: "L75x75x8" },
      linear("A", "Leg A (horizontal)", pt(0, 0), pt(75, 0)),
      linear("B", "Leg B (vertical)", pt(0, 0), pt(0, 75)),
      linear("tx", "Thickness of vertical leg", pt(0, 0), pt(8, 0)),
      linear("ty", "Thickness of horizontal leg", pt(0, 0), pt(0, 8)),
    ],
    actions: [
      { kind: "lookup", param: "Size" },
      stretch("ty", -10, 3, 400, 20),
      stretch("tx", 3, -10, 20, 400),
      stretch("A", 50, -10, 800, 400),
      stretch("B", -10, 50, 400, 800),
    ],
    lookup: [{ name: "sections", inputs: ["A", "B", "tx", "ty"], rows: ANGLE_ROWS.map(([label, A, B, t]) => ({ label, values: { A, B, tx: t, ty: t } })) }],
  });
}

// ---- Title blocks (origin = lower-right corner of the sheet) ----

export const SHEET_SIZES: readonly { label: string; w: number; h: number }[] = [
  { label: "A4", w: 297, h: 210 },
  { label: "A3", w: 420, h: 297 },
  { label: "A2", w: 594, h: 420 },
  { label: "A1", w: 841, h: 594 },
  { label: "A0", w: 1189, h: 841 },
  { label: "ANSI A", w: 279.4, h: 215.9 },
  { label: "ANSI B", w: 431.8, h: 279.4 },
  { label: "ANSI C", w: 558.8, h: 431.8 },
  { label: "ANSI D", w: 863.6, h: 558.8 },
  { label: "ANSI E", w: 1117.6, h: 863.6 },
];

export function titleBlock(): BlockDefinition {
  return make({
    name: "SK_TITLE_BLOCK",
    description: "Sheet border (ISO A4-A0, ANSI A-E, landscape) with a 180 x 40 title block. Insert at the sheet's lower-right corner.",
    entities: [
      poly("sheet", [[-297, 0], [0, 0], [0, 210], [-297, 210]]),
      poly("frame", [[-277, 10], [-10, 10], [-10, 200], [-277, 200]]),
      poly("box", [[-190, 10], [-10, 10], [-10, 50], [-190, 50]]),
      line("row1", -190, 30, -10, 30),
      line("row2", -190, 20, -10, 20),
      line("col1", -100, 10, -100, 30),
      line("col2", -55, 10, -55, 20),
    ],
    params: [
      { kind: "lookup", name: "Sheet", label: "Sheet size", table: "sheets", default: "A4" },
      linear("Width", "Width", pt(0, 0), pt(-297, 0)),
      linear("Height", "Height", pt(0, 0), pt(0, 210)),
    ],
    actions: [{ kind: "lookup", param: "Sheet" }, stretch("Width", -5000, -50, -200, 5000), stretch("Height", -5000, 100, 50, 5000)],
    lookup: [{ name: "sheets", inputs: ["Width", "Height"], rows: SHEET_SIZES.map((s) => ({ label: s.label, values: { Width: s.w, Height: s.h } })) }],
    attributeDefs: [
      attr("TITLE", -188, 36, 5, "Drawing title"),
      attr("DWG_NO", -188, 23, 3.5, "Drawing number"),
      attr("REV", -53, 12.5, 3.5, "Revision"),
      attr("SCALE", -98, 12.5, 3.5, "Scale", "1:1"),
      attr("DATE", -188, 12.5, 3.5, "Date"),
      attr("DRAWN", -98, 23, 3.5, "Drawn by"),
      attr("SHEET", -30, 12.5, 3.5, "Sheet", "1/1"),
    ],
  });
}

/** Every shipped block, in the order the panel lists them. */
export function shippedBlocks(): BlockDefinition[] {
  return [
    doorBlock(),
    windowBlock(),
    boltBlock(),
    nutBlock(),
    washerBlock(),
    holeBlock(),
    slotBlock(),
    northArrowBlock(),
    sectionMarkerBlock(),
    elevationMarkerBlock(),
    revisionTriangleBlock(),
    surfaceFinishBlock(),
    weldFilletBlock(),
    beamIBlock(),
    hssBlock(),
    angleBlock(),
    titleBlock(),
  ];
}

/** Library category of each shipped block (for grouping in the panel). */
export const SHIPPED_CATEGORY: Record<string, string> = {
  SK_DOOR: "Architecture",
  SK_WINDOW: "Architecture",
  SK_BOLT_HEX: "Fasteners",
  SK_NUT_HEX: "Fasteners",
  SK_WASHER: "Fasteners",
  SK_HOLE: "Sheet metal",
  SK_SLOT: "Sheet metal",
  SK_NORTH_ARROW: "Symbols",
  SK_SECTION_MARKER: "Symbols",
  SK_ELEVATION_MARKER: "Symbols",
  SK_REVISION_TRIANGLE: "Symbols",
  SK_SURFACE_FINISH: "Symbols",
  SK_WELD_FILLET: "Symbols",
  SK_BEAM_I: "Structural",
  SK_HSS: "Structural",
  SK_ANGLE: "Structural",
  SK_TITLE_BLOCK: "Title blocks",
};

/** The shipped library as ordinary library entries (no nested blocks). */
export function shippedLibrary(): LibraryEntry[] {
  return shippedBlocks().map((def) => ({ def, deps: [] }));
}
