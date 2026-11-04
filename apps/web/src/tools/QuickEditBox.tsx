import { useState } from "react";
import type { Point } from "@sketchor/core";

/**
 * The post-commit quick-edit box (T-08): after a line, circle or arc is
 * drawn it sits beside the new entity showing its length/radius. F2 or a
 * click focuses it; Enter applies the typed value (`quickEditCommands`),
 * Esc or the next canvas press dismisses it. Not focused by default so
 * drawing on is never interrupted. Styled like the coordinate box.
 */
export function QuickEditBox({
  label,
  initial,
  screen,
  onCommit,
  onCancel,
}: {
  label: string;
  initial: string;
  screen: Point;
  onCommit: (text: string) => boolean;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const [bad, setBad] = useState(false);
  return (
    <div className="typed-input" style={{ left: screen.x + 12, top: screen.y + 12 }} data-testid="quick-edit">
      <input
        className={bad ? "invalid" : ""}
        value={text}
        spellCheck={false}
        aria-label={label}
        onChange={(ev) => {
          setBad(false);
          setText(ev.target.value);
        }}
        onFocus={(ev) => ev.target.select()}
        onKeyDown={(ev) => {
          if (ev.key === "Enter") {
            if (!onCommit(text)) setBad(true);
          } else if (ev.key === "Escape") {
            onCancel();
          }
          ev.stopPropagation();
        }}
      />
      <div className="typed-input-hint">{label} · F2 to edit · Enter applies</div>
    </div>
  );
}
