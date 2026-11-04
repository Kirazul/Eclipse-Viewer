import { createRoot } from "react-dom/client";
import { CustomPanel } from "./CustomPanel";
import { LoadoutPanel } from "./LoadoutPanel";
import { ViewerPanels } from "./ViewerPanels";

/** The panes hold a static notice until this runs; React's first render replaces it. */
export function mountPanels() {
  createRoot(document.getElementById("viewer-root")!).render(<ViewerPanels />);
  createRoot(document.getElementById("custom-root")!).render(<CustomPanel />);
  createRoot(document.getElementById("loadout-root")!).render(<LoadoutPanel />);
}
