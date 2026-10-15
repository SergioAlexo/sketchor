import type { Constraint } from "./constraints";
import type { Entity } from "./entities";
import type { TableRecord } from "./tables";

/**
 * T-45: a tiny expression language for parameters and driving values
 * (`width/2 + 5`, `sqrt(a^2+b^2)`, `2in + 5mm`, `30deg`). Tokenizer + Pratt
 * parser + evaluator — never `eval`. Values are plain numbers in document
 * base units: lengths in mm, angles in radians. A unit suffix multiplies by
 * its factor, so `2in` is 50.8.
 *
 * Angle contexts (an angular dimension, an `angle` constraint) read a bare
 * number as degrees; an expression that uses a unit or a parameter is taken
 * as already being in radians.
 */

export const UNIT_FACTORS: Record<string, number> = {
  mm: 1,
  cm: 10,
  m: 1000,
  in: 25.4,
  ft: 304.8,
  deg: Math.PI / 180,
  rad: 1,
};
export const EXPR_CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };
const FUNCS: Record<string, { n: number | "any"; f: (...a: number[]) => number }> = {
  sqrt: { n: 1, f: Math.sqrt },
  abs: { n: 1, f: Math.abs },
  sin: { n: 1, f: Math.sin },
  cos: { n: 1, f: Math.cos },
  tan: { n: 1, f: Math.tan },
  asin: { n: 1, f: Math.asin },
  acos: { n: 1, f: Math.acos },
  atan: { n: 1, f: Math.atan },
  atan2: { n: 2, f: Math.atan2 },
  exp: { n: 1, f: Math.exp },
  ln: { n: 1, f: Math.log },
  log: { n: 1, f: Math.log10 },
  round: { n: 1, f: Math.round },
  floor: { n: 1, f: Math.floor },
  ceil: { n: 1, f: Math.ceil },
  pow: { n: 2, f: Math.pow },
  min: { n: "any", f: Math.min },
  max: { n: "any", f: Math.max },
  hypot: { n: "any", f: Math.hypot },
};

export type Ast =
  | { k: "num"; v: number }
  | { k: "unit"; e: Ast; f: number }
  | { k: "ref"; name: string }
  | { k: "neg"; e: Ast }
  | { k: "bin"; op: string; l: Ast; r: Ast }
  | { k: "call"; name: string; args: Ast[] };

type Tok = { t: "num" | "id" | "op" | "end"; s: string; v?: number };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) i++;
    else if (/[0-9.]/.test(c)) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+(?![a-zA-Z_]))?/.exec(src.slice(i));
      if (!m) throw new Error(`Bad number at ${i + 1}`);
      out.push({ t: "num", s: m[0], v: Number(m[0]) });
      i += m[0].length;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ t: "id", s: m[0] });
      i += m[0].length;
    } else if ("+-*/%^(),".includes(c)) {
      out.push({ t: "op", s: c });
      i++;
    } else throw new Error(`Unexpected "${c}" at ${i + 1}`);
  }
  out.push({ t: "end", s: "" });
  return out;
}

const BIN: Record<string, [number, number]> = { "+": [10, 11], "-": [10, 11], "*": [20, 21], "/": [20, 21], "%": [20, 21], "^": [41, 40] };

/** Parses `src` to a syntax tree; throws `Error` with a readable message. */
export function parseExpr(src: string): Ast {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p]!;
  const isOp = (s: string) => peek().t === "op" && peek().s === s;
  const unitSuffix = (e: Ast): Ast => {
    while (peek().t === "id" && peek().s in UNIT_FACTORS) {
      e = { k: "unit", e, f: UNIT_FACTORS[toks[p++]!.s]! };
    }
    return e;
  };
  function primary(): Ast {
    const t = toks[p++]!;
    if (t.t === "num") return unitSuffix({ k: "num", v: t.v! });
    if (t.t === "id") {
      if (isOp("(")) {
        const fn = FUNCS[t.s];
        if (!fn) throw new Error(`Unknown function "${t.s}"`);
        p++;
        const args: Ast[] = [];
        if (!isOp(")")) {
          args.push(expr(0));
          while (isOp(",")) {
            p++;
            args.push(expr(0));
          }
        }
        if (!isOp(")")) throw new Error("Missing )");
        p++;
        if (fn.n !== "any" && args.length !== fn.n) throw new Error(`${t.s}() takes ${fn.n} argument${fn.n === 1 ? "" : "s"}`);
        if (fn.n === "any" && args.length === 0) throw new Error(`${t.s}() needs arguments`);
        return { k: "call", name: t.s, args };
      }
      if (t.s in UNIT_FACTORS) throw new Error(`"${t.s}" is a unit — put it after a number`);
      return { k: "ref", name: t.s };
    }
    if (t.t === "op" && t.s === "(") {
      const e = expr(0);
      if (!isOp(")")) throw new Error("Missing )");
      p++;
      return unitSuffix(e);
    }
    if (t.t === "op" && (t.s === "-" || t.s === "+")) {
      const e = expr(30);
      return t.s === "-" ? { k: "neg", e } : e;
    }
    throw new Error(t.t === "end" ? "Unexpected end of expression" : `Unexpected "${t.s}"`);
  }
  function expr(min: number): Ast {
    let l = primary();
    for (;;) {
      const t = peek();
      const bp = t.t === "op" ? BIN[t.s] : undefined;
      if (!bp || bp[0] < min) return l;
      p++;
      l = { k: "bin", op: t.s, l, r: expr(bp[1]) };
    }
  }
  const ast = expr(0);
  if (peek().t !== "end") throw new Error(`Unexpected "${peek().s}"`);
  return ast;
}

/** The parameter names an expression reads. */
export function exprRefs(ast: Ast, out = new Set<string>()): Set<string> {
  switch (ast.k) {
    case "ref":
      if (!(ast.name in EXPR_CONSTANTS)) out.add(ast.name);
      break;
    case "unit":
    case "neg":
      exprRefs(ast.e, out);
      break;
    case "bin":
      exprRefs(ast.l, out);
      exprRefs(ast.r, out);
      break;
    case "call":
      for (const a of ast.args) exprRefs(a, out);
      break;
    default:
  }
  return out;
}

export type ParamEnv = ReadonlyMap<string, number>;
export type ExprResult = { ok: true; value: number; usesUnit: boolean } | { ok: false; error: string };

function run(ast: Ast, env: ParamEnv, flags: { unit: boolean }): number {
  switch (ast.k) {
    case "num":
      return ast.v;
    case "unit":
      flags.unit = true;
      return run(ast.e, env, flags) * ast.f;
    case "neg":
      return -run(ast.e, env, flags);
    case "ref": {
      const c = EXPR_CONSTANTS[ast.name];
      if (c !== undefined) return c;
      const v = env.get(ast.name);
      if (v === undefined) throw new Error(`Unknown parameter "${ast.name}"`);
      flags.unit = true;
      return v;
    }
    case "call":
      return FUNCS[ast.name]!.f(...ast.args.map((a) => run(a, env, flags)));
    case "bin": {
      const a = run(ast.l, env, flags);
      const b = run(ast.r, env, flags);
      switch (ast.op) {
        case "+":
          return a + b;
        case "-":
          return a - b;
        case "*":
          return a * b;
        case "/":
          if (b === 0) throw new Error("Division by zero");
          return a / b;
        case "%":
          if (b === 0) throw new Error("Division by zero");
          return a % b;
        default:
          return a ** b;
      }
    }
  }
}

/** Parses and evaluates `src` against `env`. Never throws. */
export function evaluateExpr(src: string, env: ParamEnv = new Map()): ExprResult {
  try {
    const flags = { unit: false };
    const value = run(parseExpr(src), env, flags);
    if (!Number.isFinite(value)) return { ok: false, error: "Not a finite number" };
    return { ok: true, value, usesUnit: flags.unit };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Evaluates for a value of the given kind; a bare number in an angle context is degrees. Returns mm or radians. */
export function evaluateValue(src: string, env: ParamEnv, kind: "length" | "angle"): ExprResult {
  const r = evaluateExpr(src, env);
  if (r.ok && kind === "angle" && !r.usesUnit) return { ok: true, value: (r.value * Math.PI) / 180, usesUnit: true };
  return r;
}

/* -------------------------------- params table -------------------------------- */

export const PARAMS_TABLE = "params";
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Why `name` cannot be a parameter name, or null. */
export function paramNameError(name: string): string | null {
  if (!IDENT.test(name)) return "Use letters, digits and _, not starting with a digit";
  if (name in UNIT_FACTORS || name in EXPR_CONSTANTS || name in FUNCS) return `"${name}" is reserved`;
  return null;
}

export interface ResolvedParam {
  value?: number;
  error?: string;
}

/** Evaluates every parameter in dependency order; a cycle, bad syntax or unknown name marks that parameter (and anything built on it) as an error. */
export function resolveParams(records: readonly TableRecord[]): Map<string, ResolvedParam> {
  const byName = new Map<string, TableRecord>();
  for (const r of records) if (!paramNameError(r.name)) byName.set(r.name, r);
  const out = new Map<string, ResolvedParam>();
  const visiting = new Set<string>();
  const visit = (name: string): ResolvedParam => {
    const done = out.get(name);
    if (done) return done;
    if (visiting.has(name)) return { error: "Circular reference" };
    visiting.add(name);
    const rec = byName.get(name)!;
    let res: ResolvedParam;
    try {
      const ast = parseExpr(String(rec.expression ?? ""));
      const env = new Map<string, number>();
      for (const ref of exprRefs(ast)) {
        if (!byName.has(ref)) throw new Error(`Unknown parameter "${ref}"`);
        const dep = visit(ref);
        if (dep.value === undefined) throw new Error(dep.error === "Circular reference" ? "Circular reference" : `"${ref}" has an error`);
        env.set(ref, dep.value);
      }
      const r = evaluateExpr(String(rec.expression), env);
      res = r.ok ? { value: r.value } : { error: r.error };
    } catch (err) {
      res = { error: err instanceof Error ? err.message : String(err) };
    }
    visiting.delete(name);
    out.set(name, res);
    return res;
  };
  for (const name of byName.keys()) visit(name);
  return out;
}

/** The numeric environment for expressions: every parameter that evaluates. */
export function paramEnv(records: readonly TableRecord[]): Map<string, number> {
  const env = new Map<string, number>();
  for (const [k, v] of resolveParams(records)) if (v.value !== undefined) env.set(k, v.value);
  return env;
}

/** Validates a prospective parameter against the existing ones; returns an error message or null. */
export function validateParam(records: readonly TableRecord[], name: string, expression: string): string | null {
  const nameErr = paramNameError(name);
  if (nameErr) return nameErr;
  const next = [...records.filter((r) => r.name !== name), { name, expression }];
  const res = resolveParams(next).get(name);
  return res?.error ?? null;
}

const lengthOrAngle = (e: Entity): "length" | "angle" =>
  e.type === "dimension" && (e.kind === "angular2l" || e.kind === "angular3p") ? "angle" : "length";

/**
 * Re-evaluates every dimension and constraint that carries an `expression`
 * and returns the copies whose value changed (an expression that fails keeps
 * its last value).
 */
export function refreshExpressions(
  entities: Iterable<Entity>,
  constraints: Iterable<Constraint>,
  records: readonly TableRecord[],
): { entities: Entity[]; constraints: Constraint[] } {
  const env = paramEnv(records);
  const outE: Entity[] = [];
  const outC: Constraint[] = [];
  for (const e of entities) {
    if (e.type !== "dimension" || !e.expression) continue;
    const r = evaluateValue(e.expression, env, lengthOrAngle(e));
    if (r.ok && r.value !== e.value) outE.push({ ...e, value: r.value });
  }
  for (const c of constraints) {
    if ((c.type !== "distance" && c.type !== "radius" && c.type !== "angle") || !c.expression) continue;
    const r = evaluateValue(c.expression, env, c.type === "angle" ? "angle" : "length");
    if (r.ok && r.value !== c.value) outC.push({ ...c, value: r.value });
  }
  return { entities: outE, constraints: outC };
}
