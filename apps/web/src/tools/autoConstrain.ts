import { inferConstraints, type Command, type Entity, type SketchDocument } from "@sketchor/core";
import { useApp, type ToolId } from "../state/store";

/** Tools whose new geometry may carry inferred constraints (copies, mirrors, offsets and imports must not). */
const DRAWING_TOOLS: ReadonlySet<ToolId> = new Set<ToolId>(["line", "polyline", "rectangle", "circle", "arc", "ellipse", "polygon", "slot", "point"]);

/** T-46: Mirror, Offset and Fillet leave constraints behind only in Sketch mode. */
export function associativeOn(): boolean {
  return useApp.getState().drawingMode === "sketch";
}

/** Set by the viewport from the last pick: Ctrl suppresses inference for one click. */
export const autoConstrainSuppressed = { value: false };

function addedEntities(command: Command, out: Entity[]): void {
  if (command.type === "add-entity") out.push(command.entity);
  else if (command.type === "batch") for (const c of command.commands) addedEntities(c, out);
}

/**
 * T-43. When AUTOCON is on and a drawing tool is committing, appends the
 * constraints its snaps implied to the same command (one undo step).
 */
export function withAutoConstraints(command: Command, doc: SketchDocument): Command {
  const app = useApp.getState();
  if (!app.autoConstrain || autoConstrainSuppressed.value || !DRAWING_TOOLS.has(app.tool)) return command;
  const added: Entity[] = [];
  addedEntities(command, added);
  if (added.length === 0) return command;
  const constraints = inferConstraints(added, doc.all());
  if (constraints.length === 0) return command;
  const extra: Command[] = constraints.map((constraint) => ({ type: "add-constraint", constraint }));
  return { type: "batch", commands: [command, ...extra] };
}
