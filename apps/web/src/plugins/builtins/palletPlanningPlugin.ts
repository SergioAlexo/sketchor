import type { DisplayUnitInfo, PluginModule } from "@sketchor/plugin-sdk";
import {
  buildPalletDrawing, buildPalletReportHtml, clearPalletDrawing, editPalletPlan, generatePalletPlan,
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
    const undo: PalletPlan[] = [];
    const redo: PalletPlan[] = [];
    let unit = await sketchor.app.displayUnit().catch(() => MM);
    let reportFolder = await sketchor.ui.reportFolder().catch(() => ({ supported: false, folder: null }));
    let initialWarning = "";
    try {
      const stored = await sketchor.storage.get(STORAGE_KEY);
      if (stored) plan = parsePalletPlan(stored);
    } catch {
      initialWarning = "Could not restore the last plan. Open a saved report to continue.";
    }
    const send = (message: object) => sketchor.ui.postMessage(message);
    const sync = (type: "init" | "plan", replaceInputs: boolean, message: string) => send({
      type, plan, replaceInputs, message, canUndo: undo.length > 0, canRedo: redo.length > 0,
      stacks: plan?.pallets.map(pallet => [pallet.id, placementStacks(pallet.placements)]) ?? [],
      ...(type === "init" ? { unit, rules: DEFAULT_PALLET_RULES, colors: PRODUCT_COLORS, reportFolder } : {}),
    });

    const persist = async (message: string) => {
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

    const commit = async (next: PalletPlan, message: string, replaceInputs = false) => {
      if (replaceInputs || next.review === "draft") await draw(next);
      if (plan) pushHistory(undo, plan);
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

    async function handle(raw: unknown) {
      if (!raw || typeof raw !== "object") return;
      const msg = raw as Record<string, unknown>;
      switch (msg.type) {
        case "ready":
          sync("init", true, initialWarning);
          initialWarning = "";
          return;
        case "generate": {
          const next = generatePalletPlan(msg.input, {
            id: plan?.id ?? crypto.randomUUID(),
            revisionId: crypto.randomUUID(),
            parentRevisionId: plan?.revisionId ?? null,
          });
          await commit(next, next.unplaced.length ? "Draft generated with unplaced products." : "Draft generated.", true);
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
          await commit(next, "Pallet plan opened.", true);
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
        case "edit":
          await commit(editPalletPlan(plan, msg.action, crypto.randomUUID()), "Plan updated.");
          return;
        case "save-report": {
          const result = await sketchor.ui.saveReportFile(
            palletReportFileName(plan, new Date()),
            buildPalletReportHtml(plan, msg.unit === "in" ? "in" : "mm"),
          );
          send({ type: "status", message: result.saved ? `Saved ${result.name}.` : "" });
          return;
        }
      }
    }

    // A rapid second message should see the committed revision of the first.
    let pending = Promise.resolve();
    await sketchor.ui.onMessage(raw => {
      pending = pending.then(() => handle(raw)).catch(error => {
        send({ type: "error", message: error instanceof Error ? error.message : String(error) });
      });
    });
  },
};

export default plugin;
