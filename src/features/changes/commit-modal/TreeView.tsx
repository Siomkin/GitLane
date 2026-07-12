import { useState } from "react";
import { type FileChange } from "@/lib/api";
import { cn } from "@/lib/cn";
import { basename } from "@/lib/paths";
import { useUi } from "@/store/ui";
import { FileIcon } from "@/components/ui/icons";
import { Resizer } from "@/components/ui/Resizer";
import { ChangeCounts } from "@/components/ui/ChangeCounts";
import { DiffPreview } from "@/features/changes/DiffPreview";
import { buildRows } from "@/features/changes/commitTree";
import { Checkbox } from "./Checkbox";

const TREE_MIN_WIDTH = 300;
const TREE_DEFAULT_WIDTH = 360;
const TREE_MAX_WIDTH = 520;

export const TreeView = ({ staged, repoPath }: { staged: FileChange[]; repoPath: string | null }) => {
  const collapsed = useUi((s) => s.commitCollapsed);
  const excluded = useUi((s) => s.commitExcluded);
  const toggleCollapse = useUi((s) => s.toggleCommitCollapse);
  const toggleFile = useUi((s) => s.toggleCommitFile);
  const setDir = useUi((s) => s.setCommitDir);
  const selFile = useUi((s) => s.commitSelFile);
  const selectFile = useUi((s) => s.selectCommitFile);
  const [treeWidth, setTreeWidth] = useState(TREE_DEFAULT_WIDTH);

  // Default the preview to the first staged file.
  const activePath = staged.some((f) => f.path === selFile) ? selFile! : staged[0]?.path ?? null;

  const rows = buildRows(staged, collapsed, (p) => !excluded[p]);
  const resizeTree = (dx: number) => {
    setTreeWidth((width) => Math.max(TREE_MIN_WIDTH, Math.min(TREE_MAX_WIDTH, width + dx)));
  };

  return (
    <div className="flex min-h-0 flex-1 bg-neutral-50/70 p-2 dark:bg-neutral-900/20">
      <div
        data-testid="commit-tree-pane"
        className="shrink-0 overflow-auto rounded-xl border border-black/5 bg-white py-2 shadow-sm dark:border-white/10 dark:bg-neutral-800"
        style={{ width: treeWidth }}
      >
        {rows.map((row) =>
          row.kind === "dir" ? (
            <div
              key={row.key}
              style={{ paddingLeft: 8 + row.depth * 15 }}
              className="flex h-7 items-center gap-1.5 rounded-md pr-2 text-neutral-500 hover:bg-black/5 dark:text-neutral-400 dark:hover:bg-white/5"
            >
              <button
                type="button"
                onClick={() => toggleCollapse(row.key)}
                aria-label={`${row.collapsed ? "Expand" : "Collapse"} ${row.label}`}
                className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  className={cn("h-3 w-3 shrink-0 text-neutral-400 transition-transform", row.collapsed && "-rotate-90")}
                >
                  <path d="m6 9 6 6 6-6" />
                </svg>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-4 w-4 shrink-0 text-neutral-400">
                  <path d="M3 7v12a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1h-8l-2-2H4a1 1 0 0 0-1 1z" />
                </svg>
                <span className="truncate text-[12.5px] font-medium text-neutral-600 dark:text-neutral-300">
                  {row.label}
                </span>
                <span className="ml-auto shrink-0 pl-2 text-[11px] text-neutral-400">
                  {row.count} file{row.count === 1 ? "" : "s"}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setDir(row.paths, row.state !== "on")}
                aria-label={`${row.state === "on" ? "Exclude" : "Include"} ${row.label} from commit`}
                className="grid h-6 w-6 shrink-0 place-items-center rounded-md"
              >
                <Checkbox on={row.state === "on"} mixed={row.state === "mixed"} />
              </button>
            </div>
          ) : (
            <div
              key={row.key}
              style={{ paddingLeft: 8 + row.depth * 15 }}
              className={cn(
                "flex h-7 items-center gap-1.5 rounded-md pr-2",
                row.file.path === activePath
                  ? "bg-[var(--accent-soft)] text-[color:var(--accent)]"
                  : "text-neutral-700 hover:bg-black/5 dark:text-neutral-200 dark:hover:bg-white/5",
              )}
            >
              <button
                type="button"
                onClick={() => toggleFile(row.file.path)}
                aria-label={`${excluded[row.file.path] ? "Include" : "Exclude"} ${row.file.path} from commit`}
                className="grid h-6 w-6 shrink-0 place-items-center rounded-md"
              >
                <Checkbox on={!excluded[row.file.path]} />
              </button>
              <button
                type="button"
                onClick={() => selectFile(row.file.path)}
                className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left"
              >
                <FileIcon path={row.file.path} size={16} />
                <span className="flex-1 truncate text-[13px]">{basename(row.file.path)}</span>
                <ChangeCounts add={row.file.add} del={row.file.del} binary={row.file.binary} className="shrink-0 text-[11px]" />
              </button>
            </div>
          ),
        )}
      </div>
      <Resizer
        onResize={resizeTree}
        overlap={false}
        className="mx-1 w-0.5 shrink-0"
      />
      <DiffPreview
        repoPath={repoPath}
        path={activePath}
        className="overflow-hidden rounded-xl border border-black/5 bg-white shadow-sm dark:border-white/10 dark:bg-neutral-800"
      />
    </div>
  );
};
