import { checkMesh, describeMeshCheck, describeRepair, repairChangedNothing, repairMesh, write3mf, writeStl, type MeshPart } from "@sketchor/core";
import { DEFAULT_PART_RGB } from "./buildModel";
import type { Model3D } from "./types";

/**
 * F-11: the 3D view's export — the parts on screen as an STL or a 3MF.
 * Pure apart from the save at the end (kept in saveBytes.ts), so the
 * conversion and the options are tested in node.
 */

export type MeshExportFormat = "stl" | "stl-ascii" | "3mf";
export type MeshExportUnit = "mm" | "in" | "m";

/** File units per millimetre. */
export const UNIT_SCALE: Record<MeshExportUnit, number> = { mm: 1, in: 1 / 25.4, m: 0.001 };

const isDefault = (c: Uint8Array): boolean => {
  for (let i = 0; i < c.length; i += 3) if (c[i] !== DEFAULT_PART_RGB[0] || c[i + 1] !== DEFAULT_PART_RGB[1] || c[i + 2] !== DEFAULT_PART_RGB[2]) return false;
  return true;
};

/**
 * The model's parts as mesh parts in millimetres — `hidden` parts left out,
 * and colours kept only where the file gave the part one (the viewer's
 * stand-in grey is not written as a colour). Pass the model as the viewer
 * shows it (`reorientModel`): a Y-up file is then already turned Z-up,
 * which is what slicers and STL/3MF expect.
 */
export function modelToMeshParts(model: Model3D, hidden: ReadonlySet<number>): MeshPart[] {
  const out: MeshPart[] = [];
  model.parts.forEach((p, i) => {
    if (hidden.has(i) || p.indexCount === 0) return;
    const positions = model.positions.slice(p.vertexStart * 3, (p.vertexStart + p.vertexCount) * 3);
    const indices = model.indices.slice(p.indexStart, p.indexStart + p.indexCount);
    for (let k = 0; k < indices.length; k++) indices[k] -= p.vertexStart;
    const part: MeshPart = { name: p.name || `Part ${i + 1}`, positions, indices };
    const colors = model.colors.slice(p.vertexStart * 3, (p.vertexStart + p.vertexCount) * 3);
    if (!isDefault(colors)) part.colors = colors;
    out.push(part);
  });
  return out;
}

/** What a slicer would complain about, one line per problem, for the confirm before writing. */
export function exportProblems(parts: readonly MeshPart[]): string[] {
  return parts.flatMap((p) => describeMeshCheck(p.name, checkMesh(p)));
}

export function exportFileName(model: Model3D, format: MeshExportFormat): string {
  const base = model.name.replace(/\.[^.]*$/, "") || "model";
  return `${base}.${format === "3mf" ? "3mf" : "stl"}`;
}

export async function exportBytes(model: Model3D, parts: readonly MeshPart[], format: MeshExportFormat, unit: MeshExportUnit): Promise<Uint8Array> {
  const title = model.name.replace(/\.[^.]*$/, "");
  if (format === "3mf") return write3mf(parts, { unit: unit === "in" ? "inch" : unit === "m" ? "meter" : "millimeter", metadata: { Title: title } });
  return writeStl(parts, { format: format === "stl-ascii" ? "ascii" : "binary", scale: UNIT_SCALE[unit], colors: format === "stl" && parts.some((p) => p.colors), name: title });
}

/** F-11: every part through the one-click repair; the summary line names what changed per part. */
export function repairParts(parts: readonly MeshPart[]): { parts: MeshPart[]; summary: string[] } {
  const summary: string[] = [];
  const out = parts.map((p) => {
    const r = repairMesh(p);
    if (!repairChangedNothing(r.report) || r.report.holesLeft) summary.push(`${p.name}: ${describeRepair(r.report)}`);
    return r.part;
  });
  return { parts: out, summary };
}
