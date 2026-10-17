import { useEffect, type MouseEvent } from "react";
import type { FileChange } from "@/lib/api";
import {
  advancedNotices,
  discardAllGuardMessage,
  fileWriteGuard,
  findGuardedFile,
} from "@/lib/advancedRepoState";
import { summarizeChanges } from "@/lib/changeSummary";
import { useRepo } from "@/store/repo";
import { useUi, fileMenuOf, FileMenuKind, MenuKind } from "@/store/ui";
import { TrashIcon } from "@/components/ui/icons";
import { useDiscardAllChanges } from "@/components/chrome/overlays/menus/useDiscardAllChanges";
import { AdvancedRepoBanner } from "@/features/advanced-repo/AdvancedRepoBanner";
import { SearchIcon } from "@/components/ui/icons";
import { ChangesView } from "@/lib/ui";
import { ChangeTypeCounts } from "./ChangeTypeCounts";
import { ChangesViewToggle } from "./ChangesViewToggle";
import { IncludeFileSection } from "./IncludeFileSection";
import { FileSection } from "./WorkingFileSection";
import { CommitComposer } from "./commit-modal";
import {
  ChangedFileList,
  FileFilterField,
  FileViewToggle,
  filterFilesByName,
  useFileFilter,
} from "./file-list";

/** Inspector for working changes — in Include view one three-state list, in
 * Staging-area view the unstaged/staged sections with inline stage/unstage
 * actions — plus an always-available commit composer. */
export function WorkingInspector({ onOpenChanges }: { onOpenChanges: (all?: boolean) => void }) {
  const changes = useRepo((state) => state.changes);
  const selectedFile = useRepo((state) => state.selectedFile);
  const ensureWorkingFileSelection = useRepo((state) => state.ensureWorkingFileSelection);
  const selectFile = useRepo((state) => state.selectFile);
  const stageFile = useRepo((state) => state.stageFile);
  const unstageFile = useRepo((state) => state.unstageFile);
  const stagePaths = useRepo((state) => state.stagePaths);
  const unstagePaths = useRepo((state) => state.unstagePaths);
  const stageAll = useRepo((state) => state.stageAll);
  const unstageAll = useRepo((state) => state.unstageAll);
  const summary = useRepo((state) => state.summary);
  const view = useUi((state) => state.fileListView);
  const setView = useUi((state) => state.setFileListView);
  const changesView = useUi((state) => state.changesView);
  const setChangesView = useUi((state) => state.setChangesView);
  const including = changesView === ChangesView.Include;
  const openUiMenu = useUi((s) => s.openMenu);
  const fileMenu = useUi(fileMenuOf);
  // Distinct paths: a partly staged file sits in both lists but is one change,
  // as the Changes workspace and the toolbar badge count it.
  const total = new Set([...changes.staged, ...changes.unstaged].map((f) => f.path)).size;
  const notices = advancedNotices(changes);
  const unstagedGuarded = findGuardedFile(changes.unstaged, changes);
  const stagedGuarded = findGuardedFile(changes.staged, changes);
  const stageAllBlocked = fileWriteGuard(unstagedGuarded, changes);
  const unstageAllBlocked = fileWriteGuard(stagedGuarded, changes);
  const discardAllChanges = useDiscardAllChanges(summary?.path ?? null);
  // Whole-tree discard is stricter than staging/stashing: even an in-cone
  // sparse edit is unsafe because the backend must preserve skip-worktree bits.
  const discardAllBlocked = discardAllGuardMessage(changes, summary?.unborn === true);
  // Unmerged paths whose owning operation isn't currently driving the conflict
  // workspace (e.g. `git am`/`bisect`, or a transient detection failure). Shown
  // read-only here so they never vanish from the UI — resolution still happens
  // in the conflict view (or the terminal).
  const conflicted = changes.conflicted ?? [];
  const selectedPath = selectedFile?.source === "commit" ? null : selectedFile?.path ?? null;

  // One filter across every section (unstaged, staged, conflicts) — same
  // reveal-on-demand field as the commit inspector; resets on repo switch.
  const filter = useFileFilter(
    [...changes.unstaged, ...changes.staged, ...conflicted],
    summary?.path ?? null,
  );
  const filtering = !!filter.matchQuery;
  // Conflicts are excluded from `total` but are filterable, so a conflict-only
  // worktree must still offer the field (same reason the Path/Tree toggle below
  // tests both).
  const canFilter = total > 0 || conflicted.length > 0;
  const filterList = (files: FileChange[]) => filterFilesByName(files, filter.matchQuery);
  const fUnstaged = filterList(changes.unstaged);
  const fStaged = filterList(changes.staged);
  const fConflicted = filterList(conflicted);
  const countsSummary = summarizeChanges(
    filtering ? { ...changes, unstaged: fUnstaged, staged: fStaged, conflicted: fConflicted } : changes,
  );

  const openMenu = (file: FileChange, staged: boolean, e: MouseEvent) => {
    e.preventDefault();
    // Discard is suppressed inside FileContextMenu for renames (half-undo risk),
    // but the row still gets Ignore / Open / Reveal / History (ADR 0002).
    openUiMenu({ kind: MenuKind.File, state: { kind: FileMenuKind.Working, x: e.clientX, y: e.clientY, path: file.path, discard: { staged } } });
  };
  const openDirMenu = (dirPath: string, e: MouseEvent) => {
    e.preventDefault();
    openUiMenu({ kind: MenuKind.File, state: { kind: FileMenuKind.Directory, x: e.clientX, y: e.clientY, path: dirPath, working: true } });
  };

  // The open menu's target path, but only for the matching section — so a file
  // staged *and* unstaged at once highlights just the row that was clicked.
  const menuPathFor = (staged: boolean) =>
    fileMenu?.kind === FileMenuKind.Working && fileMenu.discard.staged === staged
      ? fileMenu.path
      : null;

  // Selection fallback and staged/unstaged bucket ownership are git-domain
  // rules, so the store reconciles them when this inspector becomes active.
  useEffect(() => {
    ensureWorkingFileSelection();
  }, [changes, ensureWorkingFileSelection, selectedFile?.path, selectedFile?.source]);

  const openFile = (path: string, source: "unstaged" | "staged") => {
    void selectFile(path, source);
    onOpenChanges();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Horizontal padding matches the Files tab (`px-2`): chrome stays inset,
          while Path/Tree file rows own their own edge padding so the Tree view
          lines up with the repository Files tree. */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto pb-5 pt-1.5">
        <div className="flex items-center gap-2 px-2">
          <h1 className="min-w-0 truncate text-[16px] font-semibold text-neutral-800 dark:text-neutral-100">
            <span>{total} change{total === 1 ? "" : "s"} on </span>
            <span className="text-[color:var(--accent)]">{summary?.headBranch ?? "HEAD"}</span>
          </h1>
          {canFilter && !filter.open && (
            <button
              type="button"
              title="Filter files"
              aria-label="Filter files"
              onClick={filter.openFilter}
              className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-neutral-400 hover:bg-black/[0.05] hover:text-neutral-600 dark:hover:bg-white/[0.06] dark:hover:text-neutral-300"
            >
              <SearchIcon className="h-[15px] w-[15px]" />
            </button>
          )}
          {total > 0 && (
            <button type="button"
              className="ml-auto shrink-0 text-xs font-medium text-[color:var(--accent)] hover:underline"
              onClick={() => onOpenChanges(true)}
            >
              review all →
            </button>
          )}
        </div>

        {total > 0 && (
          <div className="px-2">
            <ChangesViewToggle view={changesView} onChange={setChangesView} />
          </div>
        )}

        {filter.open && (
          <FileFilterField
            query={filter.query}
            onQuery={filter.setQuery}
            onClose={filter.close}
          />
        )}

        {/* Show the toggle whenever any list is populated — including a
            conflict-only tree mid-merge (conflicts are excluded from `total`,
            but the conflicts list below still honours the Path/Tree view). */}
        {(total > 0 || conflicted.length > 0) && (
          <div className="flex items-center justify-between px-2">
            <div className="flex items-center gap-2">
              <ChangeTypeCounts summary={countsSummary} />
              {/* Discard-all sits quietly next to the change counts: a grey trash
                  icon behind a divider that, on hover, reddens and reveals its
                  "Discard all" label — a destructive whole-tree action that
                  doesn't compete for attention with the primary controls. */}
              {/* The divider and the trash icon pair up as one discard control:
                  grouped tightly together, set apart from the change counts. */}
              {total > 0 && (
                <div className="flex items-center gap-1">
                  <span aria-hidden className="h-3.5 w-px flex-none bg-black/10 dark:bg-white/10" />
                  {/* Reads as a quiet link: a grey trash icon sized to the change
                      counts that reddens and reveals its "Discard all" label on
                      hover or keyboard focus — a real <button> (it runs an action,
                      not navigation), so keyboard users get the focus ring and the
                      label without a pointer. */}
                  <button
                    type="button"
                    aria-label="Discard all changes"
                    title={discardAllBlocked ?? "Discard all changes"}
                    onClick={discardAllBlocked ? undefined : discardAllChanges}
                    disabled={!!discardAllBlocked}
                    className="group ml-0.5 inline-flex items-center rounded text-neutral-400 transition hover:text-red-600 focus-visible:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/40 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-neutral-400 dark:hover:text-red-400 dark:focus-visible:text-red-400"
                  >
                    <TrashIcon className="h-3 w-3 group-hover:hidden group-focus-visible:hidden" />
                    <span className="hidden text-[12px] font-medium underline underline-offset-2 group-hover:inline group-focus-visible:inline">
                      Discard all
                    </span>
                  </button>
                </div>
              )}
            </div>
            <FileViewToggle view={view} onChange={setView} />
          </div>
        )}

        {/* Keyed on the unfiltered list: a filter that matches no conflict must
            narrow this section, never erase it — unresolved paths are git state
            the user has to act on, so they can't look absent. */}
        {conflicted.length > 0 && (
          <div>
            <div className="mb-1 flex items-center justify-between px-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">
                Conflicts ({filtering ? `${fConflicted.length} / ${conflicted.length}` : conflicted.length})
              </span>
            </div>
            <div className="mb-1.5 px-2 text-[12px] text-neutral-400">
              Unresolved paths git still considers conflicted. Resolve them in the conflict view or your terminal.
            </div>
            {fConflicted.length === 0 ? (
              <div className="px-2 py-1 text-[13px] text-neutral-400">No files match the filter.</div>
            ) : (
              /* Read-only (no stage/unstage) but honours the Path/Tree toggle so
                 the layout stays consistent with the sections below. */
              <ChangedFileList
                files={fConflicted}
                view={view}
                compact={false}
                activePath={null}
                onSelect={() => {}}
                forceExpanded={filtering}
                highlight={filter.matchQuery}
              />
            )}
          </div>
        )}

        {notices.length > 0 && (
          <div className="px-2">
            <AdvancedRepoBanner notices={notices} variant="card" />
          </div>
        )}

        {including ? (
          <IncludeFileSection
            changes={changes}
            query={filter.matchQuery}
            forceExpanded={filtering}
            view={view}
            selectedPath={selectedPath}
            menuPath={
              fileMenu?.kind === FileMenuKind.Working ? fileMenu.path : null
            }
            onSelect={openFile}
            onContextMenu={(path, staged, e) => {
              e.preventDefault();
              openUiMenu({ kind: MenuKind.File, state: { kind: FileMenuKind.Working, x: e.clientX, y: e.clientY, path, discard: { staged } } });
            }}
            onDirContextMenu={openDirMenu}
          />
        ) : (
        <>
        <FileSection
          title="Unstaged"
          files={fUnstaged}
          totalCount={changes.unstaged.length}
          highlight={filter.matchQuery}
          forceExpanded={filtering}
          view={view}
          selectedPath={selectedPath}
          tone="stage"
          allLabel="Stage all"
          onAll={stageAll}
          allDisabledReason={stageAllBlocked}
          changes={changes}
          onAction={stageFile}
          onDirAction={stagePaths}
          onSelect={(p) => openFile(p, "unstaged")}
          onContextMenu={(f, e) => openMenu(f, false, e)}
          onDirContextMenu={openDirMenu}
          menuPath={menuPathFor(false)}
        />
        <FileSection
          title="Staged"
          files={fStaged}
          totalCount={changes.staged.length}
          highlight={filter.matchQuery}
          forceExpanded={filtering}
          view={view}
          selectedPath={selectedPath}
          tone="unstage"
          allLabel="Unstage all"
          onAll={unstageAll}
          allDisabledReason={unstageAllBlocked}
          changes={changes}
          onAction={unstageFile}
          onDirAction={unstagePaths}
          onSelect={(p) => openFile(p, "staged")}
          onContextMenu={(f, e) => openMenu(f, true, e)}
          onDirContextMenu={openDirMenu}
          menuPath={menuPathFor(true)}
        />
        </>
        )}
      </div>

      {/* The composer owns its padding — collapsed it is a full-bleed bar. */}
      <div className="max-h-[55%] shrink-0 overflow-auto border-t border-black/5 dark:border-white/5">
        <CommitComposer />
      </div>
    </div>
  );
}

