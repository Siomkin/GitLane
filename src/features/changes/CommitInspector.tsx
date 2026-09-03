import type { CommitNode, StashEntry } from "@/lib/api";
import { StashIcon } from "@/components/ui/icons";
import { summarizeFiles } from "@/lib/changeSummary";
import { cn } from "@/lib/cn";
import { fullCommitMessage, splitCommitMessage } from "@/lib/commitMessage";
import { parentInspectLabel, inspectParentRangeFromGraph } from "@/lib/inspectParent";
import { useRepo } from "@/store/repo";
import { useUi, fileMenuOf, FileMenuKind, MenuKind } from "@/store/ui";
import { CommitBody } from "./CommitBody";
import { CommitPeople, personVisual } from "./CommitPeople";
import { ChangeTypeCounts } from "./ChangeTypeCounts";
import { ChangedFileList, FileFilterField, FileViewToggle, useFileFilter } from "./file-list";
import { SearchIcon } from "@/components/ui/icons";
import { canRestoreCommittedFile } from "./committedFileMenu";
import { useInspectorCommit } from "./useInspectorCommit";

/** Inspector for a selected commit — metadata, the (collapsible) message,
 * author block, and the list of changed files with a "review all" entry. */
export function CommitInspector() {
  const commitFiles = useRepo((state) => state.commitFiles);
  const selectedFile = useRepo((state) => state.selectedFile);
  const selectFile = useRepo((state) => state.selectFile);
  const inspectParentIndex = useRepo((state) => state.inspectParentIndex);
  const graph = useRepo((state) => state.graph);
  const compareRange = useRepo((state) => state.compareRange);
  const amendHeadMessage = useRepo((state) => state.amendHeadMessage);
  const openStackedReview = useUi((state) => state.openStackedReview);
  const openMenu = useUi((s) => s.openMenu);
  const requestEditCommitMessage = useUi((state) => state.requestEditCommitMessage);
  const fileMenu = useUi(fileMenuOf);
  const showToast = useUi((state) => state.showToast);
  const view = useUi((state) => state.fileListView);
  const setView = useUi((state) => state.setFileListView);
  // The selected commit/stash identity is shared with the header's identity +
  // Checkout bar (`CommitCheckoutBar`), which renders the SHA pill and Checkout.
  const { selected, selectedStash, selectedOid, selectedShortLabel, selectedTitle, selectedBody, canEditMessage } =
    useInspectorCommit();
  const filter = useFileFilter(commitFiles, selectedOid);
  const filtering = !!filter.matchQuery;

  if (!selectedOid) {
    return (
      <div className="grid min-h-[220px] place-content-center gap-1.5 px-6 text-center">
        <h3 className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">Select a commit</h3>
        <p className="mx-auto max-w-[340px] text-xs leading-normal text-neutral-400">
          Click any row in the graph to inspect metadata, refs, files, and diff hunks.
        </p>
      </div>
    );
  }

  const reviewTitle = `Reviewing ${commitFiles.length} file${commitFiles.length === 1 ? "" : "s"} · ${selectedShortLabel}`;
  const editMessage = () => {
    if (!selected) return;
    requestEditCommitMessage({
      message: "This commit has not been pushed.",
      defaultValue: fullCommitMessage(selected.summary, selected.body),
      onSubmit: (value) => {
        const next = splitCommitMessage(value);
        void amendHeadMessage(next.summary, next.description).catch((error) =>
          showToast(error, "error"),
        );
      },
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto pb-5 pt-4">
      <div className="px-2">
        <div
          onDoubleClick={canEditMessage ? editMessage : undefined}
          title={canEditMessage ? "Double-click to edit commit message" : undefined}
          className={canEditMessage ? "cursor-text rounded-lg -m-1 p-1 hover:bg-black/[0.03] dark:hover:bg-white/[0.04]" : undefined}
        >
          <h1 className="text-[19px] font-semibold leading-snug text-neutral-800 dark:text-neutral-100 text-pretty">
            {selectedTitle}
          </h1>
          {selectedBody && <CommitBody key={selectedOid} body={selectedBody} />}
        </div>
      </div>

      <div className="px-2">
        {selected ? <CommitMeta commit={selected} /> : <StashMeta stash={selectedStash!} />}
      </div>

      <div className="mx-2 h-px bg-black/5 dark:bg-white/5" />

      <div className="flex items-center gap-2 px-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
          {filtering ? "Matching files" : "Changed files"}
          {commitFiles.length > 0 && (
            <>
              {" ("}
              <span className="font-mono normal-case tracking-normal">
                {filtering
                  ? `${filter.filtered.length} / ${commitFiles.length}`
                  : commitFiles.length}
              </span>
              {")"}
            </>
          )}
        </span>
        {commitFiles.length > 0 && !filter.open && (
          <button
            type="button"
            title="Filter files"
            aria-label="Filter files"
            onClick={filter.openFilter}
            className="grid h-6 w-6 place-items-center rounded-md text-neutral-400 hover:bg-black/[0.05] hover:text-neutral-600 dark:hover:bg-white/[0.06] dark:hover:text-neutral-300"
          >
            <SearchIcon className="h-[15px] w-[15px]" />
          </button>
        )}
        {commitFiles.length > 0 && (
          <button type="button"
            className="ml-auto text-xs font-medium text-[color:var(--accent)] hover:underline"
            onClick={() => {
              const range = inspectParentRangeFromGraph(graph, selectedOid, inspectParentIndex);
              if (range) compareRange(range.base, range.head, reviewTitle);
              else openStackedReview(selectedOid, reviewTitle);
            }}
          >
            review all →
          </button>
        )}
      </div>
      {filter.open && (
        <FileFilterField
          query={filter.query}
          onQuery={filter.setQuery}
          onClose={filter.close}
        />
      )}
      {commitFiles.length > 0 && (
        <div className="flex items-center justify-between px-2">
          <ChangeTypeCounts summary={summarizeFiles(filter.filtered)} />
          <FileViewToggle view={view} onChange={setView} />
        </div>
      )}
      {commitFiles.length === 0 ? (
        <div className="px-2 py-1 text-[13px] text-neutral-400">No file list loaded.</div>
      ) : filtering && filter.filtered.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-2 pt-10 text-center">
          <span className="text-[13px] text-neutral-500 dark:text-neutral-400">
            No files match “<span className="font-mono text-neutral-700 dark:text-neutral-200">{filter.query.trim()}</span>”.
          </span>
          <button
            type="button"
            onClick={filter.close}
            className="text-xs font-medium text-[color:var(--accent)] hover:underline"
          >
            Clear filter
          </button>
        </div>
      ) : (
        <ChangedFileList
          files={filter.filtered}
          forceExpanded={filtering}
          highlight={filter.matchQuery}
          view={view}
          activePath={selectedFile?.source === "commit" ? selectedFile.path : null}
          menuActivePath={fileMenu?.kind !== FileMenuKind.Working ? fileMenu?.path ?? null : null}
          onSelect={(path) => selectFile(path, "commit")}
          onContextMenu={(path, e) => {
            e.preventDefault();
            const file = commitFiles.find((entry) => entry.path === path);
            openMenu({ kind: MenuKind.File, state: {
              kind: FileMenuKind.Committed,
              x: e.clientX,
              y: e.clientY,
              path,
              ...(selectedOid && canRestoreCommittedFile(file, selectedOid)
                ? { restore: { commitOid: selectedOid } }
                : {}),
            } });
          }}
          onDirContextMenu={(dirPath, e) => {
            e.preventDefault();
            openMenu({ kind: MenuKind.File, state: { kind: FileMenuKind.Directory, x: e.clientX, y: e.clientY, path: dirPath, working: false } });
          }}
        />
      )}
    </div>
  );
}

function StashMeta({ stash }: { stash: StashEntry }) {
  const base = stash.baseOid?.slice(0, 7) ?? "unknown";

  return (
    <div className="flex items-start gap-3 rounded-xl bg-amber-500/[0.07] p-3 dark:bg-amber-400/[0.08]">
      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-amber-500 text-white dark:bg-amber-400 dark:text-neutral-950">
        <StashIcon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <div className="text-[13px] font-semibold text-neutral-800 dark:text-neutral-100">
          Saved worktree snapshot
        </div>
        <div className="truncate text-xs text-neutral-500 dark:text-neutral-400">{stash.oid}</div>
      </div>
      <div className="ml-auto shrink-0 text-right text-[11px] text-neutral-400">
        <div>base</div>
        <div className="font-mono">{base}</div>
      </div>
    </div>
  );
}

function CommitMeta({ commit }: { commit: CommitNode }) {
  const date = new Date(commit.timestamp * 1000).toLocaleString();
  const overrides = useUi((state) => state.identityColors);
  // Same resolver as the graph node / hover card / trailer rows, so a known
  // agent author shows its branded glyph here too (not generic initials).
  const author = personVisual({ name: commit.authorName, email: commit.authorEmail }, overrides);
  const mergeParents = commit.parents.length > 1;

  return (
    <div className="rounded-xl bg-black/[0.03] p-3 dark:bg-white/[0.04]">
      <div className="flex items-start gap-3">
        <div
          className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-full text-xs font-semibold text-white"
          style={{ background: author.color }}
        >
          {author.iconUrl ? <img src={author.iconUrl} alt="" className="h-5 w-5" /> : author.initials}
        </div>
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-neutral-800 dark:text-neutral-100">
            {commit.authorName}
          </div>
          <div className="truncate text-xs text-neutral-500 dark:text-neutral-400">{commit.authorEmail}</div>
          <div className="mt-0.5 text-xs text-neutral-400">authored {date}</div>
        </div>
        {!mergeParents && (
          <div className="ml-auto shrink-0 text-right text-[11px] text-neutral-400">
            <div>parent</div>
            <div className="font-mono">{commit.parents[0]?.slice(0, 7) ?? "root"}</div>
          </div>
        )}
      </div>
      {mergeParents && <MergeParentPicker commit={commit} />}
      <CommitPeople body={commit.body} />
    </div>
  );
}

const parentBtn = (active: boolean) =>
  cn(
    "max-w-full truncate rounded-md px-2 py-0.5 font-mono text-[11px]",
    active
      ? "bg-white font-medium text-neutral-800 shadow-sm dark:bg-neutral-700 dark:text-neutral-100"
      : "text-neutral-500 dark:text-neutral-400",
  );

function MergeParentPicker({ commit }: { commit: CommitNode }) {
  const inspectParentIndex = useRepo((state) => state.inspectParentIndex);
  const setInspectParentIndex = useRepo((state) => state.setInspectParentIndex);
  const branches = useRepo((state) => state.branches);
  const graph = useRepo((state) => state.graph);

  return (
    <div className="mt-2.5">
      <div className="mb-1 text-[11px] text-neutral-400">Diff against parent</div>
      <div
        role="group"
        aria-label="Diff against parent"
        className="flex flex-wrap gap-0.5 rounded-lg bg-black/[0.06] p-0.5 dark:bg-white/[0.06]"
      >
        {commit.parents.map((oid, index) => {
          const parentNode = graph?.commits.find((node) => node.id === oid);
          const label = parentInspectLabel(oid, branches, parentNode?.refs ?? []);
          return (
            <button
              key={`${index}:${oid}`}
              type="button"
              aria-pressed={inspectParentIndex === index}
              title={label}
              className={parentBtn(inspectParentIndex === index)}
              onClick={() => void setInspectParentIndex(index)}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
