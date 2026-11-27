import {
  CapabilityError,
  type Command,
  type CommandContribution,
  type GeneratorContribution,
  type IoContribution,
  type PluginContributions,
  type PluginManifest,
} from "@sketchor/core";
import type { EntityId } from "@sketchor/core";
import { bus, useApp } from "../../state/store";
import { assertCommands } from "./hostMethods";
import type { PluginHost } from "./PluginHost";

/**
 * The host's contribution registries. Where Phase 1 could run a single hardcoded
 * plugin, this is where the host *registers and routes* what plugins contribute:
 * each running plugin's `contributes` block is unpacked into these registries,
 * and the UI (command palette, menu, save/export list) reads them to show and
 * run plugin features. Every route back into a plugin goes through
 * {@link PluginHost.invoke}; every returned command is validated and applied
 * under the same capability gate as any other plugin mutation — a generator or
 * importer from a plugin without `write-document` is refused here, not trusted.
 */

interface Registered<C> {
  readonly pluginId: string;
  readonly host: PluginHost;
  readonly contribution: C;
}

const commands = new Map<string, Registered<CommandContribution>>();
const generators = new Map<string, Registered<GeneratorContribution>>();
const exporters = new Map<string, Registered<IoContribution>>();
const importers = new Map<string, Registered<IoContribution>>();

/** A change bus so the UI can re-render its lists when plugins load/unload. */
const listeners = new Set<() => void>();
export function onRegistriesChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function emitChange(): void {
  for (const l of listeners) l();
}

/** Unpacks a loaded plugin's `contributes` into the registries. */
export function registerContributions(host: PluginHost, manifest: PluginManifest): void {
  const c: PluginContributions = manifest.contributes ?? {};
  const entry = <T>(contribution: T): Registered<T> => ({ pluginId: manifest.id, host, contribution });

  for (const cmd of c.commands ?? []) commands.set(cmd.id, entry(cmd));
  for (const gen of c.generators ?? []) generators.set(gen.id, entry(gen));
  for (const io of c.io ?? []) {
    if (io.direction.includes("export")) exporters.set(io.id, entry(io));
    if (io.direction.includes("import")) importers.set(io.id, entry(io));
  }
  emitChange();
}

/** Removes everything a plugin contributed (on unload/uninstall). */
export function unregisterContributions(pluginId: string): void {
  for (const map of [commands, generators, exporters, importers]) {
    for (const [id, reg] of map) if (reg.pluginId === pluginId) map.delete(id);
  }
  emitChange();
}

// --- listing (for the UI) ---

export interface CommandListItem {
  id: string;
  pluginId: string;
  title: string;
  icon?: string;
  kind: "command" | "generator";
}

/** Runnable palette/menu entries: contributed commands and generators together. */
export function listActions(): CommandListItem[] {
  const out: CommandListItem[] = [];
  for (const [id, reg] of commands) {
    out.push({ id, pluginId: reg.pluginId, title: reg.contribution.title, icon: reg.contribution.icon, kind: "command" });
  }
  for (const [id, reg] of generators) {
    out.push({ id, pluginId: reg.pluginId, title: reg.contribution.title, icon: reg.contribution.icon, kind: "generator" });
  }
  return out;
}

export function listExporters(): IoContribution[] {
  return [...exporters.values()].map((r) => r.contribution);
}

export function listImporters(): IoContribution[] {
  return [...importers.values()].map((r) => r.contribution);
}

// --- invocation ---

/** Runs a contributed command. Its own API calls are capability-gated inside the sandbox. */
export async function runCommand(id: string, input?: unknown): Promise<void> {
  const reg = commands.get(id);
  if (!reg) throw new Error(`No such command "${id}"`);
  await reg.host.invoke("command", id, input);
}

/**
 * Runs a contributed generator over the current selection and applies its
 * commands as one undo step, then selects the newly added entities — the same
 * behaviour as the built-in {@link applyPattern}. Requires `write-document`.
 * Returns the number of entities added.
 */
export async function runGenerator(id: string, input?: unknown): Promise<number> {
  const reg = generators.get(id);
  if (!reg) throw new Error(`No such generator "${id}"`);
  if (!reg.host.has("write-document")) throw new CapabilityError("write-document");

  const result = await reg.host.invoke("generator", id, input);
  return applyGenerated(result);
}

/**
 * Runs a generator but returns its validated commands *without applying them* —
 * used by the Phase 2 acceptance check to compare plugin output against the
 * built-in geometry. Still requires `write-document` (the commands would mutate).
 */
export async function previewGenerator(id: string, input?: unknown): Promise<Command[]> {
  const reg = generators.get(id);
  if (!reg) throw new Error(`No such generator "${id}"`);
  if (!reg.host.has("write-document")) throw new CapabilityError("write-document");
  const result = await reg.host.invoke("generator", id, input);
  assertCommands(result);
  return result;
}

/** Runs a contributed exporter and returns the serialized text. */
export async function runExporter(id: string): Promise<string> {
  const reg = exporters.get(id);
  if (!reg) throw new Error(`No such exporter "${id}"`);
  const text = await reg.host.invoke("exporter", id);
  if (typeof text !== "string") throw new Error(`Exporter "${id}" must return a string`);
  return text;
}

/** Runs a contributed importer over file text and applies its commands as one undo step. */
export async function runImporter(id: string, text: string): Promise<number> {
  const reg = importers.get(id);
  if (!reg) throw new Error(`No such importer "${id}"`);
  if (!reg.host.has("write-document")) throw new CapabilityError("write-document");

  const result = await reg.host.invoke("importer", id, text);
  return applyGenerated(result);
}

/** Validates and applies plugin-returned commands as a batch; returns the added entity ids' count. */
function applyGenerated(result: unknown): number {
  assertCommands(result);
  if (result.length === 0) return 0;

  bus.execute({ type: "batch", commands: result });
  const added = result
    .map((c) => (c.type === "add-entity" ? c.entity.id : null))
    .filter((id): id is EntityId => id !== null);
  if (added.length > 0) {
    const { selection, setSelection } = useApp.getState();
    setSelection([...selection, ...added]);
  }
  return added.length;
}
