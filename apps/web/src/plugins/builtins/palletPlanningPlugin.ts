import type { DisplayUnitInfo, PluginModule } from "@sketchor/plugin-sdk";
import {
  buildPalletDrawing, buildPalletReportCsv, buildPalletReportHtml, editPalletPlan, generatePalletPlan,
  DEFAULT_PALLET_RULES, parsePalletPlan, PRODUCT_COLORS, type PalletPlan,
} from "@sketchor/plugin-pallet-planning";
import PANEL_HTML from "./palletPlanningPanel.html?raw";

const STORAGE_KEY = "current-plan-v1";
const HISTORY_LIMIT = 20;
const MAX_IMPORT_LENGTH = 4_000_000;
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
    let initialWarning = "";
    try {
      const stored = await sketchor.storage.get(STORAGE_KEY);
      if (stored) plan = parsePalletPlan(stored);
    } catch {
      initialWarning = "Could not restore the last plan. You can open a saved JSON plan.";
    }
    const send = (message: object) => sketchor.ui.postMessage(message);
    const sync = (type: "init" | "plan", replaceInputs: boolean, message: string) => send({
      type, plan, replaceInputs, message, canUndo: undo.length > 0, canRedo: redo.length > 0,
      ...(type === "init" ? { unit, rules: DEFAULT_PALLET_RULES, colors: PRODUCT_COLORS } : {}),
    });

    const persist = async (message: string) => {
      try {
        await sketchor.storage.set(STORAGE_KEY, plan);
        return message;
      } catch {
        return `${message} Local save failed. Save JSON to keep this revision.`;
      }
    };

    const commit = async (next: PalletPlan, message: string, replaceInputs = false) => {
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
        case "open-json": {
          if (typeof msg.data !== "string" || msg.data.length > MAX_IMPORT_LENGTH) {
            throw new Error("Choose a pallet plan JSON file under 4 MB.");
          }
          let data: unknown;
          try {
            data = JSON.parse(msg.data);
          } catch {
            throw new Error("The selected file is not valid JSON.");
          }
          const next = parsePalletPlan(data);
          await commit(next, "Pallet plan opened.", true);
          return;
        }
        case "undo":
        case "redo": {
          if (!plan) return;
          const back = msg.type === "undo";
          const next = (back ? undo : redo).pop();
          if (!next) return;
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
        case "draw":
          if (!plan.pallets.length) throw new Error("Add a pallet before opening a drawing.");
          await sketchor.app.openDocumentTab("Pallet Plan", buildPalletDrawing(plan, unit));
          send({ type: "status", message: "Drawing opened in a new Sketchor tab." });
          return;
        case "save-json":
        case "save-csv":
        case "save-report": {
          const suffix = plan.revisionId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);
          const csv = msg.type === "save-csv";
          const report = msg.type === "save-report";
          const extension = csv ? "csv" : report ? "html" : "json";
          const format = csv ? "text/csv" : report ? "text/html" : "application/json";
          const data = csv ? buildPalletReportCsv(plan)
            : report ? buildPalletReportHtml(plan, msg.unit === "in" ? "in" : "mm")
            : JSON.stringify(plan, null, 2);
          const result = await sketchor.ui.saveFile(
            `pallet-${csv || report ? "report" : "plan"}-${suffix || "revision"}.${extension}`, data,
            [{ description: csv || report ? "Pallet report" : "Pallet plan", accept: { [format]: [`.${extension}`] } }],
          );
          send({ type: "status", message: result.saved ? (csv || report ? "Pallet report saved." : "Pallet plan saved.") : "" });
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
