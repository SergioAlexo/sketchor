/**
 * E-03: the parse worker's body. The host page and the embed script are
 * usually on different origins, and `new Worker(url)` only accepts a
 * same-origin script, so parseClient.ts starts the worker from a tiny blob
 * that imports this chunk by its own absolute URL (`WORKER_MODULE_URL`) —
 * which works cross-origin because the embed's files are served with CORS.
 * The parser is imported inside the worker only, so the page fetching this
 * chunk for its URL doesn't download the parser too.
 */
import type { PreviewFormat } from "./load";
import type { UpAxis } from "./three/upAxis";

export const WORKER_MODULE_URL: string = import.meta.url;

export interface ParseRequest {
  id: number;
  bytes: Uint8Array;
  name: string;
  format: PreviewFormat;
  up: UpAxis | "auto";
}

export function startParseWorker(): void {
  const scope = self as unknown as { onmessage: ((e: MessageEvent<ParseRequest>) => void) | null; postMessage(msg: unknown, transfer?: Transferable[]): void };
  scope.onmessage = async (e) => {
    const { id, bytes, name, format, up } = e.data;
    try {
      const { parseModel, transferablesOf } = await import("./parse");
      const model = await parseModel(bytes, name, format, up);
      scope.postMessage({ id, model }, transferablesOf(model));
    } catch (err) {
      scope.postMessage({ id, error: (err as Error)?.message ?? String(err) });
    }
  };
  scope.postMessage({ ready: true });
}
