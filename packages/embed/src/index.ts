/**
 * @sketchor/embed — `<sketchor-view>`, a drop-in animated preview of CAD
 * files drawn by Sketchor's own renderer.
 *
 *   <script type="module" src="/sketchor-embed/sketchor-embed.js"></script>
 *   <sketchor-view src="/models/bracket.glb" autoplay></sketchor-view>
 *
 * Add `data-auto` to the script tag to upgrade `<a data-sketchor>` links and
 * `<img data-sketchor-src>` images on the page (E-02 auto-upgrade).
 */
import { autoUpgrade, pageWantsAutoUpgrade } from "./autoUpgrade";
import { SketchorView } from "./element";

if (typeof customElements !== "undefined" && !customElements.get("sketchor-view")) {
  customElements.define("sketchor-view", SketchorView);
  if (pageWantsAutoUpgrade()) autoUpgrade();
}

export { SketchorView };
export { sniffFormat, resolveFullUrl, fileNameFromSrc, PREVIEW_FORMATS } from "./load";
export type { PreviewFormat, FormatVerdict } from "./load";
export { upgrade, autoUpgrade, upgradePlan } from "./autoUpgrade";
