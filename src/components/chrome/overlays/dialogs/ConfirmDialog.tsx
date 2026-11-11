import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import { useUi, type ConfirmRequest } from "@/store/ui";
import {
  AlertCircleIcon,
  BranchIcon,
  FolderIcon,
  StashIcon,
  TrashIcon,
  WarningIcon,
} from "@/components/ui/icons";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { middleEllipsis, parseImpactLines } from "./impactLines";
import {
  DIALOG_LAYER,
  DialogCancelButton,
  DialogFooter,
  DialogPrimaryButton,
  DialogTitle,
  ModalFrame,
} from "./frame";

/** In-app confirmation modal for destructive actions (drop stash, delete
 * branch, hard reset). Replaces native `window.confirm`, which is unreliable in
 * the Tauri webview. The triggering action lives in `confirm.onConfirm`. */
export function ConfirmDialog() {
  const confirm = useUi((s) => s.confirm);
  const closeConfirm = useUi((s) => s.closeConfirm);

  // Escape is the frame's (GL-350). Enter needs no handler either: the
  // autofocused Confirm button activates natively.

  if (!confirm) return null;

  // Close first: an action that raises its own confirm must not have it cleared.
  const accept = () => {
    closeConfirm();
    confirm.onConfirm();
  };

  return (
    <ModalFrame z={DIALOG_LAYER.Top} label={confirm.title} onDismiss={closeConfirm}>
      <div className="flex gap-3">
        <div
          aria-hidden
          className={cn(
            "grid h-9 w-9 flex-none place-items-center rounded-lg",
            confirm.danger
              ? "bg-rose-500/10 text-rose-500"
              : "bg-[var(--accent-soft)] text-[color:var(--accent)]",
          )}
        >
          {(() => {
            const Icon = TONE_ICONS[confirm.icon ?? "alert"];
            return <Icon className="h-[18px] w-[18px]" />;
          })()}
        </div>
        {/* Branch names have no spaces; let them break anywhere instead of overflowing. */}
        {/* Trimmed to cap height on top and the baseline at the bottom, a title
            plus one message line is 36px: exactly the tile's height. */}
        <div className="min-w-0 flex-1 [overflow-wrap:anywhere] [text-box-edge:cap_alphabetic] [text-box-trim:trim-both]">
          <DialogTitle>{confirm.title}</DialogTitle>
          {confirm.message && (
            <div className="mt-[5.5px] text-[12.5px] leading-relaxed text-neutral-500 dark:text-neutral-400">
              {confirm.message}
            </div>
          )}
        </div>
      </div>
      {confirm.facts && confirm.facts.length > 0 && (
        <div className="mt-4 space-y-2.5 rounded-xl border border-black/10 bg-black/[0.025] px-3 py-3 dark:border-white/10 dark:bg-white/[0.035]">
          {/* Facts are a fixed snapshot for this modal; they never reorder. */}
          {confirm.facts.map((fact, i) => (
            <div key={i} className="min-w-0">
              <div className="text-[11.5px] text-neutral-500 dark:text-neutral-400">{fact.label}</div>
              <FactValue {...fact} />
            </div>
          ))}
        </div>
      )}
      {confirm.details && confirm.details.length > 0 && <ImpactPanel lines={confirm.details} />}
      {confirm.warnings && confirm.warnings.length > 0 && (
        <div
          tabIndex={0}
          aria-label="Warnings"
          className="mt-3 flex max-h-40 gap-2.5 overflow-y-auto rounded-lg border border-amber-500/25 bg-amber-500/[0.08] px-3 py-2.5 text-[12px] leading-relaxed text-neutral-700 dark:text-neutral-200"
        >
          <WarningIcon className="mt-0.5 h-4 w-4 flex-none text-amber-600 dark:text-amber-400" />
          <div className="min-w-0 space-y-1">
            {/* Snapshot text has no identity and never reorders while this modal is mounted. */}
            {confirm.warnings.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
        </div>
      )}
      <DialogFooter>
        <DialogCancelButton onClick={closeConfirm} />
        {confirm.secondary && (
          <button
            type="button"
            onClick={() => {
              closeConfirm();
              confirm.secondary!.onClick();
            }}
            className={cn(
              "h-9 rounded-lg border border-black/10 px-4 text-[13px] font-medium text-neutral-700 hover:bg-black/5 dark:border-white/10 dark:text-neutral-200 dark:hover:bg-white/5",
              focusRing,
            )}
          >
            {confirm.secondary.label}
          </button>
        )}
        <DialogPrimaryButton autoFocus onClick={accept} danger={confirm.danger}>
          {confirm.confirmLabel ?? "Confirm"}
        </DialogPrimaryButton>
      </DialogFooter>
    </ModalFrame>
  );
}

const TONE_ICONS: Record<NonNullable<ConfirmRequest["icon"]>, typeof AlertCircleIcon> = {
  alert: AlertCircleIcon,
  trash: TrashIcon,
  stash: StashIcon,
  branch: BranchIcon,
  worktree: FolderIcon,
};

type Fact = NonNullable<ConfirmRequest["facts"]>[number];

function FactValue({ value, kind = "text" }: Fact) {
  if (kind === "ref") {
    return (
      <span
        title={value}
        className="mt-1 inline-flex max-w-full items-center gap-1 rounded-md bg-[var(--accent-soft)] px-1.5 py-0.5 text-[12px] font-medium text-[color:var(--accent)]"
      >
        <BranchIcon className="h-3 w-3 flex-none" />
        <span className="truncate">{middleEllipsis(value)}</span>
      </span>
    );
  }
  return (
    <div
      className={cn(
        "mt-0.5 text-[12px] leading-relaxed text-neutral-700 [overflow-wrap:anywhere] dark:text-neutral-200",
        kind === "path" && "font-mono text-[11.5px]",
      )}
    >
      {value}
    </div>
  );
}

/** The preview's details as one scrollable panel: section headers with a count,
 * file rows as status badge + monospace path, everything else as plain text. */
function ImpactPanel({ lines }: { lines: string[] }) {
  return (
    <div
      // Long file/commit lists must scroll inside the panel instead of pushing
      // the confirm buttons off-screen; the region is focusable so a keyboard
      // user inside the modal's focus trap can still reach the overflow.
      tabIndex={0}
      aria-label="Impact details"
      className="mt-4 max-h-56 overflow-y-auto rounded-xl border border-black/10 bg-black/[0.025] py-1.5 text-[12px] leading-relaxed text-neutral-700 [overflow-wrap:anywhere] dark:border-white/10 dark:bg-white/[0.035] dark:text-neutral-200"
    >
      {/* Snapshot text has no identity and never reorders while this modal is mounted. */}
      {parseImpactLines(lines).map((line, i) => {
        switch (line.kind) {
          case "head":
            return (
              <div
                key={i}
                className="flex items-center gap-1.5 px-3 pb-1 pt-1.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-neutral-500 dark:text-neutral-400"
              >
                {line.text}
                <span className="rounded-full bg-black/[0.06] px-1.5 text-[10px] tabular-nums dark:bg-white/10">
                  {line.count}
                </span>
              </div>
            );
          case "file":
            return (
              <div key={i} className="flex items-center gap-2 px-3 py-[3px]">
                <StatusBadge status={line.status} />
                <span title={line.path} className="min-w-0 truncate font-mono text-[11.5px]">
                  {line.path}
                </span>
              </div>
            );
          case "more":
            return (
              <div key={i} className="px-3 pt-1 text-neutral-400">
                {line.text}
              </div>
            );
          default:
            return (
              <div key={i} className="px-3 py-0.5">
                {line.text}
              </div>
            );
        }
      })}
    </div>
  );
}
