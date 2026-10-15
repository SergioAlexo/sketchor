// Writes a dimension sample (all record kinds + two styles) for `python tools/dxf-audit/audit.py`. Local check only.
import { writeFileSync } from "node:fs";
import { entitiesToDxf2018 } from "../../packages/core/src/dxfw/index";
import { DIM_STYLE_PRESETS, dimStyleRecord } from "../../packages/core/src/dimensions/style";
import "../../packages/core/src/kinds/builtin";
import type { DimensionEntity } from "../../packages/core/src/entities";

const D = (kind: DimensionEntity["kind"], pts: [number, number][], extra: Partial<DimensionEntity> = {}): DimensionEntity => ({
  id: `d-${kind}-${Math.random().toString(36).slice(2, 6)}`,
  type: "dimension",
  kind,
  defPoints: pts.map(([x, y]) => ({ x, y })),
  driving: false,
  ...extra,
});
const dims = [
  D("linear", [[0, 0], [40, 10], [20, 25]], { angle: 0, style: "ISO-25" }),
  D("aligned", [[0, 0], [30, 40], [10, 30]], { style: "DIN" }),
  D("angular2l", [[0, 0], [10, 0], [0, 0], [0, 10], [6, 6]]),
  D("angular3p", [[0, 0], [10, 0], [0, 10], [6, 6]]),
  D("radial", [[5, 5], [15, 5]]),
  D("diametric", [[5, 5], [15, 5]]),
  D("ordinate", [[0, 0], [30, 12], [30, 25]], { axis: "x" }),
];
writeFileSync(process.argv[2] ?? "dimsample.dxf", entitiesToDxf2018(dims, { dimStyles: DIM_STYLE_PRESETS.slice(0, 3).map((p) => dimStyleRecord(p)), currentDimStyle: "ISO-25" }));
