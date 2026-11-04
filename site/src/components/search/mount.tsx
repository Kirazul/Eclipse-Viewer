import { createRoot, type Root } from "react-dom/client";
import { SearchDialog, toggleOpen } from "./SearchDialog";

let root: Root | null = null;

/** The first call mounts the dialog, opened; later calls toggle it. */
export function toggleSearch() {
  if (!root) {
    root = createRoot(document.getElementById("overlay-root")!);
    root.render(<SearchDialog initiallyOpen />);
    return;
  }
  toggleOpen();
}
