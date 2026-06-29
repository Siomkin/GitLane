// The "Commit Changes" modal raised by the Start-commit button. Operates on the
// staged set: every file can be excluded from this commit (unchecked), the body
// switches between a flat List and a collapsible Tree with an inline diff
// preview, and the footer commits (optionally handing the message to an agent in
// the terminal). See store/ui.ts (commit* state) and store/repo.ts
// (commitSelected).

import { useEffect, useState, type ReactNode } from "react";
import { type FileChange } from "../../lib/api";
import { fileWriteGuard, findGuardedFile } from "../../lib/advancedRepoState";
import { cn } from "../../lib/cn";
import { fullCommitMessage } from "../../lib/commitMessage";
import { basename, dirname } from "../../lib/paths";
import { useRepo } from "../../store/repo";
import { useUi } from "../../store/ui";
import { CheckIcon, FileIcon } from "@/components/ui/icons";
import { Resizer } from "@/components/ui/Resizer";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { DiffPreview } from "./DiffPreview";
import { buildRows } from "./commitTree";
import { isCommitReachableFromRemote } from "@/store/selection";

const TREE_MIN_WIDTH = 300;
const TREE_DEFAULT_WIDTH = 360;
const TREE_MAX_WIDTH = 520;

export const CommitModal = () => {
  const open = useUi((s) => s.commitOpen);
  const close = useUi((s) => s.closeCommit);
  const view = useUi((s) => s.commitView);
  const setView = useUi((s) => s.setCommitView);
  const msg = useUi((s) => s.commitMsg);
  const setMsg = useUi((s) => s.setCommitMsg);
  const excluded = useUi((s) => s.commitExcluded);
  const sendToTerminal = useUi((s) => s.sendToTerminal);
  const showToast = useUi((s) => s.showToast);
  const changes = useRepo((s) => s.changes);
  const staged = changes.staged;
  const summary = useRepo((s) => s.summary);
  const graph = useRepo((s) => s.graph);
  const commitSelected = useRepo((s) => s.commitSelected);
  const [amend, setAmend] = useState(false);

  const headCommit = graph?.commits.find((commit) => commit.id === graph.head && !commit.stash) ?? null;
  const canAmend =
    !!summary?.headBranch &&
    !!headCommit &&
    !isCommitReachableFromRemote(graph, headCommit.id);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);

  useEffect(() => {
    if (!open) return;
    setAmend(false);
  }, [open]);

  useEffect(() => {
    if (!canAmend) setAmend(false);
  }, [canAmend]);

  if (!open) return null;

  const branch = summary?.headBranch ?? "HEAD";
  const excludedPaths = staged.filter((f) => excluded[f.path]).map((f) => f.path);
  const included = staged.filter((f) => !excluded[f.path]);
  const includedGuarded = findGuardedFile(included, changes);
  const commitBlocked = fileWriteGuard(includedGuarded, changes);
  const includedCount = included.length;
  const canCommit = includedCount > 0 && msg.trim().length > 0 && !commitBlocked;

  const doCommit = () => {
    if (!canCommit) return;
    void commitSelected(msg.trim(), excludedPaths, amend);
    close();
  };

  const commitWithAgent = () => {
    const instruction =
      msg.trim() ||
      (amend
        ? "Review the staged changes, add them to the previous commit, and update the commit message if needed."
        : "Review the staged changes, write a concise conventional-commit message, and commit them.");
    sendToTerminal(instruction);
    showToast("Sent to terminal — run your agent there");
    close();
  };

  const toggleAmend = () => {
    if (!canAmend) return;
    const next = !amend;
    setAmend(next);
    const prefill = headCommit ? fullCommitMessage(headCommit.summary, headCommit.body) : "";
    if (next) {
      if (msg.trim().length === 0 && prefill) setMsg(prefill);
    } else if (msg === prefill) {
      // Turning amend off: drop the auto-prefilled HEAD message when the user
      // hasn't edited it, so a normal commit doesn't silently reuse it.
      setMsg("");
    }
  };

  const modalSize =
    view === "tree"
      ? "h-[760px] w-[1280px] max-h-[calc(100vh-4rem)] max-w-[calc(100vw-4rem)]"
      : "h-[560px] w-[920px] max-h-[90%] max-w-full";

  return (
    <div
      className="fixed inset-0 z-[58] grid place-items-center bg-black/30 p-8 backdrop-blur-sm"
      onClick={close}
    >
      <div
        className={cn(
          "flex flex-col overflow-hidden rounded-2xl border border-black/10 bg-white shadow-[0_40px_80px_-12px_rgba(0,0,0,0.5)] dark:border-white/10 dark:bg-neutral-800",
          modalSize,
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-black/5 px-5 dark:border-white/5">
          <span className="text-[15px] font-semibold text-neutral-800 dark:text-neutral-100">
            Commit Changes
          </span>
          <span className="text-[12px] text-neutral-400">
            {includedCount} staged · {branch}
          </span>
          <div className="ml-auto flex rounded-lg bg-black/[0.06] p-0.5 text-[12px] dark:bg-white/[0.06]">
            <SegBtn active={view === "list"} onClick={() => setView("list")}>
              List
            </SegBtn>
            <SegBtn active={view === "tree"} onClick={() => setView("tree")}>
              Tree
            </SegBtn>
          </div>
          <button
            onClick={close}
            className="grid h-7 w-7 place-items-center rounded-md text-neutral-400 hover:bg-black/5 dark:hover:bg-white/5"
            title="Close"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {staged.length === 0 ? (
          <div className="flex-1 px-5 py-6 text-[13px] text-neutral-400">
            No staged files — stage files first, or commit with an agent.
          </div>
        ) : view === "list" ? (
          <ListView staged={staged} />
        ) : (
          <TreeView staged={staged} repoPath={summary?.path ?? null} />
        )}

        <div className="shrink-0 space-y-2.5 border-t border-black/5 px-4 pb-3 pt-3 dark:border-white/5">
          {commitBlocked && (
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.07] px-3 py-2 text-[12px] leading-5 text-amber-700 dark:text-amber-300">
              {commitBlocked}
            </div>
          )}
          {canAmend && (
            <button
              type="button"
              role="switch"
              aria-checked={amend}
              onClick={toggleAmend}
              className="flex w-full items-center gap-3 rounded-lg border border-black/10 px-3 py-2 text-left hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5"
            >
              <span
                className={cn(
                  "flex h-5 w-9 shrink-0 rounded-full p-0.5 transition-colors",
                  amend ? "justify-end bg-[var(--accent)]" : "justify-start bg-black/15 dark:bg-white/20",
                )}
              >
                <span className="h-4 w-4 rounded-full bg-white shadow-sm" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium text-neutral-800 dark:text-neutral-100">
                  Add to previous commit
                </span>
                <span className="block truncate text-[11.5px] text-neutral-400">
                  Available because {headCommit?.shortId} has not been pushed
                </span>
              </span>
            </button>
          )}
          <textarea
            value={msg}
            onChange={(e) => setMsg(e.target.value)}
            placeholder={amend ? "Amended commit message" : "Commit message (optional — leave empty to let the agent write it)"}
            className="h-14 w-full resize-none rounded-lg border border-black/10 bg-transparent p-2.5 text-[13px] text-neutral-800 outline-none placeholder:text-neutral-400 focus:border-[color:var(--accent)] dark:border-white/10 dark:text-neutral-100"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={commitWithAgent}
              className="flex h-9 items-center gap-1.5 rounded-lg border border-black/10 px-3.5 text-[13px] font-medium text-neutral-700 hover:bg-black/5 dark:border-white/10 dark:text-neutral-200 dark:hover:bg-white/5"
            >
              <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4 text-[color:var(--accent)]">
                <path d="M12 3l1.6 4.9L18.5 9.5l-4.9 1.6L12 16l-1.6-4.9L5.5 9.5l4.9-1.6z" />
              </svg>
              Commit with agent
            </button>
            <div className="ml-auto flex gap-2">
              <button
                onClick={close}
                className="h-9 rounded-lg px-4 text-[13px] text-neutral-600 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/5"
              >
                Cancel
              </button>
              <button
                onClick={doCommit}
                disabled={!canCommit}
                title={commitBlocked ?? undefined}
                className={cn(
                  "h-9 rounded-lg px-4 text-[13px] font-medium",
                  canCommit
                    ? "bg-[var(--accent)] text-white hover:brightness-110"
                    : "cursor-not-allowed bg-black/[0.06] text-neutral-400 dark:bg-white/10",
                )}
              >
                {amend ? "Amend" : "Commit"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const SegBtn = ({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) => {
  return (
    <button
      onClick={onClick}
      className={cn(
        "h-6 rounded-md px-2.5",
        active
          ? "bg-white font-medium text-neutral-800 shadow-sm dark:bg-neutral-700 dark:text-neutral-100"
          : "text-neutral-500 dark:text-neutral-400",
      )}
    >
      {children}
    </button>
  );
};

const Checkbox = ({ on, mixed = false }: { on: boolean; mixed?: boolean }) => {
  return (
    <span
      className={cn(
        "grid h-[15px] w-[15px] shrink-0 cursor-pointer place-items-center rounded-[4px] border",
        on || mixed
          ? "border-[var(--accent)] bg-[var(--accent)] text-white"
          : "border-neutral-300 bg-white dark:border-neutral-600 dark:bg-neutral-700",
      )}
    >
      {on && !mixed && <CheckIcon className="h-2.5 w-2.5" />}
      {mixed && <span className="h-[2px] w-2 rounded-full bg-white" />}
    </span>
  );
};

const ListView = ({ staged }: { staged: FileChange[] }) => {
  const excluded = useUi((s) => s.commitExcluded);
  const toggle = useUi((s) => s.toggleCommitFile);
  return (
    <div className="flex-1 space-y-0.5 overflow-auto p-3">
      {staged.map((f) => {
        const on = !excluded[f.path];
        return (
          <div
            key={f.path}
            className="flex min-h-10 items-center gap-2.5 rounded-lg px-2.5 py-1.5 hover:bg-black/5 dark:hover:bg-white/5"
          >
            <span onClick={() => toggle(f.path)}>
              <Checkbox on={on} />
            </span>
            <StatusBadge status={f.status} />
            <FileIcon path={f.path} size={16} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] text-neutral-700 dark:text-neutral-200">
                {basename(f.path)}
              </span>
              <span className="block truncate text-[11px] text-neutral-400">{dirname(f.path)}</span>
              {f.advanced && (
                <span className="block truncate text-[10.5px] font-medium text-amber-600 dark:text-amber-400">
                  {f.advanced.message}
                </span>
              )}
            </span>
            <span className="ml-auto shrink-0 font-mono text-xs">
              <span className="text-[color:var(--accent)]">+{f.add}</span>{" "}
              <span className="text-rose-500">−{f.del}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
};

const TreeView = ({ staged, repoPath }: { staged: FileChange[]; repoPath: string | null }) => {
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
              onClick={() => toggleCollapse(row.key)}
              style={{ paddingLeft: 8 + row.depth * 15 }}
              className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md pr-2 text-neutral-500 hover:bg-black/5 dark:text-neutral-400 dark:hover:bg-white/5"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                className={cn("h-3 w-3 text-neutral-400 transition-transform", row.collapsed && "-rotate-90")}
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  setDir(row.paths, row.state !== "on");
                }}
              >
                <Checkbox on={row.state === "on"} mixed={row.state === "mixed"} />
              </span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-4 w-4 shrink-0 text-neutral-400">
                <path d="M3 7v12a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1h-8l-2-2H4a1 1 0 0 0-1 1z" />
              </svg>
              <span className="truncate text-[12.5px] font-medium text-neutral-600 dark:text-neutral-300">
                {row.label}
              </span>
              <span className="ml-auto shrink-0 pl-2 text-[11px] text-neutral-400">
                {row.count} file{row.count === 1 ? "" : "s"}
              </span>
            </div>
          ) : (
            <div
              key={row.key}
              onClick={() => selectFile(row.file.path)}
              style={{ paddingLeft: 8 + row.depth * 15 }}
              className={cn(
                "flex h-7 cursor-pointer items-center gap-1.5 rounded-md pr-2",
                row.file.path === activePath
                  ? "bg-[var(--accent-soft)] text-[color:var(--accent)]"
                  : "text-neutral-700 hover:bg-black/5 dark:text-neutral-200 dark:hover:bg-white/5",
              )}
            >
              <span className="w-3 shrink-0" />
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  toggleFile(row.file.path);
                }}
              >
                <Checkbox on={!excluded[row.file.path]} />
              </span>
              <FileIcon path={row.file.path} size={16} />
              <span className="flex-1 truncate text-[13px]">{basename(row.file.path)}</span>
              <span className="shrink-0 font-mono text-[11px]">
                <span className="text-[color:var(--accent)]">+{row.file.add}</span>{" "}
                <span className="text-rose-500">−{row.file.del}</span>
              </span>
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
