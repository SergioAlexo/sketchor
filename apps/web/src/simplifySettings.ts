/**
 * P-03b: the tolerance (mm) the Simplify command uses and whether a fresh
 * import is simplified automatically. Per-viewer preferences, kept in
 * localStorage (every access guarded - private windows throw), not document
 * data, so there is nothing to undo.
 */

export const SIMPLIFY_DEFAULT_MM = 0.1;
export const SIMPLIFY_MAX_MM = 50;
const KEY_TOL = "sketchor.simplifyTol.v1";
const KEY_ON_IMPORT = "sketchor.simplifyOnImport.v1";

/** Parses "0.5", "0,5", "0.5mm"; null unless a positive number within range. */
export function parseSimplifyTolerance(text: string): number | null {
  const m = /^\s*([0-9]*[.,]?[0-9]+)\s*(mm)?\s*$/i.exec(text);
  if (!m) return null;
  const n = Number(m[1]!.replace(",", "."));
  return Number.isFinite(n) && n > 0 && n <= SIMPLIFY_MAX_MM ? n : null;
}

let memTol = SIMPLIFY_DEFAULT_MM;
let memOnImport = false;

export function getSimplifyTolerance(): number {
  try {
    const raw = localStorage.getItem(KEY_TOL);
    const n = raw === null ? null : parseSimplifyTolerance(raw);
    if (n !== null) return n;
  } catch {
    /* storage unavailable: fall back to the in-memory value */
  }
  return memTol;
}

/** Stores a valid tolerance; returns false (and changes nothing) for an invalid one. */
export function setSimplifyTolerance(mm: number): boolean {
  if (!(Number.isFinite(mm) && mm > 0 && mm <= SIMPLIFY_MAX_MM)) return false;
  memTol = mm;
  try {
    localStorage.setItem(KEY_TOL, String(mm));
  } catch {
    /* in-memory only */
  }
  return true;
}

export function getSimplifyOnImport(): boolean {
  try {
    const raw = localStorage.getItem(KEY_ON_IMPORT);
    if (raw !== null) return raw === "1";
  } catch {
    /* fall through */
  }
  return memOnImport;
}

export function setSimplifyOnImport(on: boolean): void {
  memOnImport = on;
  try {
    localStorage.setItem(KEY_ON_IMPORT, on ? "1" : "0");
  } catch {
    /* in-memory only */
  }
}
