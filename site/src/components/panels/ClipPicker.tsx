/** The clip combobox: T-Pose pinned first, then every clip; the playlist sits in a side panel. */
import { useStore } from "@nanostores/react";
import { $clipLoading, $clips, $currentClip } from "@eclipse/engine/stores";
import type { ClipEntry } from "@eclipse/format";
import { Command } from "cmdk";
import { Check, ChevronsUpDown, ListMusic, Search, Trash2, X } from "lucide-react";
import { Popover } from "radix-ui";
import { useEffect, useRef, useState } from "react";
import { $engine } from "../../lib/room/state";

const TPOSE = "T-Pose";

export function clipLabel(c: ClipEntry): string {
  return c.variation ? `${c.name} ${c.variation + 1}` : c.name;
}

export function ClipPicker() {
  const clips = useStore($clips);
  const current = useStore($currentClip);
  const loading = useStore($clipLoading);
  const engine = useStore($engine);
  const [open, setOpen] = useState(false);
  const [listMode, setListMode] = useState(false);
  const [queue, setQueue] = useState<string[]>([]);
  const started = useRef(false);

  // The queue drives the engine's chain: one clip just plays, two or more chain.
  useEffect(() => {
    if (!engine || !listMode) return;
    if (queue.length === 0) {
      engine.stopPlaylistChain();
      started.current = false;
    } else if (queue.length === 1) {
      void engine.playAnimationByName(queue[0]!);
      started.current = false;
    } else if (!started.current) {
      void engine.playPlaylist(queue);
      started.current = true;
    } else {
      engine.updatePlaylist(queue);
    }
  }, [queue, listMode, engine]);

  const labelOf = (id: string | null) => {
    if (!id || id === TPOSE) return TPOSE;
    const c = clips.find((x) => x.id === id);
    return c ? clipLabel(c) : TPOSE;
  };
  const toggleList = () => {
    if (listMode) {
      engine?.stopPlaylistChain();
      setQueue([]);
      setListMode(false);
    } else {
      setQueue(current && current !== TPOSE ? [current] : []);
      setListMode(true);
    }
  };
  const choose = (id: string) => {
    if (listMode) {
      if (id !== TPOSE) setQueue((q) => [...q, id]);
      return;
    }
    void engine?.playAnimationByName(id);
    setOpen(false);
  };
  const rows: { id: string; label: string }[] = [
    { id: TPOSE, label: TPOSE },
    ...[...clips].sort((a, b) => clipLabel(a).localeCompare(clipLabel(b), undefined, { numeric: true })).map((c) => ({ id: c.id, label: clipLabel(c) })),
  ];

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button className="btn" type="button" role="combobox" aria-expanded={open} aria-label="Animations" style={{ width: "100%", justifyContent: "space-between", minWidth: 0 }} disabled={!engine}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", color: loading ? "var(--accent-ink)" : undefined }}>{labelOf(current)}</span>
          <ChevronsUpDown style={{ opacity: .5 }} aria-hidden="true" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="pop clip-pop" sideOffset={6} align="start" collisionPadding={8}>
          <Command className="clip-cmd" loop>
            <div className="clip-head">
              <Search aria-hidden="true" />
              <Command.Input placeholder="Search animations" autoFocus />
              <button type="button" className="tool" style={{ width: 26, height: 26, color: listMode ? "var(--accent-ink)" : undefined }} onClick={toggleList} aria-pressed={listMode} aria-label="Playlist" data-tip="Playlist" data-tip-sub="Play clips one after another">
                <ListMusic aria-hidden="true" />
              </button>
            </div>
            <Command.List className="clip-list">
              <Command.Empty className="clip-empty">No animations found.</Command.Empty>
              {rows.map((r) => (
                <Command.Item
                  key={r.id}
                  value={`${r.label} ${r.id}`}
                  className={`clip-row${current === r.id || (!current && r.id === TPOSE) ? " cur" : ""}${queue.includes(r.id) ? " queued" : ""}`}
                  onSelect={() => choose(r.id)}
                >
                  <Check aria-hidden="true" />
                  <span>{r.label}</span>
                </Command.Item>
              ))}
            </Command.List>
          </Command>
          {listMode && (
            <div className="playlist" data-testid="playlist">
              <div className="playlist-head">
                <span>Playlist <span style={{ color: "var(--ink-dim)", fontSize: 12 }}>{queue.length}</span></span>
                {queue.length > 0 && (
                  <button type="button" className="tool" style={{ width: 24, height: 24 }} onClick={() => setQueue([])} aria-label="Clear playlist"><Trash2 aria-hidden="true" /></button>
                )}
              </div>
              {queue.length === 0 ? (
                <div className="playlist-empty">Pick clips on the left to line them up.</div>
              ) : (
                <div className="playlist-list">
                  {queue.map((id, i) => (
                    <div key={`${id}-${i}`} className={`playlist-row${current === id ? " cur" : ""}`}>
                      <i>{i + 1}</i>
                      <button type="button" onClick={() => (queue.length > 1 ? engine?.jumpChainTo(i + 1) : engine?.playAnimationByName(id))}>{labelOf(id)}</button>
                      <button type="button" aria-label="Remove" onClick={() => setQueue((q) => q.filter((_, k) => k !== i))}><X aria-hidden="true" /></button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
