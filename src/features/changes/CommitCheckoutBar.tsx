import { useEffect, useRef, useState } from "react";
import { CheckIcon, StashIcon } from "@/components/ui/icons";
import { cn } from "@/lib/cn";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { useInspectorCommit } from "./useInspectorCommit";

/** The selected commit's identity pill + Checkout action, shown at the left of
 * the right-panel header (Details tab). Split out of `CommitInspector` so the
 * commit id and its primary action sit on the header line next to the tabs,
 * while the inspector body owns the message, metadata, and file list. */
export function CommitCheckoutBar() {
  const checkoutDetached = useRepo((state) => state.checkoutDetached);
  const showToast = useUi((state) => state.showToast);
  const { selected, selectedStash, selectedOid, selectedShortLabel } = useInspectorCommit();

  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);
  useEffect(() => () => { if (copyTimer.current) window.clearTimeout(copyTimer.current); }, []);

  if (!selectedOid) return null;

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

  return (
    <div className="flex min-w-0 items-center gap-2">
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
            <span className="truncate">
              {selectedStash && !selected ? selectedShortLabel : `commit ${selectedShortLabel}`}
            </span>
          </>
        )}
      </button>
      {selected ? (
        <button
          type="button"
          className="h-7 shrink-0 rounded-lg border border-black/10 px-3 text-[13px] text-neutral-600 hover:bg-black/5 dark:border-white/10 dark:text-neutral-300 dark:hover:bg-white/5"
          onClick={() => void checkoutDetached(selected.id).catch((e) => showToast(e, "error"))}
        >
          Checkout
        </button>
      ) : null}
    </div>
  );
}
