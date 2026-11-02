/**
 * B-05 fields: `{{name}}` placeholders in attribute text, evaluated at render
 * time so a title block shows the current file name, date, sheet number...
 * The context is app-wide state (the file name belongs to the tab, not to the
 * document); bumping {@link fieldRevision} invalidates cached evaluations.
 */
export interface FieldContext {
  filename?: string;
  /** ISO yyyy-mm-dd; defaults to today. */
  date?: string;
  layout?: string;
  sheet?: number;
  sheets?: number;
  scale?: string;
  /** Named parameters (T-45) by name, for `{{param:width}}`. */
  params?: Record<string, number>;
  /** Sheet-set attributes (L-04: project, client, drawnby, title...), by lower-case name, for `{{project}}` etc. */
  custom?: Record<string, string>;
}

let context: FieldContext = {};
/** L-04: a per-evaluation context (the layout an insert is on), layered over the app-wide one by {@link withFieldContext}. */
let override: FieldContext | null = null;
let revision = 0;

export function setFieldContext(patch: FieldContext): void {
  const next = { ...context, ...patch };
  if (JSON.stringify(next) === JSON.stringify(context)) return;
  context = next;
  revision += 1;
}

export function getFieldContext(): FieldContext {
  return override ?? context;
}

/** Runs `fn` with `patch` layered over the app-wide context (fields in paper-space title blocks are per layout). */
export function withFieldContext<T>(patch: FieldContext, fn: () => T): T {
  const prev = override;
  override = { ...context, ...patch };
  try {
    return fn();
  } finally {
    override = prev;
  }
}

/** Changes whenever the context does — part of the key of cached insert evaluations. */
export function fieldRevision(): number {
  return revision;
}

export const FIELD_NAMES = ["filename", "date", "layout", "sheet", "sheets", "scale"] as const;

function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Replaces `{{field}}` (case-insensitive); an unknown or unset field is left as written so the author sees the typo. */
export function expandFields(text: string, ctx: FieldContext = override ?? context): string {
  if (!text.includes("{{")) return text;
  return text.replace(/\{\{\s*([A-Za-z_][\w]*(?::[A-Za-z_]\w*)?)\s*\}\}/g, (whole, raw: string) => {
    const colon = raw.indexOf(":");
    if (colon > 0 && raw.slice(0, colon).toLowerCase() === "param") {
      const v = ctx.params?.[raw.slice(colon + 1)];
      return v === undefined ? whole : String(Math.round(v * 1e6) / 1e6);
    }
    switch (raw.toLowerCase()) {
      case "filename":
        return ctx.filename ?? whole;
      case "date":
        return ctx.date ?? today();
      case "layout":
        return ctx.layout ?? "Model";
      case "sheet":
        return String(ctx.sheet ?? 1);
      case "sheets":
        return String(ctx.sheets ?? 1);
      case "scale":
        return ctx.scale ?? "1:1";
      default:
        return ctx.custom?.[raw.toLowerCase()] ?? whole;
    }
  });
}
