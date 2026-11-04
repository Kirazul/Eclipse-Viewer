/**
 * Customization, after Eclipse's UiCustom.cpp: race portraits, form and sex on one side,
 * retail's own tabs and options on the other. Every row is what retail authors for this
 * body, in retail's order and names. Nothing else can be reached: a look is option ->
 * choice, never a geoset number.
 */
import { useStore } from "@nanostores/react";
import { $customization, $look, $manifest } from "@eclipse/engine/stores";
import { classTag, encodeLook, randomLook, type CustomChoice, type CustomOption, type CustomTab, type Look } from "@eclipse/format";
import { ChevronLeft, ChevronRight, Dices, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { art } from "../../lib/base";
import { setBody } from "../../lib/room/actions";
import { $body, $engine, $lookText, $races, $tab, type RoomRace } from "../../lib/room/state";
import { hideTip, showTip } from "../../lib/tip";

/** Worgen and Dracthyr keep a second form on the same portrait, retail's toggle under the race. */
const FORM_OF: Record<string, string> = { gilnean: "worgen", visage: "dracthyr" };
const FORMS: Record<string, string> = { worgen: "gilnean", dracthyr: "visage" };

/** Upright Orc and Mag'har are a choice on the race's own options, never a body of their own here. */
const isPosture = (b: { id: string }) => /upright-/.test(b.id);
const sexOf = (id: string): "male" | "female" => (id.endsWith("-female") ? "female" : "male");
const raceKeyOf = (races: readonly RoomRace[], bodyId: string) => races.find((r) => r.bodies.some((b) => b.id === bodyId));

function hasArt(c: CustomChoice) {
  return !!(c.mat?.length || c.geo?.length || c.pgeo?.length);
}

/** "Face (Undead)" reads Face; retail's "Mirror" (the barber's close-up details) reads Details. */
function tabLabel(name: string) {
  const n = name.split(" (")[0]!;
  if (n === "Mirror") return "Details";
  return n || "Options";
}

/**
 * A colour row, as retail shows it: its first real choice is a colour. Retail hides the
 * swatchless ones in such a row until they are unlocked (a Death Knight's eyes, a special
 * skin); unlocked here, they stand among the colours as a numbered cell.
 */
function isSwatchRow(o: CustomOption) {
  return !!o.choices.find(hasArt)?.sw?.length;
}

function swatchBackground(sw?: string[]) {
  if (!sw?.length) return undefined;
  if (sw.length === 1) return sw[0];
  return `linear-gradient(to right bottom,${sw[0]} 50%,${sw[1]} 50.3%)`;
}

function tipFor(c: CustomChoice, fallback: string) {
  return { name: c.name || fallback, cls: classTag(c.cls) };
}

function wear(look: Look, o: CustomOption, c: CustomChoice) {
  const engine = $engine.get();
  if (!engine || look[o.id] === c.id) return;
  void engine.setLook({ ...look, [o.id]: c.id });
}

function SwatchRow({ o, look, onPick }: { o: CustomOption; look: Look; onPick: (c: CustomChoice) => void }) {
  const at = o.choices.findIndex((c) => c.id === look[o.id]);
  const cur = o.choices[Math.max(0, at)]!;
  return (
    <div className="opt-row" data-option={o.id} data-kind="swatch">
      <div className="opt-head">
        <span className="opt-name">{o.name}</span>
        <span className="opt-value">{!hasArt(cur) && !cur.sw?.length ? "Off" : cur.name || `${Math.max(0, at) + 1} of ${o.choices.length}`}</span>
      </div>
      <div className="swatches sm">
        {o.choices.map((c, i) => {
          const off = !c.sw?.length && !hasArt(c);
          const tip = tipFor(c, off ? "Off" : `${o.name} ${i + 1}`);
          return (
            <button
              key={c.id}
              type="button"
              className={`swatch sm${c.id === cur.id ? " on" : ""}${off ? " off" : ""}`}
              style={{ background: swatchBackground(c.sw) }}
              aria-label={tip.name}
              aria-pressed={c.id === cur.id}
              data-choice={c.id}
              onPointerEnter={() => {
                showTip(tip.name, tip.cls || undefined);
                $engine.get()?.prefetchLook({ ...look, [o.id]: c.id });
              }}
              onPointerLeave={hideTip}
              onClick={() => onPick(c)}
            >
              {c.sw?.length || off ? null : i + 1}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Named choices: arrows and a track, every stop a real choice. */
function StepRow({ o, look, onPick }: { o: CustomOption; look: Look; onPick: (c: CustomChoice) => void }) {
  const n = o.choices.length;
  const at = Math.max(0, o.choices.findIndex((c) => c.id === look[o.id]));
  const cur = o.choices[at]!;
  const step = (d: number) => o.choices[(at + d + n) % n]!;
  const warm = (c: CustomChoice) => $engine.get()?.prefetchLook({ ...look, [o.id]: c.id });
  const single = n <= 1;
  const label = (c: CustomChoice, i: number) => c.name || `${o.name} ${i + 1}`;
  const tag = classTag(cur.cls);
  return (
    <div className="opt-row" data-option={o.id} data-kind="step">
      <div className="opt-head">
        <span className="opt-name">{o.name}</span>
        {tag ? <span className="opt-value quiet">{tag}</span> : null}
      </div>
      <div className="opt-step">
        <button type="button" className="btn opt-arrow" disabled={single} aria-label={`Previous ${o.name}`} onPointerEnter={() => warm(step(-1))} onClick={() => onPick(step(-1))}>
          <ChevronLeft aria-hidden="true" />
        </button>
        <div
          className="opt-track"
          role="slider"
          aria-label={o.name}
          aria-valuemin={1}
          aria-valuemax={n}
          aria-valuenow={at + 1}
          aria-valuetext={label(cur, at)}
          tabIndex={0}
          data-choice={cur.id}
          style={{ "--at": (at + 0.5) / n, "--seg": 1 / n } as React.CSSProperties}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") onPick(step(-1));
            else if (e.key === "ArrowRight") onPick(step(1));
            else return;
            e.preventDefault();
            e.stopPropagation();
          }}
          onPointerMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const i = Math.min(n - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * n)));
            const c = o.choices[i]!;
            showTip(label(c, i), classTag(c.cls) || undefined);
            warm(c);
          }}
          onPointerLeave={hideTip}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            onPick(o.choices[Math.min(n - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * n)))]!);
          }}
        >
          <span className="opt-track-name">{label(cur, at)}</span>
        </div>
        <button type="button" className="btn opt-arrow" disabled={single} aria-label={`Next ${o.name}`} onPointerEnter={() => warm(step(1))} onClick={() => onPick(step(1))}>
          <ChevronRight aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

/**
 * Retail's creator: Alliance left, Horde right, each a column of core races beside a
 * column of allied races, mirrored so the allied columns meet in the middle. A race both
 * factions play stands in both. Forms and postures are not portraits.
 */
function RaceGrid({ races, currentId, sex, onPick }: { races: readonly RoomRace[]; currentId: string; sex: "male" | "female"; onPick: (r: RoomRace) => void }) {
  const cols = useMemo(() => {
    const out: RoomRace[][] = [[], [], [], []];
    for (const r of races) {
      if (FORM_OF[r.id] || !r.bodies.some((b) => b.model && !isPosture(b))) continue;
      const allied = r.group === "Allied";
      if (r.faction !== "Horde") out[allied ? 1 : 0]!.push(r);
      if (r.faction !== "Alliance") out[allied ? 2 : 3]!.push(r);
    }
    return out;
  }, [races]);
  const portrait = (r: RoomRace) => r.bodies.find((b) => b.id === `${r.id}-${sex}`)?.circle || r.circle;
  return (
    <div className="race-columns">
      <div className="race-caption"><span>Alliance</span><span>Horde</span></div>
      <div className="race-grid4 scroll-none" role="radiogroup" aria-label="Race">
        {cols.map((list, i) => (
          <div key={i} className={`race-col${i === 2 ? " gap-left" : ""}`}>
            {list.map((r) => (
              <button
                key={`${r.id}-${i}`}
                type="button"
                role="radio"
                aria-checked={r.id === currentId}
                className={`race-btn${r.id === currentId ? " on" : ""}`}
                aria-label={r.name}
                data-race={r.id}
                data-tip={r.name}
                onClick={() => onPick(r)}
              >
                <img src={art(portrait(r))} alt="" width={44} height={44} loading="lazy" decoding="async" />
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function CustomPanel() {
  const manifest = useStore($manifest);
  const data = useStore($customization);
  const look = useStore($look);
  const races = useStore($races);
  const body = useStore($body);
  const engine = useStore($engine);
  const tab = useStore($tab);
  const [tabId, setTabId] = useState<number | null>(null);

  // Fetched when this tab opens, never on first load: its data is the size of a texture.
  const wanted = tab === "customization" && !!manifest?.customization;
  useEffect(() => {
    if (wanted && engine && (!data || data.id !== manifest?.id)) void engine.loadCustomization();
  }, [wanted, engine, data, manifest?.id]);

  // The address bar holds the choices, and only those that differ from the first look.
  useEffect(() => {
    if (!look || !manifest?.look) return;
    $lookText.set(encodeLook(look, manifest.look));
  }, [look, manifest?.look]);

  const current = useMemo(() => {
    const r = raceKeyOf(races, body) ?? races[0];
    return r && FORM_OF[r.id] ? (races.find((x) => x.id === FORM_OF[r.id]) ?? r) : r;
  }, [races, body]);
  const sex = sexOf(body);

  const tabs: CustomTab[] = data?.tabs ?? [];
  const activeTab = tabs.find((t) => t.id === tabId)?.id ?? tabs[0]?.id ?? null;
  const options = useMemo(() => (data?.options ?? []).filter((o) => o.tab === activeTab), [data, activeTab]);
  useEffect(() => setTabId(null), [manifest?.id]);

  const raceOf = (r: RoomRace, s: "male" | "female") => r.bodies.find((b) => b.id === `${r.id}-${s}` && b.model) ?? r.bodies.find((b) => b.model && !isPosture(b));
  const pickRace = (r: RoomRace) => {
    const b = raceOf(r, sex);
    if (b) void setBody(b.id);
  };
  const form = current && FORMS[current.id] ? races.find((r) => r.id === FORMS[current.id]) : undefined;
  const shownRace = raceKeyOf(races, body);

  const pick = (o: CustomOption, c: CustomChoice) => {
    if (!look) return;
    // A posture is a body: the look moves over whole, as both offer the same options.
    if (c.body && c.body !== body) {
      void setBody(c.body, encodeLook({ ...look, [o.id]: c.id }, manifest?.look ?? {}));
      return;
    }
    wear(look, o, c);
  };
  const randomize = () => {
    if (data && look) void engine?.setLook(randomLook(data.options, look));
  };
  const reset = () => {
    if (manifest?.look) void engine?.setLook(manifest.look);
  };

  if (!manifest) {
    return (
      <div className="notice-center">
        <div className="notice"><div className="notice-title">Getting your character ready</div><p className="notice-body">This fills in by itself in a moment.</p></div>
      </div>
    );
  }

  return (
    <div className="custom-pane" data-testid="custom-pane">
      <div className="custom-side">
        <RaceGrid races={races} currentId={current?.id ?? ""} sex={sex} onPick={pickRace} />
        {form && form.bodies.some((b) => b.model) ? (
          <div className="custom-group">
            <div className="group-label">Form</div>
            <div className="pill-row">
              {[current!, form].map((r) => {
                const on = shownRace?.id === r.id;
                const label = r.name.match(/\((.*)\)/)?.[1] ?? r.name;
                const target = raceOf(r, sex);
                return (
                  <button key={r.id} type="button" className={`pill${on ? " on" : ""}`} disabled={!target} data-form={r.id} onClick={() => { if (target) void setBody(target.id); }}>
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
        <div className="custom-group">
          <div className="group-label">Gender</div>
          <div className="pill-row">
            {(["male", "female"] as const).map((s) => {
              const r = shownRace ?? current;
              const target = r?.bodies.find((b) => b.id === `${r.id}-${s}` && b.model);
              return (
                <button key={s} type="button" className={`pill${sex === s ? " on" : ""}`} disabled={!target} data-sex={s} onClick={() => { if (target) void setBody(target.id); }}>
                  {s === "male" ? "Male" : "Female"}
                </button>
              );
            })}
          </div>
        </div>
      </div>
      <div className="custom-main">
        {tabs.length > 1 ? (
          <div className="pill-row custom-tabs" role="tablist" aria-label="Customization category">
            {tabs.map((t) => (
              <button key={t.id} type="button" role="tab" aria-selected={t.id === activeTab} className={`pill${t.id === activeTab ? " on" : ""}`} data-custom-tab={t.id} onClick={() => setTabId(t.id)}>
                {tabLabel(t.name)}
              </button>
            ))}
          </div>
        ) : null}
        <div className="custom-rows scroll-none" key={activeTab ?? 0}>
          {look && data
            ? options.map((o) => (isSwatchRow(o) ? <SwatchRow key={o.id} o={o} look={look} onPick={(c) => pick(o, c)} /> : <StepRow key={o.id} o={o} look={look} onPick={(c) => pick(o, c)} />))
            : null}
          {!manifest.customization ? (
            <div className="notice-center">
              <div className="notice"><div className="notice-title">Nothing to change on this model</div><p className="notice-body">Pick a race to see its options.</p></div>
            </div>
          ) : null}
        </div>
        <div className="custom-foot">
          <button type="button" className="btn" disabled={!data} onClick={randomize}><Dices aria-hidden="true" />Randomize</button>
          <button type="button" className="btn" disabled={!data} onClick={reset}><RotateCcw aria-hidden="true" />Reset</button>
        </div>
      </div>
    </div>
  );
}
