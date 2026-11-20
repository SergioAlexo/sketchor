/**
 * Public types of `@sketchor/embed` — the element's API is the semver
 * contract (E-08). `src/publicTypes.check.ts` fails the build if the real
 * module stops matching these declarations.
 */

export type PreviewFormat = "stl" | "obj" | "ply" | "3mf" | "gltf" | "glb";

export type FormatVerdict = { kind: "preview"; format: PreviewFormat } | { kind: "app-only"; ext: string } | { kind: "unknown" };

export interface SketchorViewLoadDetail {
  name: string;
  /** Number of parts (meshes / bodies) in the model. */
  parts: number;
  /** True when the parsed model came from the IndexedDB cache. */
  cached: boolean;
}

export interface SketchorViewErrorDetail {
  message: string;
}

export type SketchorViewEventMap = Omit<HTMLElementEventMap, "load" | "error"> & {
  load: CustomEvent<SketchorViewLoadDetail>;
  error: CustomEvent<SketchorViewErrorDetail>;
  play: Event;
  pause: Event;
};

/**
 * `<sketchor-view src="part.glb" autoplay>` — an animated, orbitable preview
 * of a CAD file. Attributes: `src`, `format`, `autoplay`, `motion`, `theme`,
 * `background`, `controls`, `full-url`, `logo`, `up`, `max-size`, `loading`,
 * `label`, `cache`.
 */
export declare class SketchorView extends HTMLElement {
  play(): void;
  pause(): void;
  reset(): void;
  fit(): void;
  /** Loads a different file without touching the `src` attribute. */
  load(source: string | Blob | ArrayBuffer | Uint8Array, name?: string): Promise<void>;
  addEventListener<K extends keyof SketchorViewEventMap>(
    type: K,
    listener: (this: SketchorView, ev: SketchorViewEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
}

export declare const PREVIEW_FORMATS: readonly PreviewFormat[];
export declare function sniffFormat(name: string, bytes: Uint8Array | null, override?: string | null): FormatVerdict;
export declare function resolveFullUrl(attr: string | null, absoluteSrc: string | null): string | null;
export declare function fileNameFromSrc(src: string): string;

/** Replaces `<a data-sketchor>` links and `<img data-sketchor-src>` images under `root` with previews; returns how many. */
export declare function upgrade(root?: ParentNode): number;
/** Upgrades the page now and anything added later. */
export declare function autoUpgrade(): void;
export declare function upgradePlan(el: {
  tag: string;
  attrs: Record<string, string>;
  href?: string;
  text?: string;
}): { src: string; attrs: Record<string, string> } | null;

declare global {
  interface HTMLElementTagNameMap {
    "sketchor-view": SketchorView;
  }
}
