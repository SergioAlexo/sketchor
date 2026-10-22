import { CapabilityError, type GrantedCapabilities, type Permission } from "@sketchor/core";

/**
 * The permission each host method requires. `null` = no permission needed (UI
 * methods). A method absent from this map is unknown and rejected outright — a
 * plugin can only reach methods the host explicitly exposes.
 */
const REQUIRED: Record<string, Permission | null> = {
  "document.read": "read-document",
  "document.apply": "write-document",
  "document.onChange": "read-document",
  "selection.read": "read-document",
  "selection.onChange": "read-document",
  "storage.get": "storage",
  "storage.set": "storage",
  "storage.delete": "storage",
  "storage.keys": "storage",
  "network.fetch": "network",
  "filesystem.readFile": "filesystem",
  "filesystem.writeFile": "filesystem",
  "ui.show": null,
  "ui.hide": null,
  "ui.postMessage": null,
  "ui.onMessage": null,
  "ui.notify": null,
  "ui.print": null,
  // The folder is the *host's* autosave setting, chosen by the user in an OS
  // picker and named only by its display name — a plugin can neither see a
  // path nor write anywhere but the sheet it just printed.
  "ui.printFolder": null,
  "ui.pickPrintFolder": null,
  // Like ui.print, the plugin only hands the host bytes to write — it never
  // gets a path or read access, so this needs no filesystem-style grant.
  "ui.saveFile": null,
  // The user picks the folder in an OS dialog; the plugin sees only its name
  // and relative paths and can read just inside that grant (no path escape).
  "ui.pickFolder": null,
  "ui.readPickedFile": null,
  "app.displayUnit": null,
  "app.onDisplayUnitChange": null,
  // Creates a tab and writes a drawing into it - same power as document.apply.
  "app.openDocumentTab": "write-document",
};

export class UnknownMethodError extends Error {
  readonly code = "unknown-method" as const;
  constructor(method: string) {
    super(`Unknown host method "${method}"`);
    this.name = "UnknownMethodError";
  }
}

/**
 * Enforces the capability contract before any host method runs. Throws
 * {@link UnknownMethodError} for a method the host doesn't expose and
 * {@link CapabilityError} when the plugin lacks the required grant. This is the
 * single choke point — every inbound call passes through it.
 */
export function assertCapability(method: string, granted: GrantedCapabilities): void {
  if (!(method in REQUIRED)) throw new UnknownMethodError(method);
  const required = REQUIRED[method];
  if (required !== null && !granted.has(required)) throw new CapabilityError(required);
}
