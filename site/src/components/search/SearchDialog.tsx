/**
 * Search with no server: the index is fetched once, on first open, and filtered in
 * the browser on every keystroke with no debounce.
 */
import { packUrl, paths, type SearchRow } from "@eclipse/format";
import { Command } from "cmdk";
import { Search } from "lucide-react";
import { Dialog } from "radix-ui";
import { useEffect, useMemo, useState } from "react";
import { art, PACK_BASE, u, wardrobeHref } from "../../lib/base";
import { filterRows, indexRows, type IndexedRow } from "./filter";

let setOpenExternal: ((f: (o: boolean) => boolean) => void) | null = null;
export const toggleOpen = () => setOpenExternal?.((o) => !o);

let indexPromise: Promise<IndexedRow[]> | null = null;
function loadIndex(): Promise<IndexedRow[]> {
  indexPromise ??= fetch(packUrl(PACK_BASE, paths.search()))
    .then((r) => {
      if (!r.ok) throw new Error(String(r.status));
      return r.json() as Promise<SearchRow[]>;
    })
    .then(indexRows)
    .catch((e) => {
      indexPromise = null;
      throw e;
    });
  return indexPromise;
}

const hrefOf = (r: SearchRow) => {
  if (r.g === "race") return u(`races/${r.i}/`);
  if (r.g === "item" || r.g === "set") return `${u("wardrobe/")}?try=${encodeURIComponent(r.i)}${r.g === "set" ? "&tab=sets" : ""}`;
  return wardrobeHref(r.i);
};
const KIND: Record<SearchRow["g"], string> = { race: "Race", body: "Body", mount: "Mount", item: "Item", set: "Set" };

export function SearchDialog({ initiallyOpen }: { initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(!!initiallyOpen);
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<IndexedRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState("");

  useEffect(() => {
    setOpenExternal = setOpen;
    return () => { setOpenExternal = null; };
  }, []);
  useEffect(() => {
    if (!open || rows) return;
    setFailed(false);
    loadIndex().then(setRows).catch(() => setFailed(true));
  }, [open, rows]);

  const results = useMemo(() => (rows ? filterRows(rows, query) : []), [rows, query]);
  useEffect(() => { setSelected(results[0] ? `${results[0].g}-${results[0].i}` : ""); }, [results]);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="dlg-scrim" />
        <Dialog.Content className="search-dlg" aria-describedby={undefined} data-testid="search-dialog">
          <Dialog.Title className="sr-only">Search</Dialog.Title>
          <Command shouldFilter={false} value={selected} onValueChange={setSelected}>
            <div className="search-head">
              <Search aria-hidden="true" />
              <Command.Input value={query} onValueChange={setQuery} placeholder="Search races, mounts and items" autoFocus maxLength={40} />
            </div>
            <Command.List className="search-list">
              {!query && <div className="search-empty">Type a name.</div>}
              {query && failed && <div className="search-empty">Search isn't available right now.</div>}
              {query && !failed && !rows && <div className="search-empty">Searching</div>}
              {query && rows && results.length === 0 && <div className="search-empty">Nothing found.</div>}
              {results.map((r) => {
                const href = hrefOf(r);
                return (
                  <Command.Item
                    key={`${r.g}-${r.i}`}
                    value={`${r.g}-${r.i}`}
                    className="search-row"
                    onSelect={() => { location.href = href; }}
                  >
                    <a href={href} aria-label={r.n} data-astro-prefetch onClick={(e) => e.stopPropagation()} />
                    <img src={art(r.c)} alt="" width={40} height={40} loading="lazy" decoding="async" />
                    <div>
                      <b>{r.n}</b>
                      <small data-g={r.g}>{KIND[r.g]}</small>
                    </div>
                  </Command.Item>
                );
              })}
            </Command.List>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
