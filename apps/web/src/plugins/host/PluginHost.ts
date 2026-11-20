import type { ContributionKind } from "@sketchor/plugin-sdk";
import type { GrantedCapabilities, Permission } from "@sketchor/core";
import { hasCapability } from "@sketchor/core";
import type { HostToWorker, WorkerToHost } from "../rpc/protocol";
import { serializeError } from "../rpc/protocol";
import { assertCapability } from "./capabilityGuard";
import { clearPluginHighlight, dispatchCall, dispatchPost, dispatchSubscribe, type HostContext } from "./hostMethods";

export interface PluginHostOptions {
  /** Manifest id; namespaces storage and identifies the plugin. */
  pluginId: string;
  /** An in-repo builtin the worker should load (first-party). */
  builtinId?: string;
  /** A verified third-party bundle's JS source, loaded in the worker instead of a builtin. */
  source?: string;
  /** Permissions the user granted this plugin. */
  granted: GrantedCapabilities;
}

/**
 * Owns one plugin's worker sandbox on the main thread. Every message from the
 * worker passes through {@link assertCapability} here before it can reach a
 * host method, so a plugin can only do what it was granted — the capability
 * check is not optional and not in the worker's control.
 */
export class PluginHost {
  private readonly worker: Worker;
  private readonly ctx: HostContext;
  private readonly granted: GrantedCapabilities;
  private readonly subs = new Map<number, () => void>();
  private readonly invokes = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  private nextInvokeId = 1;
  private ready = false;
  private activation?: { resolve: () => void; reject: (e: unknown) => void };
  private disposed = false;

  constructor(private readonly opts: PluginHostOptions) {
    this.ctx = { pluginId: opts.pluginId };
    this.granted = opts.granted;
    // Options must be a static object literal — Vite parses them at build time.
    this.worker = new Worker(new URL("../sandbox/worker.ts", import.meta.url), { type: "module" });
    this.worker.addEventListener("message", (e) => void this.onMessage(e.data as WorkerToHost));
    this.worker.addEventListener("error", (e) => this.activation?.reject(new Error(e.message)));
  }

  /** Loads and activates the plugin; resolves once its `activate` returns. */
  load(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.activation = { resolve, reject };
      if (this.ready) this.sendInit();
    });
  }

  /** Whether the user granted this plugin a given permission. */
  has(permission: Permission): boolean {
    return hasCapability(this.granted, permission);
  }

  /**
   * Runs one of the plugin's registered contribution handlers in its worker and
   * resolves with the plain-data result (a generator/importer returns
   * `Command[]`; an exporter a string; a command `undefined`). The caller is
   * responsible for applying any returned commands through the capability gate.
   */
  invoke(contribution: ContributionKind, contributionId: string, input?: unknown): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error("plugin host disposed"));
    const id = this.nextInvokeId++;
    return new Promise((resolve, reject) => {
      this.invokes.set(id, { resolve, reject });
      this.post({ kind: "invoke", id, contribution, contributionId, input });
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const unsub of this.subs.values()) unsub();
    this.subs.clear();
    for (const pending of this.invokes.values()) pending.reject(new Error("plugin host disposed"));
    this.invokes.clear();
    clearPluginHighlight(this.opts.pluginId);
    this.post({ kind: "deactivate" });
    // Give `deactivate` a moment to run before killing the worker.
    setTimeout(() => this.worker.terminate(), 500);
  }

  private sendInit(): void {
    this.post({
      kind: "init",
      pluginId: this.opts.pluginId,
      ...(this.opts.source !== undefined ? { source: this.opts.source } : { builtinId: this.opts.builtinId }),
    });
  }

  private async onMessage(msg: WorkerToHost): Promise<void> {
    switch (msg.kind) {
      case "ready":
        this.ready = true;
        if (this.activation) this.sendInit();
        return;
      case "activated":
        if (msg.ok) this.activation?.resolve();
        else this.activation?.reject(Object.assign(new Error(msg.error?.message ?? "activation failed"), msg.error));
        this.activation = undefined;
        return;
      case "call":
        return this.handleCall(msg);
      case "subscribe":
        return this.handleSubscribe(msg);
      case "unsubscribe":
        this.subs.get(msg.subId)?.();
        this.subs.delete(msg.subId);
        return;
      case "post":
        return this.handlePost(msg);
      case "invoke-result": {
        const pending = this.invokes.get(msg.id);
        if (!pending) return;
        this.invokes.delete(msg.id);
        if (msg.ok) pending.resolve(msg.value);
        else pending.reject(Object.assign(new Error(msg.error.message), msg.error));
        return;
      }
    }
  }

  private async handleCall(msg: Extract<WorkerToHost, { kind: "call" }>): Promise<void> {
    try {
      assertCapability(msg.method, this.granted);
      const value = await dispatchCall(this.ctx, msg.method, msg.args);
      this.post({ kind: "result", id: msg.id, ok: true, value });
    } catch (err) {
      this.post({ kind: "result", id: msg.id, ok: false, error: serializeError(err) });
    }
  }

  private handleSubscribe(msg: Extract<WorkerToHost, { kind: "subscribe" }>): void {
    try {
      assertCapability(msg.method, this.granted);
      const unsub = dispatchSubscribe(this.ctx, msg.method, msg.args, (payload) =>
        this.post({ kind: "event", subId: msg.subId, payload }),
      );
      this.subs.set(msg.subId, unsub);
      this.post({ kind: "result", id: msg.id, ok: true, value: null });
    } catch (err) {
      this.post({ kind: "result", id: msg.id, ok: false, error: serializeError(err) });
    }
  }

  private handlePost(msg: Extract<WorkerToHost, { kind: "post" }>): void {
    try {
      assertCapability(msg.method, this.granted);
      dispatchPost(this.ctx, msg.method, msg.args);
    } catch (err) {
      console.warn(`[plugin ${this.opts.pluginId}] post "${msg.method}" rejected:`, err);
    }
  }

  private post(msg: HostToWorker): void {
    this.worker.postMessage(msg);
  }
}
