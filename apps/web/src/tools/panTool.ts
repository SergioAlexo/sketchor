import type { Tool } from "./tool";

/**
 * The pan tool (roadmap T-00): the primary button drags the view, exactly
 * like the middle/right button does from any tool. The drag itself is the
 * viewport's pan gesture (it must also keep a half-drawn entity); this
 * class only claims the button via `panDrag`.
 */
export class PanTool implements Tool {
  id = "pan" as const;
  panDrag = true;
  noTyped = true;
  prompt() {
    return "";
  }
  busy() {
    return false;
  }
  anchor() {
    return null;
  }
  cancel() {}
  pick() {}
  preview() {
    return [];
  }
}
