/**
 * E-03: the parse worker's body. The host page and the embed script are
 * usually on different origins, and `new Worker(url)` only accepts a
 * same-origin script, so parseClient.ts starts the worker from a tiny blob
 * that imports this chunk by its own absolute URL (`WORKER_MODULE_URL`) —
 * which works cross-origin because the embed's files are served with CORS.
 * The parser is imported inside the worker only, so the page fetching this
 * chunk for its URL doesn't download the parser too.
 */
import type { DrawingFormat, PreviewFormat } from "./load";
import type { UpAxis } from "./three/upAxis";

export const WORKER_MODULE_URL: string = import.meta.url;

export type ParseRequest =
  | { id: number; kind: "mesh"; bytes: Uint8Array; name: string; format: PreviewFormat; up: UpAxis | "auto" }
  | { id: number; kind: "drawing"; bytes: Uint8Array; name: string; format: DrawingFormat };

export function startParseWorker(): void {
  const scope = self as unknown as { onmessage: ((e: MessageEvent<ParseRequest>) => void) | null; postMessage(msg: unknown, transfer?: Transferable[]): void };
  scope.onmessage = async (e) => {
    const req = e.data;
    const id = req.id;
    try {
      if (req.kind === "drawing") {
        const { parseDrawing } = await import("./parse2d");
        scope.postMessage({ id, drawing: await parseDrawing(req.bytes, req.name, req.format) });
        return;
      }
      const { parseModel, transferablesOf } = await import("./parse");
      const model = await parseModel(req.bytes, req.name, req.format, req.up);
      scope.postMessage({ id, model }, transferablesOf(model));
    } catch (err) {
      scope.postMessage({ id, error: (err as Error)?.message ?? String(err) });
    }
  };
  scope.postMessage({ ready: true });
}
