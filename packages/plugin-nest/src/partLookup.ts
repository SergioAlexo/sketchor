import { normName } from "./bom";

/**
 * RN-14: find the drawing file for a BOM part number in a picked folder.
 * Ported from the Sheet Nesting Calculator by Oleksandr Borenko.
 *
 * The rule is deliberately strict: exact name, then a name that says the file
 * holds N pieces, then number + separator prefix. It never returns a "closest"
 * file, because nesting a similar-looking but wrong drawing cuts the wrong
 * part. OCR look-alike repair (o/c -> 0, l -> 1, S -> 5 ...) is tried only when
 * the literal number matched nothing.
 */

export interface LookupFile {
  relPath: string;
}

export interface LookupResult<F extends LookupFile = LookupFile> {
  /** The matched file; absent when nothing matched. */
  file?: F;
  /** Pieces of the part the file contains (1 unless the name says `-X5`, ` x5`, `_5`, ` (5)`). */
  per: number;
  /** True when there was no folder (no files at all) to search. */
  none?: boolean;
  /** How it matched; absent with no file. */
  how?: "exact" | "multi" | "prefix";
}

export interface ResolvedItem<F extends LookupFile = LookupFile> extends LookupResult<F> {
  /** The part number actually matched (OCR repair may change it). */
  num: string;
  /** Files needed to cover `qty`: ceil(qty / per); null when qty is unknown. */
  need: number | null;
}

const DEFAULT_EXTS = /\.dxf$/i;

/** File name without folders and extension, normalised like a part number. */
function baseOf(relPath: string): string {
  const name = String(relPath ?? "").split(/[\\/]/).pop() ?? "";
  return normName(name.replace(/\.[A-Za-z0-9]{1,5}$/, ""));
}

/**
 * Looks `num` up in `files` (only `.dxf` unless `exts` says otherwise).
 * Precedence: exact name > shortest multi-piece name > shortest prefix name
 * whose next character is a space, `_` or `(`.
 */
export function lookupFile<F extends LookupFile>(num: string, files: readonly F[] | null | undefined, exts: RegExp = DEFAULT_EXTS): LookupResult<F> {
  if (!files || files.length === 0) return { per: 1, none: true };
  const key = normName(num);
  if (!key) return { per: 1 };
  let prefix: F | undefined;
  let prefixLen = Infinity;
  let multi: { f: F; per: number; len: number } | undefined;
  for (const f of files) {
    if (!exts.test(f.relPath)) continue;
    const base = baseOf(f.relPath);
    if (base === key) return { file: f, per: 1, how: "exact" };
    if (base.length > key.length && base.startsWith(key)) {
      // "<number>-X5", "<number> x5", "<number>_5", "<number> (5)": the file holds N pieces
      const rest = base.slice(key.length);
      const cm = /^[\s_-]+[([]?\s*(?:[xX×]\s*)?(\d{1,4})\s*(?:pcs|pc|ea|шт)?\s*[)\]]?$/i.exec(rest);
      if (cm && parseInt(cm[1], 10) >= 1) {
        if (!multi || base.length < multi.len) multi = { f, per: parseInt(cm[1], 10), len: base.length };
      } else if (/[ _(]/.test(base.charAt(key.length)) && base.length < prefixLen) {
        prefix = f;
        prefixLen = base.length;
      }
    }
  }
  if (multi) return { file: multi.f, per: multi.per, how: "multi" };
  if (prefix) return { file: prefix, per: 1, how: "prefix" };
  return { per: 1 };
}

/** OCR often reads digits as look-alike letters (0->o/c, 1->l, 5->S ...). Leaves anything that does not look like a damaged long number alone. */
export function ocrDigits(n: string): string {
  const s = String(n ?? "");
  if (s.length < 6 || !/^[0-9OoQDcCIlSsBZ]+$/.test(s) || (s.match(/\d/g) ?? []).length < 3) return s;
  return s.replace(/[OoQDcC]/g, "0").replace(/[Il]/g, "1").replace(/[Ss]/g, "5").replace(/B/g, "8").replace(/Z/g, "2");
}

/**
 * Resolves one BOM item: exact lookup first, OCR repair only when that finds
 * no file, then `need = ceil(qty / per)` files. Never a closest guess.
 */
export function resolveItem<F extends LookupFile>(num: string, qty: number | null, files: readonly F[] | null | undefined, exts: RegExp = DEFAULT_EXTS): ResolvedItem<F> {
  let r = lookupFile(num, files, exts);
  let used = num;
  if (!r.file && !r.none) {
    const alt = ocrDigits(num);
    if (alt !== num) {
      const r2 = lookupFile(alt, files, exts);
      if (r2.file) {
        r = r2;
        used = alt;
      }
    }
  }
  const per = r.file ? r.per : 1;
  const need = qty !== null && Number.isFinite(qty) && qty >= 0 ? Math.ceil(qty / per) : null;
  return { ...r, per, num: used, need };
}
