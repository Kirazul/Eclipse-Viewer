/**
 * Eclipse's tooltip: one element, moved by transform so showing it never touches
 * layout. Static controls say what they want with data-tip attributes; the
 * catalogue grid calls showTip directly.
 */
let el: HTMLElement | null = null;
let parts: HTMLElement[] = [];
let lastX = 0;
let lastY = 0;

function ensure() {
  if (!el) {
    el = document.getElementById("tip");
    if (el) parts = [...el.children] as HTMLElement[];
  }
  return el;
}

function place() {
  if (!el) return;
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const x = Math.min(lastX + 16, innerWidth - w - 4);
  const y = lastY + 18 + h > innerHeight - 4 ? lastY - h - 8 : lastY + 18;
  el.style.transform = `translate(${Math.max(4, x)}px,${Math.max(4, y)}px)`;
}

export function showTip(title: string, sub?: string, hint?: string) {
  if (!ensure()) return;
  parts[0]!.textContent = title;
  parts[1]!.textContent = sub ?? "";
  parts[1]!.hidden = !sub;
  parts[2]!.textContent = hint ?? "";
  parts[2]!.hidden = !hint;
  el!.classList.add("show");
  place();
}

export function hideTip() {
  el?.classList.remove("show");
}

export function initTips() {
  addEventListener("pointermove", (e) => {
    lastX = e.clientX;
    lastY = e.clientY;
    if (el?.classList.contains("show")) place();
  }, { passive: true });
  document.addEventListener("pointerover", (e) => {
    if (e.pointerType === "touch") return;
    const t = (e.target as Element).closest<HTMLElement>("[data-tip]");
    if (t) showTip(t.dataset.tip!, t.dataset.tipSub, t.dataset.tipHint);
  });
  document.addEventListener("pointerout", (e) => {
    const t = (e.target as Element).closest<HTMLElement>("[data-tip]");
    if (t && !t.contains(e.relatedTarget as Node | null)) hideTip();
  });
  addEventListener("scroll", hideTip, { capture: true, passive: true });
}
