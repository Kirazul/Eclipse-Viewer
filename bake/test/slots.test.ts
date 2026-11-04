import { describe, expect, it } from "vitest";
import { slotOfDisplayType } from "../src/items/resolve";

describe("ItemAppearance.DisplayType", () => {
  it("files shields under off-hand and ranged weapons under ranged, as the tables measure", () => {
    expect(slotOfDisplayType(13)).toBe("offhand");
    expect(slotOfDisplayType(12)).toBe("ranged");
    expect(slotOfDisplayType(11)).toBe("mainhand");
  });
});
