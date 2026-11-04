import { BUILD, FORMAT_VERSION, type Catalog } from "@eclipse/format";

/**
 * FALLBACK, NOT DATA. Used only while `catalog.json` from the bake is absent, so
 * the site builds and every page has something to lay out. IS_FALLBACK marks it.
 */
export const FALLBACK_CATALOG: Catalog = {
  formatVersion: FORMAT_VERSION,
  build: BUILD.version,
  generatedAt: "fallback",
  races: [
    {
      id: "human",
      name: "Human",
      raceId: 1,
      faction: "Alliance",
      circle: "",
      tile: "",
      description: "The people of Stormwind, resolute and proud.",
      bodies: [
        { id: "human-male", name: "Human Male", circle: "", tile: "", model: "human-male" },
        { id: "human-female", name: "Human Female", circle: "", tile: "" },
      ],
    },
  ],
  mounts: [],
  items: [],
};
