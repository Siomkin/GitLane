import { cn } from "../../../lib/cn";
import type { FileListView } from "./types";

/** Path / Tree segmented toggle for a changed-files list — matches the diff
 * view's Unified/Split control idiom. Shared across the commit, working-changes,
 * and merged-selection inspectors (GL-28). */
export function FileViewToggle({
  view,
  onChange,
}: {
  view: FileListView;
  onChange: (view: FileListView) => void;
}) {
  const btn = (active: boolean) =>
    cn(
      "px-2.5 h-6 rounded-md",
      active
        ? "bg-white dark:bg-neutral-700 shadow-sm font-medium text-neutral-800 dark:text-neutral-100"
        : "text-neutral-500 dark:text-neutral-400",
    );
  return (
    <div
      role="group"
      aria-label="File list view"
      className="flex rounded-lg bg-black/[0.06] p-0.5 text-[12px] dark:bg-white/[0.06]"
    >
      <button
        type="button"
        aria-pressed={view === "path"}
        className={btn(view === "path")}
        onClick={() => onChange("path")}
      >
        Path
      </button>
      <button
        type="button"
        aria-pressed={view === "tree"}
        className={btn(view === "tree")}
        onClick={() => onChange("tree")}
      >
        Tree
      </button>
    </div>
  );
}
