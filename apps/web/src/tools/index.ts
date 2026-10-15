import type { ToolId } from "../state/store";
import { ArcTool, CircleTool, EllipseTool, LineTool, PointTool, PolygonTool, PolylineTool, RectangleTool, SlotTool, SplineTool } from "./drawTools";
import { AlignTool, ChamferTool, DivideTool, FilletTool, LengthenTool, MatchTool, OffsetTool, SplitTool, StretchTool, TrimTool, ZoomWindowTool } from "./editTools";
import { BlockTool } from "./blockTool";
import { BlockBaseTool } from "./blockBaseTool";
import { InsertTool } from "./insertTool";
import { AttdefTool } from "./attdefTool";
import { HatchTool } from "./hatchTool";
import { SplineEditTool } from "./splineEditTool";
import { CopyTool, MirrorTool, MoveTool, RotateTool, ScaleTool } from "./modifyTools";
import { DimTool } from "./dimTools";
import type { Tool } from "./tool";

/**
 * The tools that run on the framework, one instance each (their in-progress
 * state must survive re-renders and tab switches, as the old interaction
 * ref did). Tools missing here still run on Viewport.tsx's legacy switch.
 */
const TOOLS: Partial<Record<ToolId, Tool>> = {
  line: new LineTool(),
  polyline: new PolylineTool(),
  rectangle: new RectangleTool(),
  circle: new CircleTool(),
  point: new PointTool(),
  arc: new ArcTool(),
  ellipse: new EllipseTool(),
  spline: new SplineTool(),
  splinedit: new SplineEditTool(),
  polygon: new PolygonTool(),
  slot: new SlotTool(),
  move: new MoveTool(),
  copy: new CopyTool(),
  rotate: new RotateTool(),
  scale: new ScaleTool(),
  mirror: new MirrorTool(),
  trim: new TrimTool(),
  split: new SplitTool(),
  fillet: new FilletTool(),
  chamfer: new ChamferTool(),
  offset: new OffsetTool(),
  zoom: new ZoomWindowTool(),
  divide: new DivideTool(),
  align: new AlignTool(),
  lengthen: new LengthenTool(),
  match: new MatchTool(),
  stretch: new StretchTool(),
  fill: new HatchTool(),
  block: new BlockTool(),
  blockbase: new BlockBaseTool(),
  insert: new InsertTool(),
  attdef: new AttdefTool(),
  dim: new DimTool("dim", "smart"),
  dimlinear: new DimTool("dimlinear", "linear"),
  dimaligned: new DimTool("dimaligned", "aligned"),
  dimangular: new DimTool("dimangular", "angular"),
  dimradial: new DimTool("dimradial", "radial"),
  dimdiametric: new DimTool("dimdiametric", "diametric"),
  dimarc: new DimTool("dimarc", "arclength"),
  dimordinate: new DimTool("dimordinate", "ordinate"),
  dimjogged: new DimTool("dimjogged", "jogged"),
  dimbaseline: new DimTool("dimbaseline", "baseline"),
  dimcontinue: new DimTool("dimcontinue", "continue"),
  qdim: new DimTool("qdim", "qdim"),
};

export function getTool(id: ToolId): Tool | null {
  return TOOLS[id] ?? null;
}

export * from "./tool";
