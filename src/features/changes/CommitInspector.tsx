import { useEffect, useRef, useState } from "react";
import type { CommitNode, StashEntry } from "../../lib/api";
import { CheckIcon, StashIcon } from "../../components/ui/icons";
import { cn } from "../../lib/cn";
import { summarizeFiles } from "../../lib/changeSummary";
import { fullCommitMessage, splitCommitMessage } from "../../lib/commitMessage";
import { useRepo } from "../../store/repo";
import { isCommitReachableFromRemote } from "../../store/selection";
import { useUi } from "../../store/ui";
import { CommitBody } from "./CommitBody";
import { ChangeTypeCounts } from "./ChangeTypeCounts";
import { ChangedFileList, FileViewToggle, type FileListView } from "./file-list";
import { initials } from "./commitMeta";

/** Inspector for a selected commit — metadata, the (collapsible) message,
 * author block, and the list of changed files with a "review all" entry. */
export function CommitInspector() {
  const graph = useRepo((state) => state.graph);
  const stashes = useRepo((state) => state.stashes);
  const selectedCommit = useRepo((state) => state.selectedCommit);
  const commitFiles = useRepo((state) => state.commitFiles);
  const selectedFile = useRepo((state) => state.selectedFile);
  const selectFile = useRepo((state) => state.selectFile);
  const checkoutDetached = useRepo((state) => state.checkoutDetached);
  const amendHeadMessage = useRepo((state) => state.amendHeadMessage);
  const summary = useRepo((state) => state.summary);
  const openStackedReview = useUi((state) => state.openStackedReview);
  const openFileMenu = useUi((state) => state.openFileMenu);
  const requestPrompt = useUi((state) => state.requestPrompt);
  const fileMenu = useUi((state) => state.fileMenu);
  const showToast = useUi((state) => state.showToast);
  const [view, setView] = useState<FileListView>("path");
  // Transient "Copied" state for the SHA pill (replaces the separate button +
  // toast with inline feedback). Cleared after a short beat.
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);
  useEffect(() => () => { if (copyTimer.current) window.clearTimeout(copyTimer.current); }, []);
  // Exclude in-window stash nodes (now part of `graph.commits`): a selected stash
  // must fall through to the `selectedStash` → StashMeta path, not render as a
  // commit with empty author. The default fallback likewise skips stash nodes.
  const selectedGraphCommit = graph?.commits.find(
    (commit) => commit.id === selectedCommit && !commit.stash,
  );
  // Prefer the rich entry from `listStashes`, but if that list hasn't landed yet
  // the selected stash may exist only as a graph node — synthesise an entry from
  // it so the inspector shows the stash instead of briefly falling back to a commit.
  const selectedStashNode = graph?.commits.find(
    (commit) => commit.id === selectedCommit && commit.stash,
  );
  const selectedStash =
    stashes.find((stash) => stash.oid === selectedCommit) ??
    (selectedStashNode?.stash
      ? {
          index: selectedStashNode.stash.index,
          message: selectedStashNode.stash.message,
          oid: selectedStashNode.id,
          timestamp: selectedStashNode.timestamp,
          baseOid: selectedStashNode.parents[0] ?? null,
          baseTimestamp: null,
          context: [],
        }
      : undefined);
  const selected =
    selectedGraphCommit ?? (selectedStash ? null : graph?.commits.find((commit) => !commit.stash));
  const selectedOid = selected?.id ?? selectedStash?.oid;
  const selectedShortLabel = selected?.shortId ?? (selectedStash ? `stash@{${selectedStash.index}}` : "");
  const selectedTitle = selected?.summary ?? selectedStash?.message ?? "";
  const selectedBody = selected?.body ?? "";
  const canEditMessage =
    !!summary?.headBranch &&
    !!selected &&
    graph?.head === selected.id &&
    !isCommitReachableFromRemote(graph, selected.id);

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
  const copySha = () => {
    try {
      void navigator.clipboard.writeText(selectedOid);
      setCopied(true);
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* ignore */
    }
  };
  const editMessage = () => {
    if (!selected) return;
    requestPrompt({
      title: "Edit commit message",
      message: "This commit has not been pushed.",
      placeholder: "Subject\n\nDescription",
      defaultValue: fullCommitMessage(selected.summary, selected.body),
      multiline: true,
      confirmLabel: "Update message",
      onSubmit: (value) => {
        const next = splitCommitMessage(value);
        void amendHeadMessage(next.summary, next.description).then(
          (toast) => showToast(toast),
          (error) => showToast(String(error), "error"),
        );
      },
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-5">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={copySha}
          title="Copy SHA"
          aria-label={copied ? "SHA copied" : "Copy SHA"}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-mono text-xs transition-colors duration-200",
            copied
              ? "bg-[var(--accent-soft)] text-[color:var(--accent)]"
              : "bg-black/[0.05] text-neutral-500 hover:bg-black/[0.08] dark:bg-white/[0.06] dark:text-neutral-400 dark:hover:bg-white/[0.1]",
          )}
        >
          {copied ? (
            <>
              <CheckIcon className="h-3.5 w-3.5" />
              Copied
            </>
          ) : (
            <>
              {selectedStash && !selected ? <StashIcon className="h-3.5 w-3.5 text-amber-500" /> : null}
              {selectedStash && !selected ? selectedShortLabel : `commit ${selectedShortLabel}`}
            </>
          )}
        </button>
        {selected ? (
          <button
            className="ml-auto h-8 rounded-lg border border-black/10 px-3 text-[13px] text-neutral-600 hover:bg-black/5 dark:border-white/10 dark:text-neutral-300 dark:hover:bg-white/5"
            onClick={() => void checkoutDetached(selected.id).catch((e) => showToast(String(e), "error"))}
          >
            Checkout
          </button>
        ) : null}
      </div>

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

      {selected ? <CommitMeta commit={selected} /> : <StashMeta stash={selectedStash!} />}

      <div className="h-px bg-black/5 dark:bg-white/5" />

      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
          Changed files{commitFiles.length > 0 ? ` (${commitFiles.length})` : ""}
        </span>
        {commitFiles.length > 0 && (
          <button
            className="text-xs font-medium text-[color:var(--accent)] hover:underline"
            onClick={() => openStackedReview(selectedOid, reviewTitle)}
          >
            review all →
          </button>
        )}
      </div>
      {commitFiles.length > 0 && (
        <div className="flex items-center justify-between">
          <ChangeTypeCounts summary={summarizeFiles(commitFiles)} />
          <FileViewToggle view={view} onChange={setView} />
        </div>
      )}
      {commitFiles.length === 0 ? (
        <div className="px-1 py-1 text-[13px] text-neutral-400">No file list loaded.</div>
      ) : (
        <ChangedFileList
          files={commitFiles}
          view={view}
          activePath={selectedFile?.source === "commit" ? selectedFile.path : null}
          menuActivePath={!fileMenu?.discard ? fileMenu?.path ?? null : null}
          onSelect={(path) => selectFile(path, "commit")}
          onContextMenu={(path, e) => {
            // Committed files: copy-only menu (no working-tree discard).
            e.preventDefault();
            openFileMenu({ x: e.clientX, y: e.clientY, path });
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

  return (
    <div className="flex items-start gap-3 rounded-xl bg-black/[0.03] p-3 dark:bg-white/[0.04]">
      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[var(--accent)] text-xs font-semibold text-white">
        {initials(commit.authorName)}
      </div>
      <div className="min-w-0">
        <div className="text-[13px] font-semibold text-neutral-800 dark:text-neutral-100">
          {commit.authorName}
        </div>
        <div className="truncate text-xs text-neutral-500 dark:text-neutral-400">{commit.authorEmail}</div>
        <div className="mt-0.5 text-xs text-neutral-400">authored {date}</div>
      </div>
      <div className="ml-auto shrink-0 text-right text-[11px] text-neutral-400">
        <div>parent</div>
        <div className="font-mono">{commit.parents[0]?.slice(0, 7) ?? "root"}</div>
      </div>
    </div>
  );
}
