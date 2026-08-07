// "New pull request" — raised from the PR list header and from the commit
// modal's commit-push-open-PR path. Collects the target (a base branch, or the
// open pull request this branch was cut from), title, description, commits, and
// reviewers, then opens it through the pulls store.

import { InlineSpinner } from "@/components/ui/Loading";
import { ModalFrame } from "@/components/chrome/overlays/dialogs/frame";
import { useUi } from "@/store/ui";
import { CommitsPanel } from "./CommitsPanel";
import { DescriptionEditor } from "./DescriptionEditor";
import { ReviewersRow } from "./ReviewersRow";
import { StackMap } from "./StackMap";
import { TargetBar } from "./TargetBar";
import { useCreatePrForm } from "./useCreatePrForm";

export function CreatePrDialog() {
  const open = useUi((s) => s.createPrOpen);
  if (!open) return null;
  return <CreatePrDialogBody />;
}

function CreatePrDialogBody() {
  const form = useCreatePrForm();
  const { range } = form;

  return (
    <ModalFrame
      z="z-[60]"
      label="New pull request"
      bare
      panelClassName="flex max-h-[88vh] w-[720px] max-w-[94vw] flex-col overflow-hidden"
      onDismiss={form.closeCurrent}
    >
      <div className="flex items-start gap-3 border-b border-black/5 px-5 pb-3.5 pt-4 dark:border-white/5">
        <div className="min-w-0">
          <div className="text-[16px] font-semibold text-neutral-800 dark:text-neutral-100">
            New pull request
          </div>
          <div className="mt-0.5 text-[12.5px] text-neutral-500 dark:text-neutral-400">
            from <span className="font-mono">{form.head || "?"}</span>
          </div>
        </div>
        {form.account && (
          <div
            className="ml-auto shrink-0 text-right"
            title={`Opened as ${form.account.login} on ${form.account.host}. Change it in Remotes.`}
          >
            <div className="text-[10.5px] font-bold uppercase tracking-[0.06em] text-neutral-400">
              Opening as
            </div>
            <div className="font-mono text-[12.5px] text-neutral-700 dark:text-neutral-200">
              {form.account.login}
            </div>
          </div>
        )}
      </div>

      <div
        className="min-h-0 flex-1 space-y-2.5 overflow-auto px-5 py-3.5"
        onKeyDown={(e) => {
          if (e.key === "Escape") form.closeCurrent();
        }}
      >
        <TargetBar
          head={form.head}
          base={form.base}
          branches={form.branches}
          onBase={form.setBase}
          onStacked={form.setStacked}
          canStack={form.canStack}
          stacked={form.stacked}
          parent={form.parent}
        />

        <StackMap
          title={form.stacked ? "Stack" : "Base"}
          meta={form.mapMeta}
          rows={form.mapRows}
          compare={range.compare}
        />

        <input
          autoFocus
          value={form.title}
          onChange={(e) => form.setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") form.closeCurrent();
          }}
          placeholder="Title"
          aria-label="Title"
          className="h-10 w-full rounded-lg border border-black/10 bg-transparent px-3 text-[14px] font-semibold text-neutral-800 outline-none transition-colors placeholder:text-neutral-400 focus:border-[color:var(--accent)] dark:border-white/10 dark:text-neutral-100"
        />

        <DescriptionEditor
          body={form.body}
          onBody={form.setBody}
          tab={form.tab}
          onTab={form.setTab}
          templates={form.templates}
          onTemplate={(template) => void form.applyTemplate(template)}
          onFromCommits={form.fillFromCommits}
          canFillFromCommits={range.commits.length > 0}
          canRestore={form.replacedBody !== null}
          onRestore={form.restoreDraft}
        />

        <CommitsPanel
          commits={range.commits}
          loading={range.loading}
          note={form.stacked ? "this layer only" : ""}
        />

        <ReviewersRow
          candidates={form.candidates}
          selected={form.reviewers}
          onSelected={form.setReviewers}
        />
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-black/5 px-5 py-3.5 dark:border-white/5">
        <label className="flex cursor-pointer select-none items-center gap-2 text-[13px] text-neutral-600 dark:text-neutral-300">
          <input
            type="checkbox"
            checked={form.draft}
            onChange={(e) => form.setDraft(e.target.checked)}
            className="accent-[var(--accent)]"
          />
          Create as draft
        </label>
        {form.mergeNote && (
          <span className="ml-3 text-[12px] text-neutral-500 dark:text-neutral-400">
            {form.mergeNote}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={form.closeCurrent}
            className="h-9 rounded-lg px-4 text-[13px] text-neutral-600 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/5"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void form.submit()}
            disabled={!form.canSubmit || form.pending}
            aria-busy={form.creating}
            className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-[var(--accent)] px-4 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-45"
          >
            {form.creating && <InlineSpinner className="h-3.5 w-3.5" />}
            {form.creating ? "Creating…" : form.draft ? "Create draft" : "Create pull request"}
          </button>
        </div>
      </div>
    </ModalFrame>
  );
}
