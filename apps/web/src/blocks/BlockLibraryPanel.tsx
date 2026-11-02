import { useMemo, useRef, useState } from "react";
import {
  blockFromEntities,
  blockCountCsv,
  blockCountTable,
  blockPreviewEntities,
  instancesOf,
  planPurge,
  planReplaceBlock,
  purgeCandidates,
  entitiesToSvg,
  evaluateDynamic,
  instanceCounts,
  SHIPPED_CATEGORY,
  shippedLibrary,
  libraryEntry,
  parseDxf,
  planLibraryImport,
  sanitizeBlockName,
  SketchDocument,
  type BlockDefinition,
  type Command,
  type LibraryEntry,
} from "@sketchor/core";
import { beginBlockEdit, bus, doc, useApp } from "../state/store";
import { downloadText } from "./download";
import { addToLibrary, loadLibrary, removeFromLibrary } from "./libraryStore";

/**
 * The block library (B-06, Ctrl+3). "This drawing" lists the definitions with
 * thumbnails and instance counts; "Library" holds favourites that follow the
 * user across drawings (and files added from disk). Clicking Insert activates
 * the Insert tool with that block, importing it first when it is not yet in
 * the drawing.
 */
export function BlockLibraryPanel({ onClose }: { onClose: () => void }) {
  const revision = useApp((s) => s.revision);
  const setTool = useApp((s) => s.setTool);
  const setInsert = useApp((s) => s.setInsertSettings);
  const [source, setSource] = useState<"drawing" | "library" | "sketchor">("drawing");
  const [query, setQuery] = useState("");
  const [library, setLibrary] = useState<LibraryEntry[]>(() => loadLibrary());
  const [note, setNote] = useState("");
  const [showCount, setShowCount] = useState(false);
  const [replacing, setReplacing] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const blocks = useMemo(
    () => (doc.records("blocks") as BlockDefinition[]).filter((b) => b.name.toLowerCase().includes(query.toLowerCase())),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [revision, query],
  );
  const counts = useMemo(() => instanceCounts(doc), [revision]); // eslint-disable-line react-hooks/exhaustive-deps
  const q = query.toLowerCase();
  const libs = library.filter((e) => e.def.name.toLowerCase().includes(q));
  // B-23: the shipped library, grouped by category (a dynamic block's thumbnail is its default state).
  const shipped = useMemo(() => shippedLibrary().map((e) => ({ entry: e, category: SHIPPED_CATEGORY[e.def.name] ?? "Other" })), []);
  const shippedShown = shipped.filter((s) => `${s.entry.def.name} ${s.category} ${s.entry.def.description ?? ""}`.toLowerCase().includes(q));

  const thumb = (entities: ReturnType<typeof blockPreviewEntities>) => ({ __html: entitiesToSvg(entities, { size: 56 }) });
  const place = (name: string) => {
    setInsert({ block: name, values: {} });
    setTool("insert");
  };

  const purge = () => {
    const c = purgeCandidates(doc);
    const plan = planPurge(doc);
    if (!plan) {
      setNote("Nothing to purge");
      return;
    }
    const summary = Object.entries(c).filter(([, v]) => v.length > 0).map(([k, v]) => `${v.length} ${k}`).join(", ");
    if (!window.confirm(`Purge ${summary}?`)) return;
    bus.execute({ type: "batch", commands: plan });
    setNote(`Purged ${summary}`);
  };
  const rename = (name: string) => {
    const to = window.prompt(`Rename ${name} to`, name)?.trim();
    if (to && to !== name) bus.execute({ type: "rename-block", from: name, to });
  };
  const replace = (from: string, to: string) => {
    setReplacing(null);
    const plan = planReplaceBlock(doc, from, to);
    if (!plan) setNote(`Cannot replace ${from} with ${to}`);
    else bus.execute({ type: "batch", commands: plan });
  };
  const countRows = showCount ? blockCountTable(doc) : [];

  const insertFromLibrary = (entry: LibraryEntry, redefine = false) => {
    const cmds: Command[] = planLibraryImport(doc, entry, redefine);
    if (cmds.length === 1) bus.execute(cmds[0]);
    else if (cmds.length > 1) bus.execute({ type: "batch", commands: cmds });
    place(entry.def.name);
  };

  const addFile = async (file: File) => {
    try {
      const text = await file.text();
      const name = sanitizeBlockName(file.name);
      let entry: LibraryEntry;
      if (/\.sketchor$/i.test(file.name)) {
        const src = SketchDocument.fromJSON(JSON.parse(text));
        const deps = (src.records("blocks") as BlockDefinition[]).map((d) => structuredClone(d));
        entry = { def: blockFromEntities(name, src.all()), deps };
      } else {
        entry = { def: blockFromEntities(name, parseDxf(text, { blocks: "explode" }).entities), deps: [] };
      }
      if (entry.def.entities.length === 0) {
        setNote(`${file.name}: nothing to insert`);
        return;
      }
      if (!addToLibrary(entry)) setNote("The browser refused to store the library (full?)");
      else setNote(`${name} added to the library`);
      setLibrary(loadLibrary());
      setSource("library");
    } catch {
      setNote(`${file.name}: could not be read`);
    }
  };

  return (
    <aside className="propspanel" data-testid="block-library">
      <div className="layerpanel-header">
        <span>Blocks</span>
        <button className="btn ghost sm" onClick={onClose} title="Close">
          ✕
        </button>
      </div>
      <div className="fill-row" style={{ gap: 6, padding: "0 8px" }}>
        <button className={`btn ghost sm ${source === "drawing" ? "active" : ""}`} data-testid="blocklib-drawing" onClick={() => setSource("drawing")}>
          This drawing
        </button>
        <button className={`btn ghost sm ${source === "library" ? "active" : ""}`} data-testid="blocklib-library" onClick={() => setSource("library")}>
          Library
        </button>
        <button className={`btn ghost sm ${source === "sketchor" ? "active" : ""}`} data-testid="blocklib-sketchor" onClick={() => setSource("sketchor")}>
          Sketchor library
        </button>
      </div>
      <div style={{ padding: 8 }}>
        <input type="search" placeholder="Search" value={query} data-testid="blocklib-search" style={{ width: "100%" }} onChange={(e) => setQuery(e.target.value)} />
      </div>
      {source === "drawing" && (
        <div style={{ display: "flex", gap: 4, padding: "0 8px 4px", flexWrap: "wrap" }}>
          <button className="btn ghost sm" data-testid="blocklib-purge" title="Remove unused blocks, layers, linetypes, styles and patterns" onClick={purge}>Purge</button>
          <button className="btn ghost sm" data-testid="blocklib-count" onClick={() => setShowCount(!showCount)}>Count</button>
        </div>
      )}
      {showCount && (
        <div style={{ padding: "0 8px 8px" }} data-testid="blocklib-count-table">
          <table style={{ width: "100%" }}>
            <thead><tr><th align="left">Block</th><th>Placed</th><th>Total</th></tr></thead>
            <tbody>{countRows.map((r) => <tr key={r.block}><td>{r.block}</td><td align="center">{r.placed}</td><td align="center">{r.total}</td></tr>)}</tbody>
          </table>
          <button className="btn ghost sm" onClick={() => downloadText("block-count.csv", blockCountCsv(countRows), "text/csv")}>Save CSV</button>
        </div>
      )}
      {note && <div className="straighten-hint" style={{ padding: "0 8px" }}>{note}</div>}
      <div style={{ overflowY: "auto", flex: 1 }}>
        {source === "drawing" &&
          blocks.map((b) => (
            <div key={b.name} className="fill-row" data-testid={`blocklib-row-${b.name}`} style={{ padding: "4px 8px", alignItems: "center", gap: 8 }}>
              <div style={{ width: 56, height: 56, flex: "none" }} dangerouslySetInnerHTML={thumb(blockPreviewEntities(doc, b.name))} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{b.name}</div>
                <div className="straighten-hint">{counts.get(b.name) ?? 0} placed{b.attributeDefs.length > 0 ? ` - ${b.attributeDefs.length} attr` : ""}</div>
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  <button className="btn ghost sm" data-testid={`blocklib-insert-${b.name}`} onClick={() => place(b.name)}>Insert</button>
                  <button className="btn ghost sm" onClick={() => beginBlockEdit(b.name)}>Edit</button>
                  <button className="btn ghost sm" title="Rename" onClick={() => rename(b.name)}>Rename</button>
                  <button className="btn ghost sm" title="Select all instances" onClick={() => useApp.getState().setSelection(instancesOf(doc, b.name))}>Select</button>
                  <button className="btn ghost sm" title="Replace with another block" onClick={() => setReplacing(replacing === b.name ? null : b.name)}>Replace</button>
                  {replacing === b.name && (
                    <select value="" onChange={(e) => e.target.value && replace(b.name, e.target.value)}>
                      <option value="">with...</option>
                      {(doc.records("blocks") as BlockDefinition[]).filter((o) => o.name !== b.name).map((o) => <option key={o.name} value={o.name}>{o.name}</option>)}
                    </select>
                  )}
                  <button
                    className="btn ghost sm"
                    title="Keep in the library"
                    onClick={() => {
                      const entry = libraryEntry(doc, b.name);
                      if (entry && addToLibrary(entry)) setLibrary(loadLibrary());
                    }}
                  >
                    ★
                  </button>
                  <button
                    className="btn ghost sm"
                    title={(counts.get(b.name) ?? 0) > 0 ? "Remove the block and its instances" : "Remove the block"}
                    onClick={() => {
                      const used = (counts.get(b.name) ?? 0) > 0;
                      if (used && !window.confirm(`Delete ${b.name} and its ${counts.get(b.name)} instance(s)?`)) return;
                      bus.execute({ type: "delete-block", name: b.name, purge: used });
                    }}
                  >
                    ✕
                  </button>
                </div>
              </div>
            </div>
          ))}
        {source === "drawing" && blocks.length === 0 && <div className="straighten-hint" style={{ padding: 8 }}>No blocks yet - select objects and press B.</div>}
        {source === "library" &&
          libs.map((e) => {
            const here = doc.hasRecord("blocks", e.def.name);
            return (
              <div key={e.def.name} className="fill-row" data-testid={`blocklib-lib-${e.def.name}`} style={{ padding: "4px 8px", alignItems: "center", gap: 8 }}>
                <div style={{ width: 56, height: 56, flex: "none" }} dangerouslySetInnerHTML={{ __html: entitiesToSvg(e.def.entities.filter((x) => x.type !== "insert"), { size: 56 }) }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{e.def.name}</div>
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    <button className="btn ghost sm" onClick={() => insertFromLibrary(e)}>Insert</button>
                    {here && (
                      <button className="btn ghost sm" title="Replace this drawing's block with the library version" onClick={() => insertFromLibrary(e, true)}>
                        Redefine
                      </button>
                    )}
                    <button
                      className="btn ghost sm"
                      title="Remove from the library"
                      onClick={() => {
                        removeFromLibrary(e.def.name);
                        setLibrary(loadLibrary());
                      }}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        {source === "sketchor" &&
          shippedShown.map(({ entry: e, category }, i) => (
            <div key={e.def.name}>
              {(i === 0 || shippedShown[i - 1].category !== category) && <div className="straighten-hint" style={{ padding: "6px 8px 0" }}>{category}</div>}
              <div className="fill-row" data-testid={`blocklib-sk-${e.def.name}`} style={{ padding: "4px 8px", alignItems: "center", gap: 8 }}>
                <div style={{ width: 56, height: 56, flex: "none" }} dangerouslySetInnerHTML={{ __html: entitiesToSvg(evaluateDynamic(e.def, {}), { size: 56 }) }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ overflow: "hidden", textOverflow: "ellipsis" }} title={e.def.description}>{e.def.name}</div>
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    <button className="btn ghost sm" onClick={() => insertFromLibrary(e)}>Insert</button>
                    {doc.hasRecord("blocks", e.def.name) && (
                      <button className="btn ghost sm" title="Replace this drawing's block with the shipped version" onClick={() => insertFromLibrary(e, true)}>
                        Redefine
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}
        {source === "library" && (
          <div style={{ padding: 8 }}>
            <input
              ref={fileRef}
              type="file"
              accept=".dxf,.sketchor"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void addFile(f);
                e.target.value = "";
              }}
            />
            <button className="btn ghost sm" data-testid="blocklib-add-file" onClick={() => fileRef.current?.click()}>
              Add a DXF / .sketchor file as a block...
            </button>
            {libs.length === 0 && <div className="straighten-hint">Nothing in the library yet - use the star on a block, or add a file.</div>}
          </div>
        )}
      </div>
    </aside>
  );
}
