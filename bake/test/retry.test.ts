import { describe, expect, it } from "vitest";
import { untilOk } from "../src/lib/retry";

describe("a stall never ends a model", () => {
  it("stops at the first success and gives up after its tries", async () => {
    let n = 0;
    expect(await untilOk(async () => ++n, (r) => r === 2, 3, 0)).toBe(2);
    expect(n).toBe(2);
    n = 0;
    expect(await untilOk(async () => ++n, () => false, 3, 0)).toBe(3);
  });
});
