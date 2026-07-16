import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";

export function CommitAmendOption({
  checked,
  disabled,
  headShortId,
  published,
  disabledReason,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  headShortId: string | null;
  published: boolean;
  disabledReason: string | null;
  onChange: () => void;
}) {
  const commitLabel = headShortId ?? "HEAD";
  const detail = disabled
    ? disabledReason
    : published
      ? `${commitLabel} is already on a remote; force-push with lease after amending`
      : `Reuse ${commitLabel}'s message and add the staged changes`;

  return (
    <div className="min-w-0">
      <label
        title={detail ?? undefined}
        className={cn(
          "inline-flex items-center gap-2 text-[12.5px] font-medium",
          disabled
            ? "cursor-not-allowed text-neutral-400"
            : "cursor-pointer text-neutral-600 dark:text-neutral-300",
        )}
      >
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={onChange}
          className={cn("h-4 w-4 shrink-0 accent-[var(--accent)]", focusRing)}
        />
        <span>Amend previous commit</span>
      </label>
      {published && checked && (
        <div className="truncate pl-6 text-[11.5px] text-amber-600 dark:text-amber-400">
          {detail}
        </div>
      )}
    </div>
  );
}
