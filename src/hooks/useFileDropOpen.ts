import { useEffect } from "react";

import { pathsFromUriList } from "@/lib/paths";
import { isTauri } from "@/lib/platform";
import { useRepo } from "@/store/repo";

/** Drop a folder (or a file inside a repo) anywhere on the window to open that
 * repository — the same result as the "Open" folder picker, without browsing.
 * The OS delivers the drag as HTML5 DnD (`dragDropEnabled` is false), so the
 * dropped path arrives in `text/uri-list`; `loadRepo` runs it through the same
 * classified `open_repo` as the picker, so a non-repo folder just surfaces the
 * usual error.
 *
 * This also stops the WebView's default "navigate to the dropped file" — which
 * would otherwise blank the app when a file lands outside the terminal. The
 * terminal's own drop handler calls `stopPropagation`, so a drop there pastes a
 * path and never reaches here. Internal branch drags carry no `Files` type, so
 * they pass through untouched. */
export function useFileDropOpen(): void {
  useEffect(() => {
    const isFileDrag = (e: DragEvent) =>
      e.dataTransfer != null && Array.from(e.dataTransfer.types).includes("Files");

    const onDragOver = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      // Required to allow the drop AND to suppress the WebView navigating to
      // the file:// URL on release.
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };

    const onDrop = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      const [path] = pathsFromUriList(e.dataTransfer!.getData("text/uri-list"));
      if (!path || !isTauri) return;
      void useRepo.getState().loadRepo(path);
    };

    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, []);
}
