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
import { LeaderAddTool, LeaderTool } from "./leaderTool";
import { ArrayPathTool } from "./arrayPathTool";
import { ToleranceTool } from "./toleranceTool";
import { ViewportTool } from "./viewportTool";
import { PanTool } from "./panTool";
import { StraightenTool } from "./straightenTool";
import { ImageTool } from "./imageTool";
import { MTextTool, TextTool } from "./textTools";
import { MeasureTool } from "./measureTool";
import { SelectTool } from "./selectTool";
import type { Tool } from "./tool";

/**
 * Every tool, one instance each (their in-progress state must survive
 * re-renders and tab switches, as the old interaction ref did).
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
  arraypath: new ArrayPathTool(),
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
  dimcenter: new DimTool("dimcenter", "centermark"),
  dimcenterline: new DimTool("dimcenterline", "centerline"),
  qdim: new DimTool("qdim", "qdim"),
  leader: new LeaderTool("leader"),
  balloon: new LeaderTool("balloon"),
  leaderadd: new LeaderAddTool(),
  tolerance: new ToleranceTool(),
  viewport: new ViewportTool(),
  pan: new PanTool(),
  select: new SelectTool(),
  measure: new MeasureTool(),
  image: new ImageTool(),
  text: new TextTool(),
  mtext: new MTextTool(),
  straighten: new StraightenTool(),
};

export function getTool(id: ToolId): Tool | null {
  return TOOLS[id] ?? null;
}

export * from "./tool";
