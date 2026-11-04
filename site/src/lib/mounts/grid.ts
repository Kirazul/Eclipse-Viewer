/**
 * The Mounts page: a named circle per animal, as Eclipse's list (UiMounts.cpp). The rows
 * come from `catalog/mounts.json` on the client, so a new bake needs no new page, and
 * nothing here loads a model: browsing is free, and the stage opens on a click.
 */
import { packUrl, paths, type MountEntry } from "@eclipse/format";
import { art, PACK_BASE, u } from "../base";

const root = document.getElementById("mount-grid") as HTMLElement;
const input = document.getElementById("mount-q") as HTMLInputElement;
const countEl = document.getElementById("mount-count") as HTMLElement;
const chips = document.getElementById("mount-chips") as HTMLElement;
const STARS_KEY = "starred-mounts";

let all: MountEntry[] = [];
let category = "all";
let stars = new Set<string>();
try { stars = new Set(JSON.parse(localStorage.getItem(STARS_KEY) || "[]")); } catch { /* private window */ }

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

function render() {
  const q = fold(input.value.trim());
  const shown = all.filter((m) => {
    if (q && !fold(m.name).includes(q) && !m.variants.some((v) => fold(v.name).includes(q))) return false;
    if (category === "ground") return !m.flying;
    if (category === "flying") return m.flying;
    if (category === "starred") return stars.has(m.id);
    return true;
  });
  countEl.textContent = shown.length.toLocaleString("en-US");
  const groups = new Map<string, MountEntry[]>();
  for (const m of shown) {
    const k = m.name.charAt(0).toUpperCase();
    const list = groups.get(k);
    if (list) list.push(m);
    else groups.set(k, [m]);
  }
  if (!shown.length) {
    root.innerHTML = `<div class="notice"><div class="notice-title"></div><p class="notice-body"></p></div>`;
    root.querySelector(".notice-title")!.textContent = all.length ? "No mounts match" : "Mounts are on their way";
    root.querySelector(".notice-body")!.textContent = all.length ? "Clear the search or choose another filter." : "They show up here as soon as they are baked.";
    return;
  }
  const page = document.createElement("div");
  page.className = "page-card";
  for (const [letter, list] of groups) {
    const section = document.createElement("section");
    section.className = "letter-group";
    const head = document.createElement("div");
    head.className = "letter";
    head.textContent = letter;
    const grid = document.createElement("div");
    grid.className = "circle-grid";
    for (const m of list) {
      const a = document.createElement("a");
      a.className = "circle-link";
      a.href = `${u("mounts/view/")}?id=${encodeURIComponent(m.id)}`;
      a.dataset.mount = m.id;
      const img = document.createElement("img");
      img.src = art(m.circle);
      img.alt = "";
      img.width = 50;
      img.height = 50;
      img.loading = "lazy";
      img.decoding = "async";
      const label = document.createElement("span");
      label.className = "circle-name";
      label.textContent = m.name;
      a.append(img, label);
      if (m.variants.length > 1) {
        const n = document.createElement("span");
        n.className = "circle-count";
        n.textContent = String(m.variants.length);
        n.title = `${m.variants.length} colours`;
        a.append(n);
      }
      grid.append(a);
    }
    section.append(head, grid);
    page.append(section);
  }
  root.replaceChildren(page);
}

input.addEventListener("input", render);
chips.addEventListener("click", (e) => {
  const c = (e.target as Element).closest<HTMLElement>("[data-cat]");
  if (!c) return;
  category = c.dataset.cat!;
  for (const b of chips.querySelectorAll<HTMLElement>("[data-cat]")) b.classList.toggle("on", b === c);
  render();
});

fetch(packUrl(PACK_BASE, paths.mounts()))
  .then((r) => (r.ok ? (r.json() as Promise<MountEntry[]>) : []))
  .catch(() => [] as MountEntry[])
  .then((list) => {
    all = list;
    render();
  });
