import type { CommitNode, StashEntry } from "@/lib/api";
import { StashIcon } from "@/components/ui/icons";
import { summarizeFiles } from "@/lib/changeSummary";
import { fullCommitMessage, splitCommitMessage } from "@/lib/commitMessage";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { CommitBody } from "./CommitBody";
import { CommitPeople, personVisual } from "./CommitPeople";
import { ChangeTypeCounts } from "./ChangeTypeCounts";
import { ChangedFileList, FileViewToggle } from "./file-list";
import { canRestoreCommittedFile } from "./committedFileMenu";
import { useInspectorCommit } from "./useInspectorCommit";

/** Inspector for a selected commit — metadata, the (collapsible) message,
 * author block, and the list of changed files with a "review all" entry. */
export function CommitInspector() {
  const commitFiles = useRepo((state) => state.commitFiles);
  const selectedFile = useRepo((state) => state.selectedFile);
  const selectFile = useRepo((state) => state.selectFile);
  const amendHeadMessage = useRepo((state) => state.amendHeadMessage);
  const openStackedReview = useUi((state) => state.openStackedReview);
  const openFileMenu = useUi((state) => state.openFileMenu);
  const requestPrompt = useUi((state) => state.requestPrompt);
  const fileMenu = useUi((state) => state.fileMenu);
  const showToast = useUi((state) => state.showToast);
  const view = useUi((state) => state.fileListView);
  const setView = useUi((state) => state.setFileListView);
  // The selected commit/stash identity is shared with the header's identity +
  // Checkout bar (`CommitCheckoutBar`), which renders the SHA pill and Checkout.
  const { selected, selectedStash, selectedOid, selectedShortLabel, selectedTitle, selectedBody, canEditMessage } =
    useInspectorCommit();

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

      <div className="flex items-center justify-between px-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
          Changed files{commitFiles.length > 0 ? ` (${commitFiles.length})` : ""}
        </span>
        {commitFiles.length > 0 && (
          <button type="button"
            className="text-xs font-medium text-[color:var(--accent)] hover:underline"
            onClick={() => openStackedReview(selectedOid, reviewTitle)}
          >
            review all →
          </button>
        )}
      </div>
      {commitFiles.length > 0 && (
        <div className="flex items-center justify-between px-2">
          <ChangeTypeCounts summary={summarizeFiles(commitFiles)} />
          <FileViewToggle view={view} onChange={setView} />
        </div>
      )}
      {commitFiles.length === 0 ? (
        <div className="px-2 py-1 text-[13px] text-neutral-400">No file list loaded.</div>
      ) : (
        <ChangedFileList
          files={commitFiles}
          view={view}
          activePath={selectedFile?.source === "commit" ? selectedFile.path : null}
          menuActivePath={!fileMenu?.discard ? fileMenu?.path ?? null : null}
          onSelect={(path) => selectFile(path, "commit")}
          onContextMenu={(path, e) => {
            e.preventDefault();
            const file = commitFiles.find((entry) => entry.path === path);
            openFileMenu({
              x: e.clientX,
              y: e.clientY,
              path,
              ...(selectedOid && canRestoreCommittedFile(file, selectedOid)
                ? { restore: { commitOid: selectedOid } }
                : {}),
            });
          }}
          onDirContextMenu={(dirPath, e) => {
            e.preventDefault();
            openFileMenu({ x: e.clientX, y: e.clientY, path: dirPath, dir: true });
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
        <div className="ml-auto shrink-0 text-right text-[11px] text-neutral-400">
          <div>parent</div>
          <div className="font-mono">{commit.parents[0]?.slice(0, 7) ?? "root"}</div>
        </div>
      </div>
      <CommitPeople body={commit.body} />
    </div>
  );
}
