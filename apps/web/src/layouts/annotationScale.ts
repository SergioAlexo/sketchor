import { currentAnnotationScale, viewportAnnotationScale } from "@sketchor/core";
import { doc } from "../state/store";
import { getSpaceState } from "./layoutState";

/**
 * L-05: "the current annotation scale" depends on where the user is working: the document's scale in model space, the
 * entered viewport's own scale when editing the model through one (MSPACE). "Add current scale" uses this.
 */
export function workingAnnotationScale(): string {
  const s = getSpaceState();
  if (s.mspace) {
    const vp = doc.get(s.mspace);
    if (vp && vp.type === "viewport") return viewportAnnotationScale(vp);
  }
  return currentAnnotationScale(doc.settings);
}
