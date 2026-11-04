/**
 * Eclipse's Loadout view (UiMorph.cpp DrawLoadoutLibraryView), in its words and order:
 * the library on the left, on the right the banner, the toolbar, the five fact cards
 * and the footer. The figure stays in the room, where every tab has it.
 *
 * What it reads and writes is the game's own share code (lib/share), and nothing else.
 */
import { useStore } from "@nanostores/react";
import { $look, $manifest } from "@eclipse/engine/stores";
import type { SlotId } from "@eclipse/format";
import { ClipboardPaste, Copy, Pencil, Play, Save, Sparkles, Trash2, UserRound, Wand2, Waypoints } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { art, u } from "../../lib/base";
import { $body, $races, $tab, $worn } from "../../lib/room/state";
import { bodyOf, loadoutSummary } from "../../lib/share/bridge";
import { ensureWorn } from "../../lib/share/catalog";
import { decode, encode, looksLikeCode } from "../../lib/share/code";
import {
  $library, $selected, applySelected, composeNow, composeWorn, coverWorn, deleteSaved, importCode, nameTaken, planOf, renameSaved, saveCurrent, selectSaved, type CodePlan,
} from "../../lib/share/live";
import type { Outfit } from "../../lib/share/outfit";
import { $loaded, $pickedMounts } from "../../lib/share/state";
import { SLOT_LABEL } from "../../lib/slots";
import { Modal } from "../ui/kit";

/** Copied text, read back: a browser only lets a page read the clipboard once it's allowed. */
type ClipState = "unknown" | "denied" | "ready";

function Row(props: { name: string; sub: string; cover: string; on: boolean; onClick: () => void; onDouble?: () => void; hint?: string }) {
  return (
    <button
      type="button"
      className={`lo-row${props.on ? " on" : ""}`}
      data-tip={props.name}
      data-tip-sub={props.sub}
      data-tip-hint={props.hint}
      onClick={props.onClick}
      onDoubleClick={props.onDouble}
    >
      <img className="lo-art" src={art(props.cover)} alt="" width={42} height={42} decoding="async" />
      <span className="lo-row-text">
        <span className="lo-row-name">{props.name}</span>
        <span className="lo-row-sub">{props.sub}</span>
      </span>
    </button>
  );
}

function Fact(props: { title: string; value: string; muted: boolean; icon: ReactNode; art?: string; art2?: string; swatch?: string; tip?: string; href?: string }) {
  const inner = (
    <>
      <span className="lo-fact-art">
        {props.art ? <img src={art(props.art)} alt="" width={34} height={34} decoding="async" /> : props.icon}
        {props.art2 && <img className="lo-fact-art2" src={art(props.art2)} alt="" width={34} height={34} decoding="async" />}
      </span>
      <span className="lo-fact-text">
        <span className="lo-fact-title">{props.title}</span>
        <span className="lo-fact-value">{props.value}</span>
      </span>
      {props.swatch && <span className="lo-swatch" style={{ background: props.swatch }} />}
    </>
  );
  const cls = `lo-fact${props.muted ? " muted" : ""}`;
  return props.href
    ? <a className={cls} href={props.href} data-tip={props.title} data-tip-sub={props.tip}>{inner}</a>
    : <div className={cls} data-tip={props.tip ? props.title : undefined} data-tip-sub={props.tip}>{inner}</div>;
}

const hex = (c: number) => `#${c.toString(16).padStart(6, "0")}`;

/** UiMorph.cpp LoadoutEnchantInfo. The site has no enchant table, so a glow is named by its id. */
function glowLabel(o: Outfit, hand: 0 | 1): string {
  const g = o.enchant[hand];
  if (!o.glowKnown || (!g.managed && !g.tint)) return "Unchanged";
  if (g.managed && !g.id) return "No glow";
  if (g.managed) return `Enchant ${g.id}`;
  return "Own glow";
}

function Facts({ o, plan, raceName }: { o: Outfit; plan: CodePlan | null; raceName: string }) {
  const [ground, fly] = plan?.mounts ?? [undefined, undefined];
  const shownMount = o.mountHidden ? undefined : (o.mount ? ground : fly);
  let mountTitle = "MOUNT";
  let mountValue = "Unchanged";
  if (o.mountHidden) mountValue = "Hidden";
  else if (o.mount && o.mountFly && o.mount !== o.mountFly) {
    mountTitle = "GROUND / FLYING";
    mountValue = `${ground?.name ?? "Custom"} / ${fly?.name ?? "Custom"}`;
  } else if (o.mount || o.mountFly) mountValue = (o.mount ? ground : fly)?.name ?? "Custom";
  const skins = o.skin.filter((l) => l.item).length + o.mskin.filter((l) => l.item).length;
  const hasBody = o.look.managed || !!o.rlookKept;
  return (
    <div className="lo-facts" data-testid="lo-facts">
      <Fact
        title={mountTitle}
        value={mountValue}
        muted={mountValue === "Unchanged"}
        icon={<Waypoints aria-hidden="true" />}
        art={(o.mount ? ground : fly)?.icon}
        art2={mountTitle !== "MOUNT" ? fly?.icon : undefined}
        href={shownMount ? `${u("mounts/view/")}?id=${encodeURIComponent(shownMount.id)}&v=${shownMount.display}` : undefined}
        tip={shownMount ? "See it on its stage." : undefined}
      />
      <Fact title="MAIN-HAND GLOW" value={glowLabel(o, 0)} muted={glowLabel(o, 0) === "Unchanged"} icon={<Sparkles aria-hidden="true" />} swatch={o.enchant[0].tint ? hex(o.enchant[0].colour) : undefined} />
      <Fact title="OFF-HAND GLOW" value={glowLabel(o, 1)} muted={glowLabel(o, 1) === "Unchanged"} icon={<Sparkles aria-hidden="true" />} swatch={o.enchant[1].tint ? hex(o.enchant[1].colour) : undefined} />
      <Fact title="SAVED RACE" value={hasBody ? raceName : "Unchanged"} muted={!hasBody} icon={<UserRound aria-hidden="true" />} />
      <Fact title="SKINS" value={skins === 0 ? "None" : skins === 1 ? "1 look" : `${skins} looks`} muted={!skins} icon={<Wand2 aria-hidden="true" />} />
    </div>
  );
}

export function LoadoutPanel() {
  const worn = useStore($worn);
  const body = useStore($body);
  const races = useStore($races);
  const tab = useStore($tab);
  const look = useStore($look);
  const manifest = useStore($manifest);
  const loaded = useStore($loaded);
  const picked = useStore($pickedMounts);
  const library = useStore($library);
  const selected = useStore($selected);

  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [pasted, setPasted] = useState("");
  const [clip, setClip] = useState<{ state: ClipState; text: string }>({ state: "unknown", text: "" });
  const [catalogTick, setCatalogTick] = useState(0);
  const [plan, setPlan] = useState<CodePlan | null>(null);
  const [replace, setReplace] = useState<string | null>(null);
  const [update, setUpdate] = useState(false);
  const [remove, setRemove] = useState(false);
  const [rename, setRename] = useState<string | null>(null);
  const open = tab === "loadout";

  // Every worn slot needs its row, for the entry that goes in the code.
  useEffect(() => {
    if (!open) return;
    let live = true;
    void ensureWorn(worn).then(() => { if (live) setCatalogTick((t) => t + 1); });
    return () => { live = false; };
  }, [open, worn]);

  const chosen = useMemo(() => library.find((l) => l.name === selected) ?? null, [library, selected]);
  const chosenOutfit = useMemo(() => (chosen ? decode(chosen.code) : null), [chosen]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const current = useMemo(() => composeWorn(), [worn, body, look, manifest, loaded, picked, catalogTick, selected]);
  const shown = chosenOutfit ?? current.outfit;

  // What the shown outfit holds beyond what the site can draw.
  useEffect(() => {
    if (!open) return;
    let live = true;
    void planOf(shown).then((p) => { if (live) setPlan(p); });
    return () => { live = false; };
  }, [open, shown]);

  // Each worn piece the game has no row for carries a small mark on the ring.
  const missing = chosen ? [] : current.notExportable;
  const missingKey = missing.join(",");
  useEffect(() => {
    const set = new Set(missingKey ? missingKey.split(",") : []);
    for (const b of document.querySelectorAll<HTMLElement>("[data-ring]")) b.toggleAttribute("data-no-export", set.has(b.dataset.ring!));
  }, [missingKey]);

  // Import lights up when the clipboard holds a code, where a browser lets a page look.
  const readClip = async (ask: boolean) => {
    const cb = navigator.clipboard;
    if (!cb?.readText) return setClip({ state: "denied", text: "" });
    try {
      if (!ask) {
        const perm = await navigator.permissions?.query({ name: "clipboard-read" as PermissionName });
        if (perm?.state !== "granted") return setClip({ state: perm?.state === "denied" ? "denied" : "unknown", text: "" });
      }
      setClip({ state: "ready", text: await cb.readText() });
    } catch {
      setClip((c) => ({ state: ask ? "denied" : c.state, text: "" }));
    }
  };
  const readClipRef = useRef(readClip);
  readClipRef.current = readClip;
  useEffect(() => {
    if (!open) return;
    void readClipRef.current(false);
    const again = () => { void readClipRef.current(false); };
    addEventListener("focus", again);
    return () => removeEventListener("focus", again);
  }, [open]);

  const code = pasted && looksLikeCode(pasted) ? pasted : clip.state === "ready" && looksLikeCode(clip.text) ? clip.text : "";
  // Until the browser has been asked there is no knowing what it holds, and the click is what asks.
  const canImport = !!code || (clip.state === "unknown" && !!navigator.clipboard?.readText);

  const doImport = async () => {
    let text = code;
    if (!text && navigator.clipboard?.readText) {
      try {
        text = await navigator.clipboard.readText();
        setClip({ state: "ready", text });
      } catch {
        setClip({ state: "denied", text: "" });
      }
    }
    if (!looksLikeCode(text)) {
      setNote(text ? "That is not an Eclipse loadout code." : "Copy an Eclipse loadout code first.");
      return;
    }
    const r = await importCode(text);
    setNote(r.note);
    if (r.ok) setPasted("");
  };
  const share = async () => {
    const text = chosen ? chosen.code : encode(composeNow().outfit);
    try {
      await navigator.clipboard.writeText(text);
      setNote(chosen ? "Code copied - paste it to share this loadout." : "Code copied - paste it to share your current look.");
    } catch {
      // A browser refused: the code goes where it can be copied by hand.
      setPasted(text);
      setNote("Copy the code from the box above.");
    }
  };

  const race = useMemo(() => races.find((r) => r.bodies.some((b) => b.id === body)), [races, body]);
  const shownRaceName = useMemo(() => {
    const b = bodyOf(shown, (id) => races.some((r) => r.bodies.some((x) => x.id === id)));
    const name = races.find((r) => r.id === b?.race)?.name ?? b?.race ?? race?.name ?? "";
    return `${name} ${b?.sex === "f" ? "female" : "male"}`;
  }, [shown, races, race]);
  const coverNow = coverWorn();
  const key = name.trim();
  const canSave = !!key;
  const save = () => {
    if (nameTaken(key)) return setReplace(key);
    const r = saveCurrent(key);
    if (r.ok) {
      void selectSaved(r.name);
      setName("");
      setNote("Loadout saved.");
    }
  };

  const title = chosen?.name ?? "Current look";
  const kept = plan?.outfit === shown ? plan.kept : null;

  return (
    <div className="lo" data-testid="loadout-panel">
      <div className="browse-row lo-rail"><span className="pill sm on" data-tip="Loadouts" data-tip-sub="Your saved looks. Preview one on the figure, then wear it.">Loadouts</span></div>
      <hr className="rule" />
      <div className="lo-split">
        <div className="lo-lib">
          <div className="lo-caption">LOADOUTS</div>
          <div className="lo-rows scroll-none" data-testid="lo-rows">
            <Row name="Current look" sub="What you are wearing" cover={coverNow} on={!chosen} onClick={() => { setNote(""); void selectSaved(null); }} />
            <hr className="rule lo-rule" />
            {library.map((l) => (
              <Row
                key={l.name}
                name={l.name}
                sub={loadoutSummary(decode(l.code) ?? current.outfit)}
                cover={l.cover}
                on={l.name === selected}
                hint="Double-click to apply"
                onClick={() => { setNote(""); void selectSaved(l.name); }}
                onDouble={() => { void applySelected().then(() => setNote("Loadout applied.")); }}
              />
            ))}
            {!library.length && <p className="lo-empty">Build a look in Wardrobe, then save it below.</p>}
          </div>
          <hr className="rule lo-rule" />
          <input
            className="field"
            type="text"
            placeholder="New loadout name"
            aria-label="New loadout name"
            value={name}
            maxLength={63}
            spellCheck={false}
            autoComplete="off"
            data-testid="lo-name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && canSave) save(); }}
          />
          <span data-tip={canSave ? "Save the current complete look." : "Name the loadout first."} className="lo-tipwrap">
            <button type="button" className="btn fill block" disabled={!canSave} onClick={save} data-testid="lo-save"><Save aria-hidden="true" />Save current loadout</button>
          </span>
        </div>

        <div className="lo-view">
          <div className="lo-banner card">
            <img className="lo-art big" src={art(chosen ? chosen.cover : coverNow)} alt="" width={42} height={42} decoding="async" />
            <div className="lo-banner-text">
              <div className="lo-banner-name" data-testid="lo-title">{title}</div>
              <div className="lo-banner-sub" data-testid="lo-summary">{loadoutSummary(shown)}</div>
            </div>
          </div>

          <div className="lo-tools">
            <div className="lo-tool-group" style={{ visibility: chosen ? "visible" : "hidden" }}>
              <button type="button" className="btn" disabled={!chosen} onClick={() => setRename(chosen?.name ?? "")} data-testid="lo-rename"><Pencil aria-hidden="true" />Rename</button>
              <button type="button" className="btn" disabled={!chosen} onClick={() => setUpdate(true)} data-testid="lo-update"><Save aria-hidden="true" />Update current</button>
              <button type="button" className="btn danger" disabled={!chosen} onClick={() => setRemove(true)} data-testid="lo-delete"><Trash2 aria-hidden="true" />Delete</button>
            </div>
            <div className="lo-tool-group">
              <button
                type="button"
                className="btn"
                onClick={() => { void share(); }}
                data-testid="lo-share"
                data-tip="Share"
                data-tip-sub={chosen ? "Copy this loadout as one line of text." : "Copy the look you are wearing as one line of text."}
              ><Copy aria-hidden="true" />Share</button>
              <span className="lo-tipwrap" data-tip="Import" data-tip-sub={canImport ? "Wear the loadout code on your clipboard." : "Copy an Eclipse loadout code first."}>
                <button type="button" className="btn" disabled={!canImport} onClick={() => { void doImport(); }} data-testid="lo-import"><ClipboardPaste aria-hidden="true" />Import</button>
              </span>
              <input
                className="field lo-paste"
                type="text"
                placeholder="Paste a code"
                aria-label="Paste a loadout code"
                value={pasted}
                spellCheck={false}
                autoComplete="off"
                data-testid="lo-paste"
                onChange={(e) => setPasted(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && code) void doImport(); }}
              />
            </div>
          </div>

          <Facts o={shown} plan={plan?.outfit === shown ? plan : null} raceName={shownRaceName} />

          <div className="lo-marks">
            <span className="lo-kept" data-testid="lo-kept" hidden={!kept?.count} data-tip={`${kept?.count ?? 0} kept in the code`} data-tip-sub={kept?.parts.join(", ")}>
              {kept?.count ?? 0} more in this code, not drawn here
            </span>
            <span className="lo-missing" data-testid="lo-missing" hidden={!missing.length} data-tip="Not in the code" data-tip-sub={`${missing.map((s: SlotId) => SLOT_LABEL[s]).join(", ")}: the game has no such item.`}>
              {missing.length} piece{missing.length === 1 ? "" : "s"} can't go to the game
            </span>
          </div>

          <div className="lo-foot">
            {chosen
              ? <button type="button" className="btn fill block lo-apply" onClick={() => { void applySelected().then(() => setNote("Loadout applied - equipment, mount, glows and saved race.")); }} data-testid="lo-apply"><Play aria-hidden="true" />Apply loadout</button>
              : <p className="lo-note">Select a saved loadout to preview it.</p>}
            <p className="lo-note" data-testid="lo-note" aria-live="polite">{note}</p>
            <p className="lo-help">In game: copy a code, then Wardrobe &gt; Loadout &gt; Import.</p>
            <p className="lo-help">No race pack? They wear the closest normal race.</p>
          </div>
        </div>
      </div>

      <Modal
        open={!!replace}
        onOpenChange={(o) => { if (!o) setReplace(null); }}
        title="Replace this loadout?"
        foot={<>
          <button className="btn" type="button" onClick={() => setReplace(null)}>Cancel</button>
          <button className="btn fill" type="button" data-testid="lo-confirm" onClick={() => {
            const r = saveCurrent(replace!);
            setReplace(null);
            if (r.ok) { void selectSaved(r.name); setName(""); setNote("Loadout updated."); }
          }}>Replace</button>
        </>}
      >
        <p className="lo-dlg">"{replace}" already exists. Replace it with your current complete look? Its assigned icon will be kept.</p>
      </Modal>
      <Modal
        open={update}
        onOpenChange={setUpdate}
        title="Update this loadout?"
        foot={<>
          <button className="btn" type="button" onClick={() => setUpdate(false)}>Cancel</button>
          <button className="btn fill" type="button" data-testid="lo-confirm" onClick={() => {
            setUpdate(false);
            if (chosen) { saveCurrent(chosen.name); setNote("Loadout updated."); }
          }}>Update</button>
        </>}
      >
        <p className="lo-dlg">Replace "{chosen?.name}" with everything you are wearing now? The saved equipment, mount, glows and race will be replaced.</p>
      </Modal>
      <Modal
        open={remove}
        onOpenChange={setRemove}
        title="Delete this loadout?"
        foot={<>
          <button className="btn" type="button" onClick={() => setRemove(false)}>Cancel</button>
          <button className="btn danger" type="button" data-testid="lo-confirm" onClick={() => {
            setRemove(false);
            if (chosen) { deleteSaved(chosen.name); setNote("Loadout deleted."); }
          }}>Delete</button>
        </>}
      >
        <p className="lo-dlg">Delete "{chosen?.name}"? What you are wearing will not change.</p>
      </Modal>
      <Modal
        open={rename !== null}
        onOpenChange={(o) => { if (!o) setRename(null); }}
        title="Rename this loadout"
        foot={<>
          <button className="btn" type="button" onClick={() => setRename(null)}>Cancel</button>
          <button className="btn fill" type="button" data-testid="lo-confirm" onClick={() => {
            if (chosen && renameSaved(chosen.name, rename ?? "")) setRename(null);
          }}>Rename</button>
        </>}
      >
        <input className="field" type="text" aria-label="Loadout name" value={rename ?? ""} maxLength={63} data-testid="lo-rename-field" onChange={(e) => setRename(e.target.value)} />
      </Modal>
    </div>
  );
}
