import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { decode, base64Decode } from "../../site/src/lib/share/code";
import { calls, clearCalls, cls, fixtureCatalog, mockPacks, openRoom, shifts, startCls, watchErrors } from "./helpers";

// Codes the real C++ wrote: site/src/lib/share/golden.
const golden = JSON.parse(readFileSync("site/src/lib/share/golden/fields.json", "utf8")) as { name: string; code: string; text: string }[];
const code = (name: string) => golden.find((g) => g.name === name)!;

/** A catalogue whose first few items carry in-game entries. Every other item has none. */
function catalog() {
  const c = fixtureCatalog(8) as { items: { id: string; entry?: number }[] };
  const entries: Record<string, number> = { "head-1": 11, "shoulder-1": 22, "chest-1": 33, "mainhand-1": 44, "offhand-1": 55, "legs-2": 66, "head-3": 231001 };
  for (const it of c.items) if (entries[it.id]) it.entry = entries[it.id];
  return c;
}

/** Every body baked, so a code can change race: the build's data has only what the packs hold. */
async function bakeEveryBody(page: Page) {
  await page.route(/\/wardrobe\/(\?.*)?$/, async (route) => {
    const res = await route.fetch();
    const html = (await res.text()).replace(/(<script[^>]*id="room-data"[^>]*>)([\s\S]*?)(<\/script>)/, (_m, a: string, json: string, c: string) => {
      const data = JSON.parse(json) as { races: { bodies: { id: string; model?: string }[] }[] };
      for (const r of data.races) for (const b of r.bodies) b.model = b.id;
      return a + JSON.stringify(data) + c;
    });
    await route.fulfill({ response: res, body: html });
  });
}

async function open(page: Page, query = "?body=human-male&tab=loadout") {
  await bakeEveryBody(page);
  await mockPacks(page, { catalog: catalog() });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
  await openRoom(page, query);
  await expect(page.getByTestId("loadout-panel")).toBeVisible();
}
const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());
const setClipboard = (page: Page, text: string) => page.evaluate((t) => navigator.clipboard.writeText(t), text);
const equipped = async (page: Page) => {
  const out: Record<string, string | null> = {};
  for (const c of await calls(page, "equip")) out[c.args[0] as string] = c.args[1] as string | null;
  return out;
};

/** A phone's grid lies under the stage, and a virtual grid has only the rows in view. */
async function toGrid(page: Page) {
  if ((page.viewportSize()?.width ?? 0) >= 768) return;
  await page.locator("#grid-space").evaluate((e) => e.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(120);
}

test.describe("the Loadout tab", () => {
  test("Eclipse's words, in Eclipse's order", async ({ page }) => {
    const errors = watchErrors(page);
    await open(page);
    const tabs = await page.locator("[data-tab-btn]").allTextContents();
    expect(tabs).toEqual(["Items", "Sets", "Customization", "Loadout", "Viewer"]);
    const panel = page.getByTestId("loadout-panel");
    const text = await panel.innerText();
    const order = ["Loadouts", "LOADOUTS", "Current look", "What you are wearing", "Build a look in Wardrobe, then save it below.", "Save current loadout", "Share", "Import", "MOUNT", "MAIN-HAND GLOW", "OFF-HAND GLOW", "SAVED RACE", "SKINS", "Select a saved loadout to preview it."];
    let at = 0;
    for (const word of order) {
      const found = text.indexOf(word, at);
      expect(found, word).toBeGreaterThanOrEqual(at);
      at = found;
    }
    await expect(page.getByTestId("lo-name")).toHaveAttribute("placeholder", "New loadout name");
    await expect(page.getByTestId("lo-title")).toHaveText("Current look");
    await expect(page.getByTestId("lo-facts")).toContainText("Unchanged");
    await expect(page.getByTestId("lo-facts")).toContainText("None");
    expect(errors).toEqual([]);
  });

  test("a code made in game comes back byte for byte, and dresses the figure", async ({ page }) => {
    const errors = watchErrors(page);
    await open(page);
    await clearCalls(page);
    const everything = code("everything at once");
    await page.getByTestId("lo-paste").fill(everything.code);
    await page.getByTestId("lo-import").click();
    await expect(page.getByTestId("lo-note")).toHaveText('Imported and saved as "Imported".');
    // The same engine calls a set uses. look 1 1 ... is a human female.
    await expect.poll(() => calls(page, "loadModel").then((c) => c.at(-1)?.args[0])).toBe("human-female");
    await expect.poll(() => equipped(page)).toMatchObject({ head: "head-1", shoulder: "shoulder-1", chest: "chest-1", mainhand: "mainhand-1", offhand: "offhand-1" });
    await expect(page.locator('[data-ring="head"]')).toHaveClass(/worn/);
    // shirt is slot 3 at 0: shown as nothing, and it stays on the code.
    await expect(page.locator('[data-ring="shirt"]')).not.toHaveClass(/worn/);
    await expect(page.getByTestId("lo-title")).toHaveText("Imported");
    await expect(page.getByTestId("lo-summary")).toHaveText("6 pieces  /  mount  /  glows  /  skins  /  race");
    await expect(page.getByTestId("lo-facts")).toContainText("Hidden");
    await expect(page.getByTestId("lo-facts")).toContainText("Enchant 3789");
    await expect(page.getByTestId("lo-facts")).toContainText("Human female");
    await expect(page.getByTestId("lo-facts")).toContainText("2 looks");
    // Everything it holds that can't be drawn here, counted.
    await expect(page.getByTestId("lo-kept")).toContainText("more in this code, not drawn here");

    await page.getByTestId("lo-share").click();
    await expect(page.getByTestId("lo-note")).toHaveText("Code copied - paste it to share this loadout.");
    expect(await clipboard(page)).toBe(everything.code);

    // "Current look" is that look now: it shares the same code too.
    await page.locator(".lo-row").first().click();
    await page.getByTestId("lo-share").click();
    await expect(page.getByTestId("lo-note")).toHaveText("Code copied - paste it to share your current look.");
    expect(await clipboard(page)).toBe(everything.code);

    // Importing it again files nothing new.
    await page.getByTestId("lo-paste").fill(everything.code);
    await page.getByTestId("lo-import").click();
    await expect(page.getByTestId("lo-note")).toHaveText('Imported and saved as "Imported".');
    await expect(page.locator(".lo-row")).toHaveCount(2);
    expect(errors).toEqual([]);
  });

  test("every golden code goes in and comes out the same", async ({ page }) => {
    test.setTimeout(120_000);
    await open(page);
    for (const g of golden) {
      await page.getByTestId("lo-paste").fill(g.code);
      await page.getByTestId("lo-import").click();
      await expect(page.getByTestId("lo-paste")).toHaveValue("");
      await page.getByTestId("lo-share").click();
      await expect.poll(() => clipboard(page), g.name).toBe(g.code);
    }
  });

  test("an edit on the site keeps everything else in the code", async ({ page }) => {
    await open(page);
    const everything = code("everything at once");
    await page.getByTestId("lo-paste").fill(everything.code);
    await page.getByTestId("lo-import").click();
    await expect(page.getByTestId("lo-title")).toHaveText("Imported");
    await page.locator(".lo-row").first().click();
    // The ring opens the Items tab on that slot: wear another helm, come back.
    await page.locator('[data-ring="head"]').click();
    await toGrid(page);
    await page.locator('.tile[aria-label$="head 3"]').first().click();
    await page.locator('[data-tab-btn="loadout"]').click();
    await page.getByTestId("lo-share").click();
    await expect.poll(() => clipboard(page).then((c) => base64Decode(c.slice(5)))).toBe(everything.text.replace("slot 0 11", "slot 0 231001"));
  });

  test("a look built on the site: items with an entry go, a piece without one is marked and left out", async ({ page }) => {
    await open(page, "?body=nightelf-female&look=head:head-1,legs:legs-1&tab=loadout");
    await expect(page.getByTestId("lo-missing")).toHaveText("1 piece can't go to the game");
    await expect(page.locator('[data-ring="legs"]')).toHaveAttribute("data-no-export", "");
    await expect(page.locator('[data-ring="head"]')).not.toHaveAttribute("data-no-export", "");
    await page.getByTestId("lo-share").click();
    await expect.poll(() => clipboard(page).then((c) => c.slice(0, 5))).toBe("ECA1:");
    const shared = await clipboard(page);
    const o = decode(shared)!;
    expect(o.item[0]).toBe(11);
    expect(o.managed[0]).toBe(true);
    expect(o.managed[6]).toBe(false);
    expect(o.rlookKept.startsWith("rlook nightelf f")).toBe(true);
  });

  test("the Customization tab's real choices go into the code, as the DLL stores them", async ({ page }) => {
    await open(page);
    await page.locator('[data-tab-btn="customization"]').click();
    await page.getByRole("button", { name: "Next Hair Style" }).click();
    await page.locator('[data-option="2"] [data-choice="21"]').click();
    await expect.poll(async () => (await calls(page, "setLook")).at(-1)?.args).toEqual([{ 1: 11, 2: 21, 3: 30 }]);
    await page.locator('[data-tab-btn="loadout"]').click();
    await page.getByTestId("lo-share").click();
    await expect.poll(() => clipboard(page).then((c) => base64Decode(c.slice(5)))).toBe("look 1 0 0 0 0 0 0\nrlook human m 1:11 2:21 3:30\n");
    await expect(page.getByTestId("loadout-panel")).toContainText("No race pack? They wear the closest normal race.");
  });

  test("a code holding a fallback shows the retail body and counts nothing extra", async ({ page }) => {
    await open(page);
    await clearCalls(page);
    const both = `ECA1:${Buffer.from("look 4 1 0 0 0 0 0\nrlook nightelf f 1:11\n", "latin1").toString("base64")}`;
    await page.getByTestId("lo-paste").fill(both);
    await page.getByTestId("lo-import").click();
    await expect.poll(() => calls(page, "loadModel").then((c) => c.at(-1)?.args)).toEqual(["nightelf-female", "1.11"]);
    await expect(page.getByTestId("lo-facts")).toContainText("Night Elf female");
    await expect(page.getByTestId("lo-kept")).toBeHidden();
    await page.getByTestId("lo-share").click();
    await expect.poll(() => clipboard(page)).toBe(both);
  });

  test("a game code with only the retail line gets its fallback when it is edited, not before", async ({ page }) => {
    await open(page);
    const only = `ECA1:${Buffer.from("slot 0 11\nrlook nightelf f 1:11\n", "latin1").toString("base64")}`;
    await page.getByTestId("lo-paste").fill(only);
    await page.getByTestId("lo-import").click();
    await expect(page.getByTestId("lo-title")).toHaveText("Imported");
    await page.locator(".lo-row").first().click();
    await page.getByTestId("lo-share").click();
    await expect.poll(() => clipboard(page)).toBe(only);
    await page.locator('[data-ring="head"]').click();
    await toGrid(page);
    await page.locator('.tile[aria-label$="head 3"]:visible').first().click();
    await page.locator('[data-tab-btn="loadout"]').click();
    await page.getByTestId("lo-share").click();
    await expect.poll(() => clipboard(page).then((c) => base64Decode(c.slice(5)))).toBe("slot 0 231001\nlook 4 1 0 0 0 0 0\nrlook nightelf f 1:11\n");
  });

  test("a retail code from the game dresses race, sex and choices", async ({ page }) => {
    await open(page);
    await clearCalls(page);
    const retail = `ECA1:${Buffer.from("slot 0 11\nrlook nightelf f 1:11 2:21 3:31\n", "latin1").toString("base64")}`;
    await page.getByTestId("lo-paste").fill(retail);
    await page.getByTestId("lo-import").click();
    await expect.poll(() => calls(page, "loadModel").then((c) => c.at(-1)?.args)).toEqual(["nightelf-female", "1.11,2.21,3.31"]);
    await expect(page.getByTestId("lo-facts")).toContainText("Night Elf female");
    await page.getByTestId("lo-share").click();
    await expect.poll(() => clipboard(page)).toBe(retail);
  });

  test("a retail code on the body already standing changes the look in one step", async ({ page }) => {
    await open(page);
    await clearCalls(page);
    const retail = `ECA1:${Buffer.from("rlook human m 1:12 2:22 3:31\n", "latin1").toString("base64")}`;
    await page.getByTestId("lo-paste").fill(retail);
    await page.getByTestId("lo-import").click();
    await expect.poll(async () => (await calls(page, "setLook")).at(-1)?.args).toEqual([{ 1: 12, 2: 22, 3: 31 }]);
    expect(await calls(page, "loadModel")).toEqual([]);
    await page.getByTestId("lo-share").click();
    await expect.poll(() => clipboard(page)).toBe(retail);
  });

  test("Import lights up for a code on the clipboard or pasted, and refuses what isn't one", async ({ page }) => {
    await open(page);
    await setClipboard(page, "not a code");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByTestId("lo-import")).toBeDisabled();
    await page.getByTestId("lo-paste").fill("hello");
    await expect(page.getByTestId("lo-import")).toBeDisabled();
    await page.getByTestId("lo-paste").fill(golden[0]!.code);
    await expect(page.getByTestId("lo-import")).toBeEnabled();
    await page.getByTestId("lo-paste").fill("");
    await setClipboard(page, golden[0]!.code);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByTestId("lo-import")).toBeEnabled();
    await page.getByTestId("lo-import").click();
    await expect(page.getByTestId("lo-note")).toHaveText('Imported and saved as "Imported".');
    await expect.poll(() => equipped(page)).toMatchObject({});
  });

  test("a code's mount is named and links to its stage; the Mounts page puts one in the code", async ({ page, isMobile }) => {
    const mounts = [
      { id: "m-1", name: "Swift Horse", circle: "", tile: "", mountId: 1, flying: false, variants: [{ id: "mount-1", display: 900, name: "Swift Horse", icon: "", mountId: 1, entry: 25159 }] },
      { id: "m-2", name: "Drake", circle: "", tile: "", mountId: 2, flying: true, variants: [{ id: "mount-2", display: 901, name: "Drake", icon: "", mountId: 2, entry: 31992 }] },
      { id: "m-3", name: "No Entry", circle: "", tile: "", mountId: 3, flying: false, variants: [{ id: "mount-3", display: 902, name: "No Entry", icon: "", mountId: 3 }] },
    ];
    await page.route("**/packs/catalog/mounts.json", (r) => r.fulfill({ json: mounts }));
    await open(page);
    const two = code("two mounts");
    await page.getByTestId("lo-paste").fill(two.code);
    await page.getByTestId("lo-import").click();
    await expect(page.getByTestId("lo-facts")).toContainText("GROUND / FLYING");
    await expect(page.getByTestId("lo-facts")).toContainText("Swift Horse / Drake");
    await page.getByTestId("lo-share").click();
    await expect.poll(() => clipboard(page)).toBe(two.code);

    await page.locator(".lo-row").first().click();
    await page.locator("#reset-look").click();
    await expect(page.getByTestId("lo-facts")).toContainText("Unchanged");

    test.skip(isMobile, "the stage's own buttons are the mounts spec's on a phone");
    await page.goto("mounts/view/?id=m-3");
    await expect(page.locator("#mount-loadout")).toBeDisabled();
    await page.goto("mounts/view/?id=m-2");
    await expect(page.locator("#mount-loadout")).toBeEnabled();
    await page.locator("#mount-loadout").click();
    await page.waitForURL(/wardrobe\/\?(.*&)?tab=loadout/);
    await expect(page.getByTestId("lo-facts")).toContainText("Drake");
    await page.getByTestId("lo-share").click();
    await expect.poll(() => clipboard(page).then((c) => base64Decode(c.slice(5)))).toContain("mountfly 31992\n");
    const link = page.locator('.lo-facts a[href*="mounts/view/"]');
    await expect(link).toHaveAttribute("href", /id=mount-2&v=901/);
  });

  test("an old code with a ~ section still imports", async ({ page }) => {
    await open(page);
    const old = `${golden[0]!.code}~head|Helm~iVBORw0KGgoAAAANSUhEUg==`;
    await page.getByTestId("lo-paste").fill(old);
    await page.getByTestId("lo-import").click();
    await expect(page.getByTestId("lo-note")).toHaveText('Imported and saved as "Imported".');
    await expect(page.getByTestId("lo-summary")).toHaveText("1 piece");
  });

  test("a library: save, preview, apply, rename, update, delete, and it survives a reload", async ({ page }) => {
    await open(page, "?body=human-male&look=head:head-1&tab=loadout");
    await page.getByTestId("lo-name").fill("Gold");
    await page.getByTestId("lo-save").click();
    await expect(page.getByTestId("lo-note")).toHaveText("Loadout saved.");
    await expect(page.locator(".lo-row")).toHaveCount(2);
    await expect(page.getByTestId("lo-title")).toHaveText("Gold");
    await expect(page.getByTestId("lo-apply")).toBeVisible();

    // A second look, then back to the first: selecting previews, Current look returns.
    await page.locator(".lo-row").first().click();
    await page.locator('[data-tab-btn="items"]').click();
    await page.locator('[data-ring="chest"]').click();
    await toGrid(page);
    await page.locator(".tile:not(.hide):visible").nth(1).click();
    await page.locator('[data-tab-btn="loadout"]').click();
    await clearCalls(page);
    await page.locator(".lo-row").nth(1).click();
    await expect.poll(() => equipped(page)).toMatchObject({ head: "head-1", chest: null });
    await page.locator(".lo-row").first().click();
    await expect.poll(() => equipped(page).then((e) => e.chest)).toBeTruthy();

    // Apply keeps it selected and makes it what is worn.
    await page.locator(".lo-row").nth(1).click();
    await page.getByTestId("lo-apply").click();
    await expect(page.getByTestId("lo-note")).toHaveText("Loadout applied - equipment, mount, glows and saved race.");
    await expect(page.getByTestId("lo-title")).toHaveText("Gold");

    await page.getByTestId("lo-rename").click();
    await page.getByTestId("lo-rename-field").fill("Golden [hour]");
    await page.getByTestId("lo-confirm").click();
    await expect(page.getByTestId("lo-title")).toHaveText("Golden hour");

    await page.reload();
    await expect(page.getByTestId("loadout-panel")).toBeVisible();
    await expect(page.locator(".lo-row")).toHaveCount(2);
    await expect(page.locator(".lo-row").nth(1)).toContainText("Golden hour");

    await page.locator(".lo-row").nth(1).click();
    await page.getByTestId("lo-delete").click();
    await expect(page.getByRole("dialog")).toContainText('Delete "Golden hour"? What you are wearing will not change.');
    await page.getByTestId("lo-confirm").click();
    await expect(page.getByTestId("lo-note")).toHaveText("Loadout deleted.");
    await expect(page.locator(".lo-row")).toHaveCount(1);
    await expect(page.getByTestId("lo-title")).toHaveText("Current look");
  });

  test("a private window: no storage, and nothing breaks", async ({ page }) => {
    const errors = watchErrors(page);
    await page.addInitScript(() => {
      Storage.prototype.setItem = () => { throw new DOMException("denied", "SecurityError"); };
      Storage.prototype.getItem = () => { throw new DOMException("denied", "SecurityError"); };
    });
    await open(page);
    await page.getByTestId("lo-name").fill("Kept in memory");
    await page.getByTestId("lo-save").click();
    await expect(page.locator(".lo-row")).toHaveCount(2);
    expect(errors).toEqual([]);
  });

  test("a link carries the code; a code's link gives the same code back", async ({ page }) => {
    const everything = code("everything at once");
    await open(page, `?tab=loadout&code=${encodeURIComponent(everything.code)}`);
    await expect.poll(() => calls(page, "loadModel").then((c) => c.at(-1)?.args[0])).toBe("human-female");
    await expect(page.getByTestId("lo-summary")).toHaveText("6 pieces  /  mount  /  glows  /  skins  /  race");
    await page.getByTestId("lo-share").click();
    await expect.poll(() => clipboard(page)).toBe(everything.code);
    // The address bar keeps it, so the page's own link is a link to this code.
    await expect.poll(() => page.evaluate(() => new URLSearchParams(location.search).get("code"))).toBe(everything.code);
    await expect(page.locator(".lo-row")).toHaveCount(1); // a link wears; it doesn't file
  });

  test("no layout shift, no flicker of the room on the way in or while selecting", async ({ page, isMobile }) => {
    test.skip(isMobile, "the shift gate is the desktop layout");
    await startCls(page);
    await open(page, "?body=human-male&look=head:head-1&tab=loadout");
    const stage0 = (await page.locator("#stage").boundingBox())!;
    await page.getByTestId("lo-name").fill("A");
    await page.getByTestId("lo-save").click();
    const box = await page.getByTestId("lo-facts").boundingBox();
    const banner = await page.locator(".lo-banner").boundingBox();
    await page.locator(".lo-row").first().click();
    await page.waitForTimeout(100);
    await page.locator(".lo-row").nth(1).click();
    await page.waitForTimeout(100);
    expect(await page.getByTestId("lo-facts").boundingBox()).toEqual(box);
    expect(await page.locator(".lo-banner").boundingBox()).toEqual(banner);
    expect(await page.locator("#stage").boundingBox()).toEqual(stage0);
    expect(await cls(page), JSON.stringify(await shifts(page))).toBeLessThan(0.01);
  });

  test("a phone: everything reachable, nothing wider than the screen", async ({ page, isMobile }) => {
    test.skip(!isMobile, "phone");
    await open(page);
    await expect(page.getByTestId("lo-save")).toBeVisible();
    await page.getByTestId("lo-share").scrollIntoViewIfNeeded();
    await expect(page.getByTestId("lo-share")).toBeVisible();
    const over = await page.evaluate(() => [...document.querySelectorAll(".lo *")].filter((e) => e.getBoundingClientRect().right > innerWidth + 1).map((e) => e.className));
    expect(over).toEqual([]);
  });

  test("the render, for looking at beside the game's", async ({ page, isMobile }) => {
    test.skip(isMobile, "desktop render");
    await page.setViewportSize({ width: 1400, height: 860 });
    await open(page, "?body=human-male&look=head:head-1,chest:chest-1,legs:legs-1&tab=loadout");
    await page.getByTestId("lo-name").fill("Summer Solstice");
    await page.getByTestId("lo-save").click();
    await page.getByTestId("lo-paste").fill(code("everything at once").code);
    await page.getByTestId("lo-import").click();
    await expect(page.getByTestId("lo-title")).toHaveText("Imported");
    await page.waitForTimeout(250);
    await page.screenshot({ path: "tests/site/results/shots/08_loadout.png" });
    await page.locator(".lo-row").first().click();
    await page.waitForTimeout(250);
    await page.screenshot({ path: "tests/site/results/shots/08b_loadout_current.png" });
  });
});
