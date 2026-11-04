/**
 * The whole of the JavaScript a list page runs: theme, drawer, full screen, the
 * tooltip, and the search dialog, which is imported only when first asked for.
 */
import { initTips } from "./tip";

const root = document.documentElement;

// The theme switch repaints every surface in one frame; no element fades on its own.
export function setTheme(value: "dark" | "light" | "auto") {
  root.classList.add("no-tr");
  const light = value === "light" || (value === "auto" && matchMedia("(prefers-color-scheme: light)").matches);
  root.dataset.theme = light ? "light" : "dark";
  try { localStorage.setItem("theme", value); } catch { /* private window */ }
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("no-tr")));
}

document.getElementById("theme-btn")?.addEventListener("click", () => {
  setTheme(root.dataset.theme === "dark" ? "light" : "dark");
});

document.getElementById("fullscreen-btn")?.addEventListener("click", () => {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void root.requestFullscreen?.();
});

// --- Drawer -----------------------------------------------------------------
const menu = document.getElementById("menu-btn");
function drawer(open: boolean) {
  root.classList.toggle("drawer-open", open);
  menu?.setAttribute("aria-expanded", String(open));
}
menu?.addEventListener("click", () => drawer(!root.classList.contains("drawer-open")));
document.getElementById("drawer-scrim")?.addEventListener("click", () => drawer(false));
addEventListener("keydown", (e) => {
  if (e.key === "Escape") drawer(false);
});

// --- Search -----------------------------------------------------------------
let search: Promise<typeof import("../components/search/mount")> | null = null;
const loadSearch = () => (search ??= import("../components/search/mount"));
const toggleSearch = () => { void loadSearch().then((m) => m.toggleSearch()); };
for (const b of document.querySelectorAll("[data-search-open]")) {
  b.addEventListener("click", toggleSearch);
  // The code is ready before the click lands.
  b.addEventListener("pointerenter", () => { void loadSearch(); }, { once: true });
}
addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    toggleSearch();
  }
});

// --- After a deploy ---------------------------------------------------------
// A page still open from the last deploy asks for a chunk that no longer exists:
// reload once rather than leave a half-working page.
addEventListener("vite:preloadError", (e) => {
  e.preventDefault();
  try {
    const at = Number(sessionStorage.getItem("chunk-reload") || 0);
    if (Date.now() - at < 60000) return;
    sessionStorage.setItem("chunk-reload", String(Date.now()));
  } catch { return; }
  location.reload();
});

initTips();
