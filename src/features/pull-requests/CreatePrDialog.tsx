// "New pull request" modal raised from the PR list header. Collects base/head/
// title/body/draft and opens the PR via `gh pr create` (pulls store). Head
// defaults to the checked-out branch; base to the repo's likely default branch.

import { useEffect, useMemo, useState } from "react";
import type { BranchInfo } from "../../lib/api";
import { useRepo } from "../../store/repo";
import { usePulls } from "../../store/pulls";
import { useUi } from "../../store/ui";
import { useRunPrAction } from "./usePrAction";

/** Best guess at the base branch: the conventional default if present, else the
 * first local branch that isn't the current one. */
function guessBase(branches: BranchInfo[], head: string | null): string {
  const locals = branches.filter((b) => b.kind === "local").map((b) => b.name);
  for (const name of ["main", "develop", "master"]) {
    if (locals.includes(name) && name !== head) return name;
  }
  return locals.find((n) => n !== head) ?? "main";
}

export function CreatePrDialog() {
  const open = useUi((s) => s.createPrOpen);
  const close = useUi((s) => s.closeCreatePr);
  const summary = useRepo((s) => s.summary);
  const branches = useRepo((s) => s.branches);
  const createPr = usePulls((s) => s.createPr);
  const pending = usePulls((s) => s.prPendingActions.length > 0);
  const run = useRunPrAction();

  const head = summary?.headBranch ?? "";
  const defaultBase = useMemo(() => guessBase(branches, head), [branches, head]);

  const [base, setBase] = useState(defaultBase);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(false);

  // Reset the form each time the dialog opens.
  useEffect(() => {
    if (open) {
      setBase(defaultBase);
      setTitle("");
      setBody("");
      setDraft(false);
    }
  }, [open, defaultBase]);

  if (!open) return null;

  const locals = branches.filter((b) => b.kind === "local").map((b) => b.name);
  const canSubmit = !!title.trim() && !!base && !!head && base !== head;

  const submit = async () => {
    if (!canSubmit) return;
    const ok = await run(
      () => createPr(base, head, title.trim(), body, draft),
      `Opened PR from ${head} → ${base}`,
    );
    if (ok) {
      // gh prints the new PR URL; offer to open it, then close.
      close();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] grid place-items-center bg-black/30 backdrop-blur-sm"
      onClick={close}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[520px] max-w-[92vw] rounded-2xl border border-black/10 bg-white p-[22px] shadow-[0_40px_80px_-12px_rgba(0,0,0,0.5)] dark:border-white/10 dark:bg-neutral-800"
        style={{ animation: "gp-pop .14s ease-out" }}
      >
        <div className="text-[15px] font-semibold text-neutral-800 dark:text-neutral-100">
          New pull request
        </div>
        <div className="mt-1 flex items-center gap-1.5 text-[12.5px] text-neutral-400">
          <span className="font-mono font-semibold text-[color:var(--accent)]">{head || "?"}</span>
          <span>→</span>
          <select
            value={base}
            onChange={(e) => setBase(e.target.value)}
            className="rounded-md border border-black/10 bg-transparent px-1.5 py-0.5 font-mono text-[12px] text-neutral-700 outline-none focus:border-[color:var(--accent)] dark:border-white/10 dark:text-neutral-200"
          >
            {!locals.includes(base) && <option value={base}>{base}</option>}
            {locals.map((b) => (
              <option key={b} value={b} className="dark:bg-neutral-800">
                {b}
              </option>
            ))}
          </select>
        </div>

        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
          }}
          placeholder="Title"
          className="mt-4 w-full rounded-lg border border-black/10 bg-transparent px-3 py-2.5 text-[13.5px] text-neutral-800 outline-none focus:border-[color:var(--accent)] dark:border-white/10 dark:text-neutral-100"
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Describe your changes… (Markdown supported)"
          rows={6}
          className="mt-2.5 w-full resize-y rounded-lg border border-black/10 bg-transparent px-3 py-2.5 text-[13px] text-neutral-800 outline-none focus:border-[color:var(--accent)] dark:border-white/10 dark:text-neutral-100"
        />

        <div className="mt-[18px] flex items-center justify-between">
          <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-neutral-600 dark:text-neutral-300">
            <input
              type="checkbox"
              checked={draft}
              onChange={(e) => setDraft(e.target.checked)}
              className="accent-[var(--accent)]"
            />
            Create as draft
          </label>
          <div className="flex gap-2">
            <button
              onClick={close}
              className="h-9 rounded-lg px-4 text-[13px] text-neutral-600 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/5"
            >
              Cancel
            </button>
            <button
              onClick={() => void submit()}
              disabled={!canSubmit || pending}
              className="h-9 rounded-lg bg-[var(--accent)] px-4 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-45"
            >
              {draft ? "Create draft" : "Create pull request"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
