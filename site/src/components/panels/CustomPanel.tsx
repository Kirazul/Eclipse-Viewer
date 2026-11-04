/**
 * Customization, after UiCustom.cpp: race portraits and sex on one side, one list of
 * what changes the body on the other. The figure stays where it is, in the room.
 *
 * Shape axes are arrow steppers, colours are swatches (two colours split as
 * Khada's gradient rule). What can be chosen is driven by the model itself: its
 * parts list says which geoset groups have more than one value, and a manifest
 * that carries `customization` adds real named options and colours.
 */
import { useStore } from "@nanostores/react";
import { $manifest, $parts } from "@eclipse/engine/stores";
import { ChevronLeft, ChevronRight, Dices, RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";
import { art } from "../../lib/base";
import { setBody } from "../../lib/room/actions";
import { $body, $engine, $geosets, $races } from "../../lib/room/state";

/** Friendly names for retail's geoset groups. Anything else lands under Advanced. */
const AXES: Record<number, string> = {
  0: "Hair",
  1: "Facial hair",
  2: "Beard",
  3: "Sideburns",
  7: "Ears",
  15: "Cape",
  17: "Eyeglow",
  32: "Face",
};
const COMMON = new Set([0, 1, 2, 3, 7, 32]);

export interface CustomOption {
  id: string;
  name: string;
  /** Two colours are drawn as a diagonal split. */
  colors?: [string] | [string, string];
  group?: number;
  value?: number;
}

function swatchBackground(colors: CustomOption["colors"]) {
  if (!colors) return undefined;
  if (colors.length === 1) return colors[0];
  return `linear-gradient(to right bottom,${colors[0]} 50%,${colors[1]} 50.3%)`;
}

function Stepper(props: { name: string; values: number[]; value: number; onChange: (v: number) => void }) {
  const i = Math.max(0, props.values.indexOf(props.value));
  const n = props.values.length;
  const step = (d: number) => props.onChange(props.values[(i + d + n) % n]!);
  return (
    <div className="axis card" data-axis={props.name}>
      <div className="axis-name">{props.name}</div>
      <div className="axis-step">
        <button type="button" className="btn" style={{ width: 28, height: 28, padding: 0 }} onClick={() => step(-1)} aria-label={`Previous ${props.name}`}><ChevronLeft aria-hidden="true" /></button>
        <div className="axis-track" style={{ "--p": n > 1 ? i / (n - 1) : 1 } as React.CSSProperties}>{i + 1} of {n}</div>
        <button type="button" className="btn" style={{ width: 28, height: 28, padding: 0 }} onClick={() => step(1)} aria-label={`Next ${props.name}`}><ChevronRight aria-hidden="true" /></button>
      </div>
    </div>
  );
}

function bodyLabel(name: string, race: string) {
  const short = name.replace(new RegExp(`^${race}\\s*`, "i"), "").trim();
  return short || name;
}

export function CustomPanel() {
  const manifest = useStore($manifest);
  const parts = useStore($parts);
  const races = useStore($races);
  const body = useStore($body);
  const engine = useStore($engine);
  const chosen = useStore($geosets);
  const [advanced, setAdvanced] = useState(false);

  const currentRace = useMemo(() => races.find((r) => r.bodies.some((b) => b.id === body)) ?? races[0], [races, body]);
  const axes = useMemo(() => {
    const groups = new Map<number, Set<number>>();
    for (const p of parts) {
      if (p.geoset < 0) continue;
      const g = Math.floor(p.geoset / 100);
      const v = p.geoset % 100;
      if (!groups.has(g)) groups.set(g, new Set());
      groups.get(g)!.add(v);
    }
    return [...groups].filter(([, vs]) => vs.size > 1).map(([g, vs]) => ({ group: g, values: [...vs].sort((a, b) => a - b) }));
  }, [parts]);
  const defaults = useMemo(() => {
    const d: Record<number, number> = {};
    for (const id of manifest?.defaultGeosets ?? []) d[Math.floor(id / 100)] = id % 100;
    return d;
  }, [manifest]);
  const offers = (manifest as unknown as { customization?: { name: string; options: CustomOption[] }[] } | null)?.customization ?? [];

  const setAxis = (group: number, value: number) => {
    $geosets.set({ ...$geosets.get(), [group]: value });
    engine?.setGeoset(group, value);
  };
  const randomize = () => {
    for (const a of axes) if (COMMON.has(a.group)) setAxis(a.group, a.values[Math.floor(Math.random() * a.values.length)]!);
  };
  const resetBody = () => {
    for (const a of axes) if (defaults[a.group] !== undefined) engine?.setGeoset(a.group, defaults[a.group]!);
    $geosets.set({});
  };

  if (!manifest) {
    return (
      <div className="notice-center">
        <div className="notice"><div className="notice-title">Getting your character ready</div><p className="notice-body">This fills in by itself in a moment.</p></div>
      </div>
    );
  }

  const common = axes.filter((a) => COMMON.has(a.group));
  const rest = axes.filter((a) => !COMMON.has(a.group));
  const named = (a: { group: number }) => AXES[a.group] ?? `Group ${a.group + 1}`;
  const valueOf = (a: { group: number; values: number[] }) => chosen[a.group] ?? defaults[a.group] ?? a.values[0]!;

  return (
    <div className="custom-pane" data-testid="custom-pane">
      <div className="custom-side">
        <div className="race-grid scroll-none" role="radiogroup" aria-label="Race">
          {races.map((r) => {
            const target = r.bodies.find((b) => b.model);
            return (
              <button
                key={r.id}
                type="button"
                className={`race-btn${r.id === currentRace?.id ? " on" : ""}${target ? "" : " not-baked"}`}
                disabled={!target}
                aria-label={r.name}
                data-tip={r.name}
                data-tip-sub={target ? undefined : "Not baked yet"}
                onClick={() => { if (target) void setBody(target.id); }}
              >
                <img src={art(r.circle)} alt="" width={50} height={50} loading="lazy" decoding="async" />
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {currentRace?.bodies.map((b) => (
            <button
              key={b.id}
              type="button"
              className={`pill${b.id === body ? " on" : ""}`}
              disabled={!b.model}
              data-tip={b.model ? undefined : "Not baked yet"}
              onClick={() => { if (b.model) void setBody(b.id); }}
            >
              {bodyLabel(b.name, currentRace.name)}
            </button>
          ))}
        </div>
        <div className="flex gap-1.5">
          <button type="button" className="btn" style={{ flex: 1 }} disabled={!common.length} onClick={randomize}><Dices aria-hidden="true" />Randomize</button>
          <button type="button" className="btn" style={{ flex: 1 }} onClick={resetBody}><RotateCcw aria-hidden="true" />Reset</button>
        </div>
      </div>
      <div className="custom-rows scroll-none">
        {offers.map((o) => (
          <div key={o.name} className="card" style={{ padding: "8px 10px" }}>
            <div className="group-label">{o.name}</div>
            <div className="swatches">
              {o.options.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className="swatch"
                  style={{ background: swatchBackground(opt.colors) }}
                  aria-label={opt.name}
                  data-tip={opt.name}
                  onClick={() => { if (opt.group !== undefined && opt.value !== undefined) setAxis(opt.group, opt.value); }}
                />
              ))}
            </div>
          </div>
        ))}
        {common.map((a) => <Stepper key={a.group} name={named(a)} values={a.values} value={valueOf(a)} onChange={(v) => setAxis(a.group, v)} />)}
        {rest.length > 0 && (
          <>
            <button type="button" className="chip" style={{ alignSelf: "flex-start" }} aria-expanded={advanced} onClick={() => setAdvanced((v) => !v)}>Advanced</button>
            {advanced && rest.map((a) => <Stepper key={a.group} name={named(a)} values={a.values} value={valueOf(a)} onChange={(v) => setAxis(a.group, v)} />)}
          </>
        )}
        {!offers.length && !common.length && !rest.length && (
          <div className="notice-center">
            <div className="notice"><div className="notice-title">Nothing to change on this model</div><p className="notice-body">Pick another race to see its options.</p></div>
          </div>
        )}
      </div>
    </div>
  );
}
