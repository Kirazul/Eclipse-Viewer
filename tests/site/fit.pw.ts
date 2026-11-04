/**
 * Every control in the room is on screen and can be reached, at the sizes people have, on
 * every tab. A control is reached when the point at its middle lands on it. What scrolls inside
 * a list of its own (the grid, the customization rows, the viewer's panels) is that list's
 * business: the list itself has to stand fully on the page.
 */
import { expect, test, type Page } from "@playwright/test";
import { fixtureCatalog, mockPacks, openRoom } from "./helpers";

const SIZES = [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1600, height: 900 },
  { width: 1920, height: 1080 },
];

const problems = (page: Page) =>
  page.evaluate(() => {
    const out: string[] = [];
    const name = (el: Element) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}.${String(el.getAttribute("class") ?? "").split(" ").slice(0, 2).join(".")}[${el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 18) ?? ""}]`;
    const lists = ".grid-scroll,.mount-scroll,.custom-rows,.viewer-pane,.lo-rows,.rail-nav,.race-grid4,.clip-list";
    const shown = (el: Element) => {
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden") return false;
      return !el.closest("[hidden]");
    };
    for (const el of document.querySelectorAll(".shell button, .shell a, .shell input, .shell [role=slider], .shell [role=tab]")) {
      if (!shown(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const list = el.closest(lists);
      if (list) {
        // Inside a list: inside it or scrolled out of it, never half out of the page.
        const l = list.getBoundingClientRect();
        if (r.bottom <= l.top || r.top >= l.bottom) continue;
        const top = Math.max(r.top, l.top);
        const bottom = Math.min(r.bottom, l.bottom);
        if (bottom - top < r.height) continue;
      }
      if (r.left < -0.5 || r.top < -0.5 || r.right > innerWidth + 0.5 || r.bottom > innerHeight + 0.5) {
        out.push(`off the page: ${name(el)} ${[r.left, r.top, r.right, r.bottom].map(Math.round).join(",")}`);
        continue;
      }
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!hit || !(el === hit || el.contains(hit) || hit.contains(el) || hit.closest("label")?.contains(el))) {
        out.push(`covered: ${name(el)} by ${hit ? name(hit) : "nothing"}`);
      }
    }
    for (const el of document.querySelectorAll(lists)) {
      if (!shown(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width && r.height && (r.bottom > innerHeight + 0.5 || r.right > innerWidth + 0.5)) out.push(`list off the page: ${name(el)} ${[r.left, r.top, r.right, r.bottom].map(Math.round).join(",")}`);
    }
    if (document.documentElement.scrollWidth > innerWidth) out.push(`the page scrolls sideways: ${document.documentElement.scrollWidth}`);
    return out;
  });

test.describe("everything in the room can be reached", () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 700, "desktop sizes");

  for (const size of SIZES) {
    test(`at ${size.width}x${size.height}, on every tab`, async ({ page }) => {
      await page.setViewportSize(size);
      await mockPacks(page, { catalog: fixtureCatalog(60) });
      await openRoom(page);
      // Something worn: the release marks and Reset are controls too.
      await page.locator(".grid-row:not([hidden]) .tile:not(.hide):not([hidden])").first().click();
      await expect(page.locator("#reset-look")).toBeVisible();
      await page.mouse.move(5, 5);
      for (const tab of ["items", "sets", "customization", "loadout", "viewer"]) {
        await page.locator(`[data-tab-btn="${tab}"]`).click();
        await page.waitForTimeout(250);
        expect(await problems(page), `${tab} at ${size.width}x${size.height}`).toEqual([]);
      }
      // The strip's seven controls stand in one row.
      const tops = await page.locator(".strip > *").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top + e.getBoundingClientRect().height / 2)));
      expect(new Set(tops).size, "one row").toBe(1);
    });
  }
});
