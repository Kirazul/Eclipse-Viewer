/** Background colour: presets, the last six used, and a small hue / shade picker. */
import { Popover } from "radix-ui";
import { useEffect, useRef, useState } from "react";

const PRESETS = ["#00b140", "#ff00ff", "#00ffff"];
const RECENTS_KEY = "background-color-recents";

function hsvToHex(h: number, s: number, v: number): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    const c = v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, "0");
  };
  return `#${f(5)}${f(3)}${f(1)}`;
}

function hexToHsv(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
    if (h < 0) h += 360;
  }
  return [h, max ? d / max : 0, max];
}

function readRecents(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENTS_KEY) || "[]").slice(0, 6); } catch { return []; }
}

export function ColorPicker(props: { value: string | null; onChange: (css: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const [recents, setRecents] = useState<string[]>([]);
  const value = props.value ?? "#171412";
  const [h, setH] = useState(() => hexToHsv(value)[0]);
  const [, s, v] = hexToHsv(value);
  const sv = useRef<HTMLDivElement>(null);
  useEffect(() => { if (open) setRecents(readRecents()); }, [open]);

  const remember = () => {
    if (!props.value || PRESETS.includes(props.value)) return;
    const next = [props.value, ...readRecents().filter((c) => c !== props.value)].slice(0, 6);
    setRecents(next);
    try { localStorage.setItem(RECENTS_KEY, JSON.stringify(next)); } catch { /* private window */ }
  };
  const pick = (e: React.PointerEvent) => {
    const r = sv.current!.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    props.onChange(hsvToHex(h, x, 1 - y));
  };

  return (
    <Popover.Root open={open} onOpenChange={(o) => { if (!o) remember(); setOpen(o); }}>
      <Popover.Trigger asChild>
        <button className="btn start block" type="button" aria-label="Background colour">
          <span className="swatch-mini" style={{ background: props.value ?? "var(--model-background-color)" }} />
          Background colour
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="pop pop-stack" sideOffset={6} align="start" style={{ minWidth: 0 }}>
          <div
            ref={sv}
            className="hsv-sv"
            style={{ "--hue": `hsl(${h} 100% 50%)` } as React.CSSProperties}
            onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); pick(e); }}
            onPointerMove={(e) => { if (e.buttons) pick(e); }}
          >
            <div className="hsv-dot" style={{ left: `${s * 100}%`, top: `${(1 - v) * 100}%` }} />
          </div>
          <input
            className="hsv-hue"
            type="range"
            min={0}
            max={359}
            value={h}
            aria-label="Hue"
            onChange={(e) => { const nh = e.target.valueAsNumber; setH(nh); props.onChange(hsvToHex(nh, s, v || 1)); }}
          />
          <div className="flex items-center gap-1" data-testid="bg-swatches">
            {[...PRESETS, ...recents].map((c) => (
              <button
                key={c}
                type="button"
                className="swatch-mini"
                style={{ background: c }}
                aria-label={c}
                onClick={() => { setH(hexToHsv(c)[0]); props.onChange(c); }}
              />
            ))}
            <button type="button" className="btn" style={{ height: 22, padding: "0 8px", fontSize: 12.5, marginLeft: "auto" }} onClick={() => props.onChange(null)}>Clear</button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
