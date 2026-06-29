// The add-account provider picker. Replaces the old "permanent card per
// provider" list — providers only appear here, when the user is actively adding
// one, with an honest capability hint (GitHub = full support, others = auth-only
// no PRs). Picking one opens its connect path.

import { cn } from "../../../../lib/cn";
import { focusRing } from "../../../../lib/ui";
import { capabilityHint, PROVIDERS, providerInitials, type ProviderKey } from "./providers";

export function AddAccountPicker({
  onPick,
  onClose,
}: {
  onPick: (key: ProviderKey) => void;
  onClose: () => void;
}) {
  return (
    <div className="rounded-xl border border-black/[0.08] bg-black/[0.015] p-3 dark:border-white/[0.1] dark:bg-white/[0.02]">
      <div className="mb-1 flex items-center justify-between px-1">
        <div className="text-[13px] font-semibold text-neutral-800 dark:text-neutral-100">Add an account</div>
        <button
          onClick={onClose}
          aria-label="Close"
          className={cn(
            "grid h-7 w-7 place-items-center rounded-lg text-neutral-400 transition hover:bg-black/5 dark:hover:bg-white/10",
            focusRing,
          )}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div className="flex flex-col gap-1.5">
        {PROVIDERS.map((p) => (
          <button
            key={p.key}
            onClick={() => onPick(p.key)}
            className={cn(
              "group flex items-center gap-3 rounded-lg border border-transparent p-2 text-left transition hover:border-black/10 hover:bg-black/[0.03] dark:hover:border-white/10 dark:hover:bg-white/[0.04]",
              focusRing,
            )}
          >
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[9px] bg-black/[0.06] text-[11px] font-bold text-neutral-500 dark:bg-white/[0.08] dark:text-neutral-300">
              {providerInitials(p.name)}
            </span>
            <span className="flex-1 text-[13px] font-semibold text-neutral-800 dark:text-neutral-100">{p.name}</span>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[10.5px] font-semibold",
                p.prSupported
                  ? "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400"
                  : "bg-black/[0.05] text-neutral-500 dark:bg-white/[0.07] dark:text-neutral-400",
              )}
            >
              {capabilityHint(p)}
            </span>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-4 w-4 text-neutral-300 transition group-hover:text-neutral-400 dark:text-neutral-600"
            >
              <path d="m9 6 6 6-6 6" />
            </svg>
          </button>
        ))}
      </div>
    </div>
  );
}
