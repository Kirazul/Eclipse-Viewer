import { describe, expect, test } from "vitest";
import { FillQueue, type DrawPoster } from "./fill";

const el = () => ({}) as HTMLElement;
const tick = () => new Promise((r) => setTimeout(r, 0));

/** A drawer whose pictures land when the test says so. */
function drawer() {
  const open: { spec: unknown; land(url: string | null): void }[] = [];
  let peak = 0;
  let running = 0;
  const draw: DrawPoster = (spec) =>
    new Promise((resolve) => {
      running++;
      peak = Math.max(peak, running);
      open.push({
        spec,
        land: (url) => {
          running--;
          resolve(url);
        },
      });
    });
  return { draw, open, peak: () => peak };
}

describe("FillQueue", () => {
  test("nothing starts while the page is busy, and it starts from the top when it is free", async () => {
    const d = drawer();
    let free = false;
    const q = new FillQueue(() => d.draw, 3, () => free);
    for (let i = 0; i < 5; i++) q.ask(el(), `k${i}`, { bodyId: `b${i}` }, 200, 264, () => undefined);
    await tick();
    expect(d.open.length).toBe(0);
    free = true;
    q.pump();
    await tick();
    expect(d.open.map((o) => (o.spec as { bodyId: string }).bodyId)).toEqual(["b0", "b1", "b2"]);
  });


  test("only a few at a time, top of the page first, and each card hears its own picture", async () => {
    const d = drawer();
    const q = new FillQueue(() => d.draw, 3);
    const got: string[] = [];
    for (let i = 0; i < 10; i++) q.ask(el(), `k${i}`, { bodyId: `b${i}` }, 200, 264, (u) => got.push(u ?? "none"));
    await tick();
    expect(d.open.length).toBe(3);
    expect((d.open[0]!.spec as { bodyId: string }).bodyId).toBe("b0");
    d.open[0]!.land("u0");
    await tick();
    await tick();
    expect(got).toEqual(["u0"]);
    expect(d.open.length).toBe(4);
    while (got.length < 10) {
      for (const o of d.open.splice(0)) o.land("u");
      await tick();
      await tick();
    }
    expect(d.peak()).toBe(3);
  });

  test("a card that scrolled away asks for nothing, and its picture isn't drawn", async () => {
    const d = drawer();
    const q = new FillQueue(() => d.draw, 1);
    const a = el();
    const b = el();
    const got: string[] = [];
    q.ask(el(), "first", {}, 1, 1, () => got.push("first"));
    q.ask(a, "a", {}, 1, 1, () => got.push("a"));
    q.ask(b, "b", {}, 1, 1, () => got.push("b"));
    q.drop(a);
    await tick();
    d.open.splice(0)[0]!.land("x");
    await tick();
    await tick();
    expect(got).toEqual(["first"]);
    expect(d.open.length).toBe(1);
    d.open.splice(0)[0]!.land("y");
    await tick();
    await tick();
    expect(got).toEqual(["first", "b"]);
  });

  test("a picture drawn once is there at once the next time", async () => {
    const d = drawer();
    const q = new FillQueue(() => d.draw, 2);
    const got: (string | null)[] = [];
    q.ask(el(), "k", {}, 1, 1, (u) => got.push(u));
    await tick();
    d.open.splice(0)[0]!.land("u");
    await tick();
    await tick();
    q.ask(el(), "k", {}, 1, 1, (u) => got.push(u));
    expect(got).toEqual(["u", "u"]);
    expect(d.open.length).toBe(0);
  });

  test("nothing to draw is an answer too, and it isn't asked again", async () => {
    const d = drawer();
    const q = new FillQueue(() => d.draw, 2);
    const got: (string | null)[] = [];
    q.ask(el(), "k", {}, 1, 1, (u) => got.push(u));
    await tick();
    d.open.splice(0)[0]!.land(null);
    await tick();
    await tick();
    q.ask(el(), "k", {}, 1, 1, (u) => got.push(u));
    expect(got).toEqual([null, null]);
  });

  test("no drawer yet: it waits, and starts on the next pump", async () => {
    const d = drawer();
    let ready = false;
    const q = new FillQueue(() => (ready ? d.draw : null), 2);
    const got: (string | null)[] = [];
    q.ask(el(), "k", {}, 1, 1, (u) => got.push(u));
    await tick();
    expect(d.open.length).toBe(0);
    ready = true;
    q.pump();
    await tick();
    expect(d.open.length).toBe(1);
    d.open[0]!.land("u");
    await tick();
    await tick();
    expect(got).toEqual(["u"]);
  });

  test("a drawer that throws leaves a card with no picture, not a stuck queue", async () => {
    const q = new FillQueue(() => async () => {
      throw new Error("no");
    }, 1);
    const got: (string | null)[] = [];
    q.ask(el(), "a", {}, 1, 1, (u) => got.push(u));
    q.ask(el(), "b", {}, 1, 1, (u) => got.push(u));
    for (let i = 0; i < 6; i++) await tick();
    expect(got).toEqual([null, null]);
  });
});
