import { useEffect, useRef, useState } from "react";
import type { Point } from "@sketchor/core";

/**
 * D-02b: the value editor a double-click on a dimension opens (Onshape /
 * Fusion style). Shows the driving value — or, on a reference dimension, what
 * it measures — focused and selected; Enter applies (`parseDimValue`:
 * expressions and parameters welcome), Esc cancels.
 *
 * When the value would over-define the sketch the viewport hands back an
 * `over` message and the box turns into the prompt Onshape shows at that
 * point: keep it as a reference dimension (nothing moves) or make it driving
 * anyway (the conflict then shows in the constraints panel).
 */
export function DimValueBox({
  label,
  hint,
  initial,
  screen,
  over,
  onCommit,
  onMakeReference,
  onDriveAnyway,
  onCancel,
}: {
  label: string;
  hint: string;
  initial: string;
  screen: Point;
  over: string | null;
  /** Returns an error message to show, or null when accepted (applied, or `over` will be set). */
  onCommit: (text: string) => string | null;
  onMakeReference: () => void;
  onDriveAnyway: () => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  // Focus the prompt's default answer on the next tick: focused during the Enter that raised it, the same keypress would click it.
  const refBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!over) return;
    const t = setTimeout(() => refBtn.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [over]);
  const keys = (ev: React.KeyboardEvent) => {
    if (ev.key === "Escape") onCancel();
    ev.stopPropagation();
  };
  return (
    <div className="typed-input dim-value-box" style={{ left: screen.x + 12, top: screen.y + 12 }} data-testid="dim-value" onKeyDown={keys}>
      <input
        className={error ? "invalid" : ""}
        value={text}
        spellCheck={false}
        autoFocus
        aria-label={label}
        disabled={!!over}
        onChange={(ev) => {
          setError(null);
          setText(ev.target.value);
        }}
        onFocus={(ev) => ev.target.select()}
        onKeyDown={(ev) => {
          if (ev.key === "Enter") setError(onCommit(text));
        }}
      />
      {over ? (
        <div className="dim-value-over" data-testid="dim-value-over">
          <div className="typed-input-hint">{over}</div>
          <div className="dim-value-actions">
            <button ref={refBtn} className="btn sm" onClick={onMakeReference} data-testid="dim-value-reference">
              Make reference
            </button>
            <button className="btn ghost sm" onClick={onDriveAnyway} data-testid="dim-value-drive">
              Drive anyway
            </button>
          </div>
        </div>
      ) : (
        <div className="typed-input-hint">{error ?? hint}</div>
      )}
    </div>
  );
}
