import { useState } from "react";
import { parseThresholds } from "../lib/format";

interface Props {
  thresholds: number[];
  alertState?: Record<string, boolean>;
  editable: boolean;
  onSave: (t: number[]) => Promise<void>;
}

export default function ThresholdEditor({ thresholds, alertState, editable, onSave }: Props) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(thresholds.join(", "));
  const [error, setError] = useState(false);

  if (!editing) {
    return (
      <div className="chips" onClick={editable ? () => { setText(thresholds.join(", ")); setEditing(true); } : undefined} title={editable ? "Click to edit alert thresholds" : undefined} role={editable ? "button" : undefined}>
        {thresholds.length === 0 && <span className="muted">{editable ? "+ add" : "none"}</span>}
        {thresholds.map((t) => (
          <span key={t} className={`chip ${alertState?.[String(t).replace(".", "_")] ? "fired" : ""}`}>-{t}%</span>
        ))}
      </div>
    );
  }

  async function save() {
    const parsed = text.trim() === "" ? [] : parseThresholds(text);
    if (!parsed) {
      setError(true);
      return;
    }
    await onSave(parsed);
    setEditing(false);
  }

  return (
    <div className="row tight">
      <input
        className={`small ${error ? "invalid" : ""}`}
        autoFocus
        value={text}
        onChange={(e) => { setText(e.target.value); setError(false); }}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") setEditing(false);
        }}
        placeholder="10, 20, 30"
        aria-label="Alert thresholds in percent"
      />
      <button className="btn small" onClick={save}>Save</button>
    </div>
  );
}
