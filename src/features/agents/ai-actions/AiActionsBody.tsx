import { Markdown } from "@/components/ui/Markdown";
import { FileTextIcon } from "@/components/ui/icons";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import type { AiActionDef } from "./aiActions";
import { AiActionView, type AiActionView as View } from "./aiActionsView";

export function AiActionsBody({
  hasOutput,
  editing,
  view,
  out,
  def,
  hint,
  error,
  canRun,
  onRun,
  onChangeOut,
}: {
  hasOutput: boolean;
  editing: boolean;
  view: View;
  out: string;
  def: AiActionDef;
  hint: string;
  error: string | null;
  canRun: boolean;
  onRun: () => void;
  onChangeOut: (value: string) => void;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {!hasOutput && (
        <div className="grid h-full place-items-center px-10">
          <div className="max-w-[520px] text-center">
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-black/[0.04] text-neutral-400 dark:bg-white/[0.05] dark:text-neutral-500">
              <FileTextIcon className="h-6 w-6" />
            </div>
            <div className="mt-4 text-[17px] font-semibold text-neutral-800 dark:text-neutral-100">
              {def.label} — not generated yet
            </div>
            <p className="mt-2 text-[13.5px] leading-relaxed text-pretty text-neutral-500 dark:text-neutral-400">
              {hint}
            </p>
            {error && (
              <p role="alert" className="mt-3 text-[13px] text-rose-500">
                {error}
              </p>
            )}
            <button
              type="button"
              onClick={onRun}
              disabled={!canRun}
              className={cn(
                "mt-5 h-10 rounded-lg bg-[var(--accent)] px-5 text-[13.5px] font-semibold text-white transition hover:brightness-110 active:scale-[0.97] disabled:opacity-45",
                focusRing,
              )}
            >
              Run {def.label.toLowerCase()}
            </button>
            <div className="mt-3 text-[12px] text-neutral-500 dark:text-neutral-400">
              Nothing leaves your machine beyond the agent you picked.
            </div>
          </div>
        </div>
      )}

      {hasOutput && editing && (
        <div className="px-10 py-8">
          <textarea
            value={out}
            onChange={(e) => onChangeOut(e.target.value)}
            spellCheck={false}
            className="h-[420px] w-full resize-none rounded-xl border border-[color:var(--accent)] bg-black/[0.02] p-4 font-mono text-[14px] leading-[1.7] text-neutral-800 outline-none dark:bg-white/[0.04] dark:text-neutral-100"
          />
        </div>
      )}

      {hasOutput && !editing && view === AiActionView.Raw && (
        <pre className="w-full px-10 py-8 font-mono text-[13.5px] leading-[1.75] whitespace-pre-wrap text-neutral-600 dark:text-neutral-300">
          {out}
        </pre>
      )}

      {hasOutput && !editing && view === AiActionView.Formatted && (
        <div className="w-full px-10 py-8 text-[15px] leading-[1.8] text-neutral-800 dark:text-neutral-100">
          {out ? <Markdown content={out} /> : null}
        </div>
      )}
    </div>
  );
}
