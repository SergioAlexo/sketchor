import type { DisplayUnitInfo, PluginModule } from "@sketchor/plugin-sdk";
import {
  buildPalletDrawing, buildPalletReportHtml, clearPalletDrawing, editPalletPlan, stagePalletProducts,
  hasPalletScene, palletSceneMatchesPlan, planFromPalletScene,
  DEFAULT_PALLET_RULES, palletReportFileName, parsePalletPlan, readPalletReport,
  type PalletPlan,
} from "@sketchor/plugin-pallet-planning";
import PANEL_HTML from "./palletPlanningPanel.html?raw";
import { buildPalletReportPdf } from "./palletPlanningPdf";

const STORAGE_KEY = "current-plan-v1";
const HISTORY_LIMIT = 20;
const MAX_IMPORT_LENGTH = 12_000_000;
const MM: DisplayUnitInfo = { unit: "mm", perMm: 1, label: "mm" };
const REPORT_DIRECTORY = "K:\\01 PROD FILES\\Pallet Configurations";

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
    let pendingPdf: { htmlName: string; name: string; bytes: Uint8Array } | undefined;
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
    const sync = (type: "init" | "plan", replaceInputs: boolean, message: string, canResumeDrawing = false, inputUnit?: "in") => send({
      type, plan, replaceInputs, message, canUndo: undo.length > 0, canRedo: redo.length > 0,
      inputUnit,
      ...(type === "init" ? { rules: DEFAULT_PALLET_RULES, openingRules, reportFolder, canResumeDrawing, pdfPending: Boolean(pendingPdf) } : {}),
    });

    async function savePendingPdf() {
      if (!pendingPdf) {
        send({ type: "status", message: "", pdfPending: false });
        return;
      }
      const pdf = pendingPdf;
      const htmlStatus = "HTML saved as " + pdf.htmlName + ".";
      try {
        const result = await sketchor.ui.saveFile(pdf.name, pdf.bytes, [
          { description: "PDF report", accept: { "application/pdf": [".pdf"] } },
        ]);
        if (result.saved) pendingPdf = undefined;
        const message = result.saved
          ? htmlStatus + " PDF saved as " + result.name + "."
          : htmlStatus + " PDF save cancelled.";
        send({ type: "status", message, pdfPending: Boolean(pendingPdf) });
      } catch (error) {
        // A network write or renewed folder permission can use up the click's activation.
        const detail = error instanceof Error ? error.message : String(error);
        send({ type: "error", message: htmlStatus + " Click Save PDF to try again. " + detail, pdfPending: true });
      }
    }

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

    const commit = async (next: PalletPlan, message: string, replaceInputs = false, before = plan, inputUnit?: "in") => {
      if (replaceInputs || next.review === "draft") await draw(next);
      if (before) pushHistory(undo, before);
      redo.length = 0;
      plan = next;
      sync("plan", replaceInputs, await persist(message), false, inputUnit);
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
      const next = planFromPalletScene(source, model, selection, action, crypto.randomUUID());
      const message = next === source ? "The top unit is already on that layer." : `2D layout applied. ${next.pallets.length} pallets.`;
      if (next === source) send({ type: "status", message });
      else {
        let before = source;
        if (source.looseStacks && !palletSceneMatchesPlan(source, model)) {
          try {
            before = planFromPalletScene(source, model, [], { type: "sync" }, source.revisionId);
          } catch {
            // The corrected layout can be valid even when the prior CAD moves were not.
          }
        }
        await commit(next, message, !plan, before);
      }
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
          if (plan && previous === plan
            && JSON.stringify([plan.products, plan.rules]) === JSON.stringify([next.products, next.rules])) {
            if (msg.refreshDrawing === true) await draw(plan);
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
        case "save-pdf":
          await savePendingPdf();
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
        case "interpret-inches": {
          const model = await sketchor.document.read();
          const before = palletSceneMatchesPlan(plan, model)
            ? plan : planFromPalletScene(plan, model, [], { type: "sync" }, plan.revisionId);
          const next = planFromPalletScene(plan, model, [], { type: "interpret-inches" }, crypto.randomUUID());
          await commit(next, "Product sizes corrected to inches. Pallet bases recalculated.", true, before, "in");
          await sketchor.app.fitDrawing();
          return;
        }
        case "group-scene":
          await applyScene({ type: "group" });
          return;
        case "edit": {
          const resizing = (msg.action as { type?: unknown } | null)?.type === "resize";
          let before = plan;
          if (resizing) {
            const model = await sketchor.document.read();
            const matches = palletSceneMatchesPlan(plan, model);
            if (hasPalletScene(plan, model)) {
              if (!matches || plan.pallets.some(pallet => !pallet.sceneOrigin)) {
                before = planFromPalletScene(plan, model, [], { type: "sync" }, plan.revisionId);
              }
            } else if (!matches) {
              throw new Error("Open the matching 2D drawing before resizing this pallet.");
            }
          }
          const next = editPalletPlan(before, msg.action, crypto.randomUUID());
          if (next.review === "confirmed" && !palletSceneMatchesPlan(plan, await sketchor.document.read())) {
            throw new Error("The drawing has manual changes. Use Make pallets from 2D before confirming the plan.");
          }
          if (next === before) {
            send({ type: "status", message: resizing ? "The pallet already has those dimensions." : "Custom pallets already fit the current layout." });
          } else {
            await commit(next, resizing ? "Pallet dimensions updated." : "Plan updated.", false, before);
          }
          return;
        }
        case "save-report": {
          if (!reportFolder.supported) throw new Error("Use Chrome or Edge to save reports to the shared folder.");
          if (!reportFolder.folder) throw new Error("Choose " + REPORT_DIRECTORY + " with Report folder… first.");
          let reportPlan = plan;
          const model = await sketchor.document.read();
          if (!palletSceneMatchesPlan(reportPlan, model)) {
            if (!reportPlan.looseStacks) {
              throw new Error("The drawing has manual changes. Apply the 2D layout before saving the report.");
            }
            reportPlan = planFromPalletScene(reportPlan, model, [], { type: "sync" }, crypto.randomUUID());
            await commit(reportPlan, "2D layout applied.");
          }
          const reportUnit = msg.unit === "in" ? "in" : "mm";
          const bytes = buildPalletReportPdf(reportPlan, reportUnit);
          const result = await sketchor.ui.saveReportFile(
            palletReportFileName(reportPlan, new Date()),
            buildPalletReportHtml(reportPlan, reportUnit),
            { requireFolder: true },
          );
          if (!result.saved || !result.name) throw new Error("The HTML report could not be saved.");
          pendingPdf = { htmlName: result.name, name: result.name.replace(/\.html$/i, ".pdf"), bytes };
          await savePendingPdf();
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
