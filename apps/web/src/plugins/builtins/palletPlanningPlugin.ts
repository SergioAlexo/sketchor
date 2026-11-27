import type { DisplayUnitInfo, PluginModule } from "@sketchor/plugin-sdk";
import {
  buildPalletDrawing, buildPalletReportHtml, clearPalletDrawing, editPalletPlan, stagePalletProducts,
  hasPalletScene, palletSceneMatchesPlan, planFromPalletScene,
  DEFAULT_PALLET_RULES, palletReportFileName, parsePalletPlan, placementStacks, PRODUCT_COLORS, readPalletReport,
  type PalletPlan,
} from "@sketchor/plugin-pallet-planning";
import PANEL_HTML from "./palletPlanningPanel.html?raw";

const STORAGE_KEY = "current-plan-v1";
const HISTORY_LIMIT = 20;
const MAX_IMPORT_LENGTH = 12_000_000;
const MM: DisplayUnitInfo = { unit: "mm", perMm: 1, label: "mm" };

function pushHistory(history: PalletPlan[], plan: PalletPlan) {
  history.push(plan);
  if (history.length > HISTORY_LIMIT) history.shift();
}

const plugin: PluginModule = {
  async activate(sketchor) {
    let plan: PalletPlan | null = null;
    let savedPlan: PalletPlan | null = null;
    let openingRules = DEFAULT_PALLET_RULES;
    let panelId = "";
    const undo: PalletPlan[] = [];
    const redo: PalletPlan[] = [];
    let unit = await sketchor.app.displayUnit().catch(() => MM);
    let reportFolder = await sketchor.ui.reportFolder().catch(() => ({ supported: false, folder: null }));
    try {
      const stored = await sketchor.storage.get(STORAGE_KEY);
      if (stored) {
        savedPlan = parsePalletPlan(stored);
        openingRules = savedPlan.rules;
      }
    } catch {
      // Keep factory rules when old local data cannot be read.
    }
    const send = (message: object) => sketchor.ui.postMessage({ panelId, ...message });
    const sync = (type: "init" | "plan", replaceInputs: boolean, message: string, canResumeDrawing = false) => send({
      type, plan, replaceInputs, message, canUndo: undo.length > 0, canRedo: redo.length > 0,
      stacks: plan?.pallets.map(pallet => [pallet.id, placementStacks(pallet.placements)]) ?? [],
      ...(type === "init" ? { unit, rules: DEFAULT_PALLET_RULES, openingRules, colors: PRODUCT_COLORS, reportFolder, canResumeDrawing } : {}),
    });

    const persist = async (message: string) => {
      if (plan) {
        openingRules = plan.rules;
        savedPlan = plan;
      }
      try {
        await sketchor.storage.set(STORAGE_KEY, plan);
        return message;
      } catch {
        return `${message} Local save failed. Save the report to keep this revision.`;
      }
    };

    const draw = async (next: PalletPlan) => {
      const model = await sketchor.document.read();
      const commands = [...clearPalletDrawing(model), ...buildPalletDrawing(next, unit)];
      if (commands.length) await sketchor.document.apply(commands);
    };

    const commit = async (next: PalletPlan, message: string, replaceInputs = false, before = plan) => {
      if (replaceInputs || next.review === "draft") await draw(next);
      if (before) pushHistory(undo, before);
      redo.length = 0;
      plan = next;
      sync("plan", replaceInputs, await persist(message));
    };

    void sketchor.app.onDisplayUnitChange(info => {
      unit = info;
    });

    await sketchor.commands.register("pallet-planning.open", async () => {
      await sketchor.ui.show(PANEL_HTML, { title: "Pallet Size Generator", width: 476, height: 760 });
    });

    async function applyScene(action: Parameters<typeof planFromPalletScene>[3], selected?: readonly string[]) {
      const [model, selection] = await Promise.all([sketchor.document.read(), selected ?? sketchor.selection.read()]);
      const source = plan ?? savedPlan;
      if (!source) throw new Error("Enter job products or open a pallet plan first.");
      const before = source.looseStacks && !palletSceneMatchesPlan(source, model)
        ? planFromPalletScene(source, model, [], { type: "sync" }, source.revisionId) : source;
      const next = planFromPalletScene(source, model, selection, action, crypto.randomUUID());
      const message = next === source ? "The top unit is already on that layer." : `2D layout applied. ${next.pallets.length} pallets.`;
      if (next === source) send({ type: "status", message });
      else await commit(next, message, !plan, before);
      sketchor.ui.notify(message);
    }

    // Canvas actions and panel messages share the same commit order.
    let pending = Promise.resolve();
    const enqueue = (task: () => Promise<void>, notify = false) => {
      const next = pending.then(task).catch(error => {
        const message = error instanceof Error ? error.message : String(error);
        send({ type: "error", message });
        if (notify) sketchor.ui.notify(message, { error: true });
      });
      pending = next;
      return next;
    };
    await sketchor.commands.register("pallet-planning.group-selection", () =>
      enqueue(() => applyScene({ type: "group-selection" }), true));
    await sketchor.commands.register("pallet-planning.release", () =>
      enqueue(() => applyScene({ type: "release" }), true));
    await sketchor.commands.register("pallet-planning.drop-product", ({ input }) =>
      enqueue(async () => {
        const selection = input ?? await sketchor.selection.read();
        if (!Array.isArray(selection) || selection.length !== 2 || selection.some(id => typeof id !== "string")) {
          throw new Error("Select the product first, then Shift-select the support.");
        }
        await applyScene({ type: "drop", sourceId: selection[0], targetId: selection[1] }, selection);
      }, true));
    for (const layer of [1, 2, 3, 4] as const) {
      await sketchor.commands.register(`pallet-planning.layer-${layer}`, () =>
        enqueue(() => applyScene({ type: "layer", layer }), true));
    }

    async function handle(raw: unknown) {
      if (!raw || typeof raw !== "object") return;
      const msg = raw as Record<string, unknown>;
      if (typeof msg.panelId !== "string" || !msg.panelId) return;
      if (msg.type === "ready") {
        if (panelId !== msg.panelId) {
          panelId = msg.panelId;
          plan = null;
          undo.length = 0;
          redo.length = 0;
        }
        const canResumeDrawing = Boolean(savedPlan && hasPalletScene(savedPlan, await sketchor.document.read()));
        sync("init", true, "", canResumeDrawing);
        return;
      }
      if (msg.panelId !== panelId) return;
      switch (msg.type) {
        case "resume-drawing": {
          if (!savedPlan || !hasPalletScene(savedPlan, await sketchor.document.read())) {
            throw new Error("The current drawing does not match the last pallet plan.");
          }
          plan = savedPlan;
          sync("plan", true, "Drawing ready.");
          return;
        }
        case "stage": {
          const model = await sketchor.document.read();
          let previous = plan && hasPalletScene(plan, model) ? plan : null;
          if (previous && (!previous.looseStacks || !palletSceneMatchesPlan(previous, model))) {
            previous = planFromPalletScene(previous, model, [], { type: "sync" }, crypto.randomUUID());
          }
          const next = stagePalletProducts(msg.input, previous, {
            id: previous?.id ?? crypto.randomUUID(),
            revisionId: crypto.randomUUID(),
            parentRevisionId: plan?.revisionId ?? null,
          });
          const before = previous?.products.reduce((sum, row) => sum + row.quantity, 0) ?? 0;
          const after = next.products.reduce((sum, row) => sum + row.quantity, 0);
          const unchanged = previous === plan && plan && JSON.stringify([plan.products, plan.rules]) === JSON.stringify([next.products, next.rules]);
          if (unchanged) {
            send({ type: "status", message: "Products are ready on the 2D drawing." });
          } else {
            await commit(next, "Products are ready on the 2D drawing.");
            if (after > before) await sketchor.app.fitDrawing();
          }
          return;
        }
        case "pick-report-folder":
          reportFolder = await sketchor.ui.pickReportFolder();
          send({ type: "report-folder", reportFolder });
          return;
        case "open-report": {
          if (typeof msg.data !== "string" || msg.data.length > MAX_IMPORT_LENGTH) {
            throw new Error("Choose a pallet report under 12 MB.");
          }
          const next = readPalletReport(msg.data);
          if (hasPalletScene(next, await sketchor.document.read())) {
            if (plan) pushHistory(undo, plan);
            redo.length = 0;
            plan = next;
            sync("plan", true, await persist("Pallet plan opened with its current 2D drawing."));
          } else {
            await commit(next, "Pallet plan opened.", true);
          }
          return;
        }
        case "undo":
        case "redo": {
          if (!plan) return;
          const back = msg.type === "undo";
          const from = back ? undo : redo;
          const next = from.at(-1);
          if (!next) return;
          await draw(next);
          from.pop();
          const replaceInputs = next.id !== plan.id || next.products !== plan.products || next.rules !== plan.rules;
          pushHistory(back ? redo : undo, plan);
          plan = next;
          sync("plan", replaceInputs, await persist(back ? "Previous revision restored." : "Revision reapplied."));
          return;
        }
      }
      if (!plan) throw new Error("Generate or open a pallet plan first.");
      if (msg.revisionId !== plan.revisionId) {
        sync("plan", false, "A newer plan is open. Apply your edit to that revision.");
        return;
      }
      switch (msg.type) {
        case "group-scene":
          await applyScene({ type: "group" });
          return;
        case "edit": {
          const next = editPalletPlan(plan, msg.action, crypto.randomUUID());
          if (next.review === "confirmed" && !palletSceneMatchesPlan(plan, await sketchor.document.read())) {
            throw new Error("The drawing has manual changes. Use Make pallets from 2D before confirming the plan.");
          }
          if (next === plan) {
            send({ type: "status", message: "Custom pallets already fit the current layout." });
          } else {
            await commit(next, "Plan updated.");
          }
          return;
        }
        case "save-report": {
          let reportPlan = plan;
          const model = await sketchor.document.read();
          if (!palletSceneMatchesPlan(reportPlan, model)) {
            if (!reportPlan.looseStacks) {
              throw new Error("The drawing has manual changes. Apply the 2D layout before saving the report.");
            }
            reportPlan = planFromPalletScene(reportPlan, model, [], { type: "sync" }, crypto.randomUUID());
            await commit(reportPlan, "2D layout applied.");
          }
          const result = await sketchor.ui.saveReportFile(
            palletReportFileName(reportPlan, new Date()),
            buildPalletReportHtml(reportPlan, msg.unit === "in" ? "in" : "mm"),
          );
          send({ type: "status", message: result.saved ? `Saved ${result.name}.` : "" });
          return;
        }
      }
    }

    await sketchor.ui.onMessage(raw => {
      void enqueue(() => handle(raw));
    });
  },
};

export default plugin;
