import { useEffect, useMemo, useState } from "react";
// eslint-disable-next-line no-restricted-imports -- local per-file diff fetch via useLazyDiffs, disposable probe (architecture-rules-react.md §1)
import { api, type FileChange, type FileDiff, type WorkingChanges } from "../../lib/api";
import { advancedNotices, fileWriteGuard, findGuardedFile } from "../../lib/advancedRepoState";
import { cn } from "../../lib/cn";
import { summarizeChanges } from "../../lib/changeSummary";
import { control } from "../../lib/ui";
import { basename, dirname } from "../../lib/paths";
import { useLazyDiffs } from "../../hooks/useLazyDiffs";
import { useRepo, type ChangeSource } from "../../store/repo";
import { FileIcon } from "@/components/ui/icons";
import { AdvancedRepoBanner } from "../advanced-repo/AdvancedRepoBanner";
import { UnifiedDiffBody } from "../review/DiffBody";
import { BinaryDiff } from "../review/BinaryDiff";
import { HandToAgentBar } from "../review/comments/HandToAgentBar";
import { StatusPill } from "@/components/ui/StatusBadge";
import { ChangeCounts } from "@/components/ui/ChangeCounts";
import { ChangeTypeCounts } from "./ChangeTypeCounts";

// Working-tree notes are scoped per source (so a staged diff's refs don't share
// with the unstaged diff's); a file's surface is `work:<source>` and the bar
// hands off both. Shared with the single-file review, so a comment shows in both.
const workSurface = (source: ChangeSource) => `work:${source}`;
const WORK_SURFACES = ["work:unstaged", "work:staged"];

// Cache key for a file's diff WITHIN one working-tree snapshot: path + source
// (plus status/counts so a same-snapshot staged/unstaged flip refetches). NOT a
// content identity — content can change without any of these fields changing,
// so the cache is reset whenever a new snapshot arrives (GL-173).
function diffKey(source: ChangeSource, file: FileChange) {
  return `${source}\u0000${file.path}\u0000${file.status}\u0000${file.add}\u0000${file.del}`;
}

export function ChangesWorkspace({ onBack }: { onBack: () => void }) {
  const changes = useRepo((state) => state.changes);
  const repoPath = useRepo((state) => state.summary?.path ?? null);
  const selectFile = useRepo((state) => state.selectFile);
  const stageFile = useRepo((state) => state.stageFile);
  const unstageFile = useRepo((state) => state.unstageFile);
  const stageAll = useRepo((state) => state.stageAll);
  const unstageAll = useRepo((state) => state.unstageAll);
  const notices = advancedNotices(changes);
  const stageAllBlocked = fileWriteGuard(findGuardedFile(changes.unstaged, changes), changes);
  const unstageAllBlocked = fileWriteGuard(findGuardedFile(changes.staged, changes), changes);

  // Stable, de-duplicated file order (alphabetical). A file keeps its slot when
  // staged/unstaged, so ticking ✓ never reorders the list. Each row resolves
  // the entry to show and the source its diff comes from.
  const rows = useMemo(() => {
    const paths = Array.from(
      new Set([...changes.unstaged, ...changes.staged].map((file) => file.path)),
    ).sort();
    return paths.map((path) => {
      const stagedEntry = changes.staged.find((f) => f.path === path);
      const unstagedEntry = changes.unstaged.find((f) => f.path === path);
      // Show the working-tree entry while anything is still unstaged;
      // otherwise the file is fully staged.
      const file = unstagedEntry ?? stagedEntry!;
      const source: ChangeSource = stagedEntry && !unstagedEntry ? "staged" : "unstaged";
      return { path, file, source, key: diffKey(source, file) };
    });
  }, [changes]);
  const total = rows.length;
  const rowPathsKey = rows.reduce(
    (key, row) => (key === "" ? row.path : `${key}\u0000${row.path}`),
    "",
  );

  // Expansion is local and per-file, so several files can stay open at once
  // (unlike before, when it was tied to the single store selection and opening
  // one file collapsed any other). Diffs are loaded and cached per file here,
  // independent of the store's single-file `fileDiff`.
  const [open, setOpen] = useState<Record<string, boolean>>({});
  // Per-file diff cache, valid for exactly one working-tree snapshot. Never
  // cancels — see useLazyDiffs.
  const { diffs, ensure, reset } = useLazyDiffs();

  // Only a store refresh can carry a content change, and every refresh
  // publishes a NEW `changes` object (watcher, focus re-sync, staging write,
  // repo switch) — so snapshot identity is the cache generation; the key's
  // status/counts can't stand in for content (GL-173). Declared before the
  // fetch effect below so an invalidated snapshot's open files refetch in the
  // same pass; expanding/collapsing files doesn't touch the snapshot, so the
  // cache is reused within one generation.
  useEffect(() => {
    reset();
  }, [changes, repoPath, reset]);

  // Open the first file by default so the view isn't empty on entry; only when
  // nothing is open yet (don't fight the user's manual collapses).
  useEffect(() => {
    if (total === 0) return;
    const rowPaths = rowPathsKey.split("\u0000");
    setOpen((o) => {
      if (rowPaths.some((path) => o[path])) return o;
      return { ...o, [rowPaths[0]]: true };
    });
  }, [rowPathsKey, total]);

  // Lazily fetch the diff for every open file that doesn't have one cached.
  useEffect(() => {
    if (!repoPath) return;
    const pending: Array<{ key: string; fetch: () => Promise<FileDiff> }> = [];
    for (const row of rows) {
      if (!open[row.path]) continue;
      pending.push({
        key: row.key,
        fetch: () => api.fileDiff(repoPath, row.path, row.source === "staged"),
      });
    }
    ensure(pending);
  }, [rows, open, repoPath, ensure]);

  return (
    <main className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-black/5 dark:border-white/5 bg-white dark:bg-neutral-800 shadow-sm">
      <div className="flex h-12 flex-none items-center gap-3 border-b border-black/5 dark:border-white/5 px-4">
        <span className="text-[14px] font-semibold text-neutral-800 dark:text-neutral-100">
          Reviewing {total} changed {total === 1 ? "file" : "files"}
        </span>
        <ChangeTypeCounts summary={summarizeChanges(changes)} className="flex-none" />
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-neutral-400">Tick a file to stage it</span>
          <button
            type="button"
            className={`${control} h-8 min-h-0 px-3 text-xs`}
            onClick={stageAllBlocked ? undefined : stageAll}
            disabled={changes.unstaged.length === 0 || !!stageAllBlocked}
            title={stageAllBlocked ?? undefined}
          >
            Stage all
          </button>
          <button
            type="button"
            className={`${control} h-8 min-h-0 px-3 text-xs`}
            onClick={unstageAllBlocked ? undefined : unstageAll}
            disabled={changes.staged.length === 0 || !!unstageAllBlocked}
            title={unstageAllBlocked ?? undefined}
          >
            Unstage all
          </button>
        </div>
        <button
          type="button"
          className="flex flex-none items-center gap-1 h-8 px-2.5 rounded-lg border border-black/10 dark:border-white/10 text-[12px] font-medium text-neutral-600 dark:text-neutral-300 hover:bg-black/5 dark:hover:bg-white/5"
          onClick={onBack}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3 h-3">
            <path d="m15 18-6-6 6-6" />
          </svg>
          Graph
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto bg-white dark:bg-neutral-800">
        <AdvancedRepoBanner notices={notices} />
        {total === 0 ? (
          <div className="grid h-full place-content-center text-sm text-neutral-400">
            No local changes.
          </div>
        ) : (
          rows.map(({ path, file, source, key }) => {
            const expanded = !!open[path];
            return (
              <ReviewFileSection
                key={path}
                file={file}
                source={source}
                expanded={expanded}
                loading={expanded && diffs[key] === undefined}
                diff={expanded ? diffs[key] ?? null : null}
                changes={changes}
                onHeader={() => {
                  const willOpen = !expanded;
                  setOpen((o) => ({ ...o, [path]: willOpen }));
                  // Focus this file in the right panel; its diff loads locally.
                  if (willOpen) selectFile(path, source);
                }}
                onToggle={() => {
                  if (fileWriteGuard(file, changes)) return;
                  if (source === "staged") {
                    unstageFile(path);
                  } else {
                    stageFile(path);
                    // Approving a file collapses it in place (it keeps its slot).
                    setOpen((o) => ({ ...o, [path]: false }));
                  }
                }}
              />
            );
          })
        )}
      </div>

      <HandToAgentBar surfaces={WORK_SURFACES} />
    </main>
  );
}

function ReviewFileSection({
  file,
  source,
  expanded,
  loading,
  diff,
  changes,
  onHeader,
  onToggle,
}: {
  file: FileChange;
  source: ChangeSource;
  expanded: boolean;
  loading: boolean;
  diff: FileDiff | null;
  changes: WorkingChanges;
  onHeader: () => void;
  onToggle: () => void;
}) {
  const staged = source === "staged";
  const disabledReason = fileWriteGuard(file, changes);
  return (
    <section className="border-b border-black/5 dark:border-white/5">
      <button
        type="button"
        className="flex items-center gap-2 px-4 h-11 w-full sticky top-0 z-10 text-left bg-white/95 dark:bg-neutral-800/95 backdrop-blur border-b border-black/5 dark:border-white/5"
        onClick={onHeader}
      >
        <span className="w-3 flex-none text-[10px] text-neutral-400">{expanded ? "▾" : "▸"}</span>
        <span className="text-[color:var(--accent)]">
          <FileIcon path={file.path} size={20} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px]">
          <span className="text-neutral-400">{dirname(file.path)}</span>
          <strong className="font-semibold text-neutral-800 dark:text-neutral-100">{basename(file.path)}</strong>
        </span>
        <StatusPill status={file.status} />
        <ChangeCounts add={file.add} del={file.del} binary={file.binary} className="text-[11px]" />
        {file.advanced && (
          <span className="rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[10.5px] font-medium text-amber-700 dark:text-amber-300">
            {file.advanced.message}
          </span>
        )}
        <span
          className={cn(
            "grid h-[18px] w-[18px] flex-none place-items-center rounded-[5px] border text-[12px] font-extrabold",
            !staged && "border-black/20 dark:border-white/20",
            disabledReason && "cursor-not-allowed opacity-45",
          )}
          style={{
            borderColor: staged ? "#2e9e62" : undefined,
            background: staged ? "#2e9e62" : "transparent",
            color: staged ? "#fff" : "transparent",
          }}
          onClick={(event) => {
            event.stopPropagation();
            if (!disabledReason) onToggle();
          }}
          title={disabledReason ?? (staged ? "Unstage file" : "Stage file")}
        >
          ✓
        </span>
      </button>
      {expanded && (
        <div className="bg-white dark:bg-neutral-800">
          {loading ? (
            <div className="px-4 py-3 text-xs text-neutral-400">Loading diff…</div>
          ) : diff && diff.binary ? (
            <BinaryDiff diff={diff} />
          ) : diff && !diff.binary ? (
            <UnifiedDiffBody hunks={diff.hunks} file={file.path} surface={workSurface(source)} />
          ) : (
            <div className="px-4 py-3 text-xs text-neutral-400">
              {diff === null ? "Couldn't load diff." : "No visible diff."}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
