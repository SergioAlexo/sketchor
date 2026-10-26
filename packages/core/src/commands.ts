import type { Entity, EntityId } from "./entities";
import { transformed, translated } from "./entities";
import type { GroupId } from "./groups";
import type { Constraint, ConstraintId } from "./constraints";
import { associationState, reassociate } from "./hatch/associate";
import { solveSketch, type SolveOptions, type SolveResult } from "./solver/solve";
import type { Point } from "./geometry";
import type { SketchDocument } from "./document";
import { setActiveBlocks } from "./blocks/context";
import { setActiveDimHost } from "./dimensions/context";
import { planDefineBlock, planDeleteBlock, planExplode, planRenameBlock, planUpdateBlock } from "./blocks/ops";
import type { AttributeDef, BlockDefinition } from "./blocks/types";
import { PARAMS_TABLE, refreshExpressions, validateParam } from "./expr";
import { entityRefRewritersFor, recordRefRewritersFor, type DocSettings, type TableRecord } from "./tables";

/**
 * Every mutation of the document is a plain-data command.
 *
 * This is the seam where future integrations plug in: an AI assistant,
 * a parametric constraint solver, or a collaboration layer all just
 * produce Command values — they never touch the document directly.
 */
export type Command =
  | { type: "add-entity"; entity: Entity }
  | { type: "delete-entities"; ids: EntityId[] }
  | { type: "move-entities"; ids: EntityId[]; dx: number; dy: number }
  | { type: "update-entity"; entity: Entity }
  | {
      type: "transform-entities";
      ids: EntityId[];
      pivot: Point;
      dx?: number;
      dy?: number;
      rotation?: number;
      scale?: number;
    }
  | { type: "group-entities"; groupId: GroupId; ids: (EntityId | GroupId)[]; name?: string; parent?: GroupId }
  | { type: "ungroup"; groupId: GroupId }
  | { type: "add-constraint"; constraint: Constraint }
  | { type: "remove-constraint"; id: ConstraintId }
  /** Inserts or replaces the record of that name. `index` places a new record (used to undo a delete in its old position). */
  | { type: "put-table-record"; table: string; record: TableRecord; index?: number }
  | { type: "delete-table-record"; table: string; name: string }
  /**
   * Renames a record and (unless `rewrite` is false) every entity and record
   * that refers to it — one command, one undo step. A no-op if `from` is
   * missing or `to` is taken.
   */
  | { type: "rename-table-record"; table: string; from: string; to: string; rewrite?: boolean }
  /** Merges into the document settings; a key set to `null` (or `undefined`) is removed. */
  | { type: "set-settings"; patch: DocSettings }
  /**
   * B-02. AutoCAD's "convert to block": the selected entities become the body of a new
   * `blocks` record (coordinates unchanged, anchored at `basePoint`). `convert` (default)
   * removes them and adds one insert (`insertId`) at the base point; `retain` keeps them
   * and adds no insert; `delete` removes them and adds no insert. Refused when the name is
   * empty or taken, nothing is selected, or the body would contain the block itself.
   */
  | {
      type: "define-block";
      name: string;
      basePoint: Point;
      ids: EntityId[];
      insertId: EntityId;
      mode?: "convert" | "retain" | "delete";
      description?: string;
      explodable?: boolean;
      scaleUniformly?: boolean;
      attributeDefs?: AttributeDef[];
    }
  /** B-02. Replaces the given fields of a definition (usually `entities`) — every instance re-renders. Refused if it would make the block contain itself. */
  | { type: "update-block"; name: string; changes: Partial<Omit<BlockDefinition, "name">> }
  /** B-02. Renames a block and every insert (and nested insert) that names it, in one step. */
  | { type: "rename-block"; from: string; to: string }
  /** B-02. Refused while any insert or other definition references the block, unless `purge` (which removes those references too). */
  | { type: "delete-block"; name: string; purge?: boolean }
  /** B-02. Replaces an insert with the entities it stands for (one nesting level; attribute values become text). Refused for a non-explodable block. */
  | { type: "explode-insert"; id: EntityId }
  /** T-45: define or redefine a named parameter (`expression` may reference other parameters); dimensions and constraints with an `expression` follow. */
  | { type: "put-param"; name: string; expression: string; comment?: string }
  | { type: "delete-param"; name: string }
  | { type: "batch"; commands: Command[] };

interface HistoryEntry {
  command: Command;
  inverse: Command[];
}

export class CommandBus {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private listeners = new Set<() => void>();
  private solving = false;
  /**
   * What the solver said after the most recent command — degrees of
   * freedom, conflicts, redundancy. Null while the document has no
   * constraints, which is every drawing until someone adds one.
   */
  lastSolve: SolveResult | null = null;
  /**
   * View-only guard: while set, execute/undo/redo do nothing and `onBlocked`
   * is called instead, so a stray key or drag can't edit the drawing. Every
   * producer (tools, code panel, plugins) goes through the bus, so this is
   * the one place that has to know.
   */
  locked = false;
  onBlocked: (() => void) | null = null;

  constructor(readonly doc: SketchDocument) {
    setActiveBlocks(doc);
    setActiveDimHost(doc);
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Tells listeners the document changed outside a command (the block editor's live preview writes the definition directly). */
  notify(): void {
    setActiveBlocks(this.doc);
    setActiveDimHost(this.doc);
    this.emit();
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  execute(command: Command): void {
    if (this.locked) return this.onBlocked?.();
    setActiveBlocks(this.doc);
    setActiveDimHost(this.doc);
    const assoc = associationState(this.doc);
    const inverse = this.apply(command);
    // The solver runs as a middleware here (roadmap T-40): whatever the
    // command did, the constraints then have their say, and the moves
    // they cause join the *same* undo entry. Anything else would make
    // Ctrl+Z leave a sketch that satisfies nothing.
    this.undoStack.push({ command, inverse: [...this.afterApply(assoc), ...inverse] });
    this.redoStack = [];
    this.emit();
  }

  /** T-45: after a parameter changed, pushes the new values into every dimension / constraint that has an expression. */
  private refreshParams(inverse: Command[]): Command[] {
    const doc = this.doc;
    const changed = refreshExpressions(doc.all(), doc.constraints(), doc.records(PARAMS_TABLE));
    for (const entity of changed.entities) inverse.unshift(...this.apply({ type: "update-entity", entity }));
    for (const constraint of changed.constraints) {
      const previous = doc.getConstraint(constraint.id);
      doc._putConstraint(constraint);
      if (previous) inverse.unshift({ type: "add-constraint", constraint: previous });
    }
    return inverse;
  }

  /** Middleware after a command: the solver, then H-05 associative hatches following their boundary. Returns the inverse commands. */
  private afterApply(assoc: ReturnType<typeof associationState>): Command[] {
    const solved = this.solveAfterCommand();
    const followed: Command[] = [];
    for (const entity of reassociate(this.doc, assoc)) followed.unshift(...this.apply({ type: "update-entity", entity }));
    return [...followed, ...solved];
  }

  /**
   * Re-solves the sketch and applies what moved, returning the inverse
   * commands. No constraints, no work — and never while undoing or
   * redoing, where the recorded geometry is already solved.
   */
  private solveAfterCommand(): Command[] {
    const constraints = this.doc.solverConstraints();
    if (this.solving || constraints.length === 0) {
      if (constraints.length === 0) this.lastSolve = null;
      return [];
    }
    this.solving = true;
    try {
      const result = solveSketch(this.doc.all(), constraints);
      this.lastSolve = result;
      const inverse: Command[] = [];
      for (const entity of result.updates) {
        inverse.unshift(...this.apply({ type: "update-entity", entity }));
      }
      return inverse;
    } finally {
      this.solving = false;
    }
  }

  /**
   * Solves without recording history — for a live drag, where the moves
   * are previewed every frame and only the final position is committed.
   */
  solveSilently(options?: SolveOptions): SolveResult | null {
    const constraints = this.doc.solverConstraints();
    if (constraints.length === 0) return null;
    return solveSketch(this.doc.all(), constraints, options);
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): void {
    if (this.locked) return this.onBlocked?.();
    setActiveBlocks(this.doc);
    setActiveDimHost(this.doc);
    const entry = this.undoStack.pop();
    if (!entry) return;
    for (const inv of entry.inverse) this.apply(inv);
    // Undo restores geometry that was already solved, so nothing needs
    // moving — but the *verdict* has to be re-read, or the status bar goes
    // on warning about a conflict the user has just undone.
    this.refreshDiagnosis();
    this.redoStack.push(entry);
    this.emit();
  }

  /** Re-reads the solver's verdict for the current document without moving anything. */
  private refreshDiagnosis(): void {
    const constraints = this.doc.solverConstraints();
    this.lastSolve = constraints.length === 0 ? null : solveSketch(this.doc.all(), constraints, { maxIterations: 0 });
  }

  redo(): void {
    if (this.locked) return this.onBlocked?.();
    setActiveBlocks(this.doc);
    setActiveDimHost(this.doc);
    const entry = this.redoStack.pop();
    if (!entry) return;
    // Redo re-solves for the same reason execute does: the command alone
    // doesn't describe where the constraints then put the geometry.
    const assoc = associationState(this.doc);
    const inverse = this.apply(entry.command);
    entry.inverse = [...this.afterApply(assoc), ...inverse];
    this.undoStack.push(entry);
    this.emit();
  }

  /** Applies a command and returns the commands that revert it. */
  private apply(command: Command): Command[] {
    const doc = this.doc;
    switch (command.type) {
      case "add-entity": {
        doc._put(command.entity);
        return [{ type: "delete-entities", ids: [command.entity.id] }];
      }
      case "delete-entities": {
        const inverse: Command[] = [];
        for (const id of command.ids) {
          const existing = doc.get(id);
          if (existing) {
            inverse.push({ type: "add-entity", entity: existing });
            doc._remove(id);
          }
        }
        return inverse;
      }
      case "move-entities": {
        for (const id of command.ids) {
          const existing = doc.get(id);
          if (existing) doc._put(translated(existing, command.dx, command.dy));
        }
        return [
          {
            type: "move-entities",
            ids: command.ids,
            dx: -command.dx,
            dy: -command.dy,
          },
        ];
      }
      case "update-entity": {
        const previous = doc.get(command.entity.id);
        doc._put(command.entity);
        return previous
          ? [{ type: "update-entity", entity: previous }]
          : [{ type: "delete-entities", ids: [command.entity.id] }];
      }
      case "transform-entities": {
        const inverse: Command[] = [];
        for (const id of command.ids) {
          const existing = doc.get(id);
          if (!existing) continue;
          inverse.push({ type: "update-entity", entity: existing });
          doc._put(
            transformed(
              existing,
              command.pivot,
              command.dx ?? 0,
              command.dy ?? 0,
              command.rotation ?? 0,
              command.scale ?? 1,
            ),
          );
        }
        return inverse;
      }
      case "group-entities": {
        doc._putGroup({
          id: command.groupId,
          name: command.name ?? command.groupId,
          members: command.ids,
          ...(command.parent ? { parent: command.parent } : {}),
        });
        return [{ type: "ungroup", groupId: command.groupId }];
      }
      case "ungroup": {
        const group = doc.getGroup(command.groupId);
        if (!group) return [];
        doc._removeGroup(command.groupId);
        return [
          {
            type: "group-entities",
            groupId: group.id,
            ids: group.members,
            name: group.name,
            ...(group.parent ? { parent: group.parent } : {}),
          },
        ];
      }
      case "add-constraint": {
        doc._putConstraint(command.constraint);
        return [{ type: "remove-constraint", id: command.constraint.id }];
      }
      case "remove-constraint": {
        const existing = doc.getConstraint(command.id);
        if (!existing) return [];
        doc._removeConstraint(command.id);
        return [{ type: "add-constraint", constraint: existing }];
      }
      case "put-table-record": {
        const previous = doc.getRecord(command.table, command.record.name);
        doc._putRecord(command.table, command.record, command.index);
        return [
          previous
            ? { type: "put-table-record", table: command.table, record: previous }
            : { type: "delete-table-record", table: command.table, name: command.record.name },
        ];
      }
      case "delete-table-record": {
        const previous = doc.getRecord(command.table, command.name);
        if (!previous) return [];
        const index = doc.records(command.table).findIndex((r) => r.name === command.name);
        doc._removeRecord(command.table, command.name);
        return [{ type: "put-table-record", table: command.table, record: previous, index }];
      }
      case "put-param": {
        if (validateParam(doc.records(PARAMS_TABLE), command.name, command.expression) !== null) return [];
        const record: TableRecord = { name: command.name, expression: command.expression };
        if (command.comment) record.comment = command.comment;
        return this.refreshParams(this.apply({ type: "put-table-record", table: PARAMS_TABLE, record }));
      }
      case "delete-param":
        return this.refreshParams(this.apply({ type: "delete-table-record", table: PARAMS_TABLE, name: command.name }));
      case "rename-table-record": {
        const { table, from, to } = command;
        if (from === to || to === "" || !doc.hasRecord(table, from) || doc.hasRecord(table, to)) return [];
        doc._renameRecord(table, from, to);
        // Undo renames back *without* rewriting (rewriting again could catch
        // entities that already used the old name for another reason), then
        // puts every rewritten entity and record back exactly as it was.
        const inverse: Command[] = [{ type: "rename-table-record", table, from: to, to: from, rewrite: false }];
        if (command.rewrite !== false) {
          for (const rewrite of entityRefRewritersFor(table)) {
            for (const entity of doc.all()) {
              const next = rewrite(entity, from, to);
              if (!next) continue;
              inverse.push({ type: "update-entity", entity });
              doc._put(next);
            }
          }
          for (const { owner, fn } of recordRefRewritersFor(table)) {
            for (const record of doc.records(owner)) {
              const next = fn(record, from, to);
              if (!next) continue;
              inverse.push({ type: "put-table-record", table: owner, record });
              doc._putRecord(owner, next);
            }
          }
        }
        return inverse;
      }
      case "set-settings": {
        const before = doc.settings;
        const undo: DocSettings = {};
        for (const key of Object.keys(command.patch)) undo[key] = before[key] ?? null; // absent → null → removed (survives JSON)
        doc._patchSettings(command.patch);
        return [{ type: "set-settings", patch: undo }];
      }
      case "define-block":
      case "update-block":
      case "rename-block":
      case "delete-block":
      case "explode-insert": {
        const plan =
          command.type === "define-block"
            ? planDefineBlock(doc, command)
            : command.type === "update-block"
              ? planUpdateBlock(doc, command)
              : command.type === "rename-block"
                ? planRenameBlock(doc, command.from, command.to)
                : command.type === "delete-block"
                  ? planDeleteBlock(doc, command)
                  : planExplode(doc, command.id);
        return plan ? this.apply({ type: "batch", commands: plan }) : [];
      }
      case "batch": {
        const inverse: Command[] = [];
        for (const child of command.commands) {
          inverse.unshift(...this.apply(child));
        }
        return inverse;
      }
    }
  }
}
