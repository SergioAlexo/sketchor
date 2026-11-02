import { layoutList, plotLayoutsToPdf } from "@sketchor/core";
import { doc } from "../state/store";
import { activeSaveTarget } from "../io/drawingFile";
import { escapeHtml, printHtml } from "../print/printHtml";

/**
 * L-06: plots the named layouts (each at its own paper size, 1:1) into one PDF and hands it to the print
 * preview, whose "Save a PDF" box files it in the autosave folder. The preview shows the PDF in the browser's viewer;
 * the link beside it downloads the same bytes.
 */
export function publishLayouts(names: string[]): boolean {
  const bytes = plotLayoutsToPdf(doc, names);
  if (!bytes) return false;
  const base = (activeSaveTarget()?.name ?? "Sketchor drawing").replace(/\.[^./\\]+$/, "");
  const label = names.length === 1 ? `${base} - ${names[0]}` : base;
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "application/pdf" }));
  printHtml(
    `<object data="${url}" type="application/pdf" style="width:100%;height:78vh"></object>` +
      `<p><a href="${url}" download="${escapeHtml(label)}.pdf">Download ${escapeHtml(label)}.pdf</a> (${names.length} sheet${names.length === 1 ? "" : "s"})</p>`,
    { fileName: label, pdf: bytes },
  );
  return true;
}

export function allLayoutNames(): string[] {
  return layoutList(doc).map((l) => l.name);
}
