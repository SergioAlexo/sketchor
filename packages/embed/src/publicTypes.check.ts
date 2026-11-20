/**
 * Compile-time only (never imported, so never bundled): fails `tsc` — and so
 * `npm run build` — when the real module no longer satisfies the published
 * declarations in types/sketchor-embed.d.ts. A site typed against those
 * declarations must never call something the shipped code doesn't have.
 */
import type * as Published from "../types/sketchor-embed";
import type * as Real from "./index";

type Assert<T extends true> = T;
type Satisfies<A, B> = A extends B ? true : false;

export type CheckClass = Assert<Satisfies<InstanceType<typeof Real.SketchorView>, Omit<Published.SketchorView, "addEventListener">>>;
export type CheckSniff = Assert<Satisfies<typeof Real.sniffFormat, typeof Published.sniffFormat>>;
export type CheckFullUrl = Assert<Satisfies<typeof Real.resolveFullUrl, typeof Published.resolveFullUrl>>;
export type CheckName = Assert<Satisfies<typeof Real.fileNameFromSrc, typeof Published.fileNameFromSrc>>;
export type CheckFormats = Assert<Satisfies<typeof Real.PREVIEW_FORMATS, typeof Published.PREVIEW_FORMATS>>;
export type CheckUpgrade = Assert<Satisfies<typeof Real.upgrade, typeof Published.upgrade>>;
export type CheckAuto = Assert<Satisfies<typeof Real.autoUpgrade, typeof Published.autoUpgrade>>;
export type CheckPlan = Assert<Satisfies<typeof Real.upgradePlan, typeof Published.upgradePlan>>;
export type CheckVerdict = Assert<Satisfies<Real.FormatVerdict, Published.FormatVerdict>>;
