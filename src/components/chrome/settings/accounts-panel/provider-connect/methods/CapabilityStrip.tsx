// The four "Fetch, pull / Push / Pull requests / Stored by" tiles at the top of
// each Connect method, so the methods compare at a glance.

import { cn } from "@/lib/cn";
import type { Capability } from "./capabilities";

const TONE = {
  yes: "text-[color:var(--accent)]",
  muted: "text-neutral-500 dark:text-neutral-400",
  plain: "text-neutral-900 dark:text-white",
} as const;

export function CapabilityStrip({ capabilities }: { capabilities: Capability[] }) {
  return (
    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {capabilities.map((cap) => (
        <div key={cap.label} className="rounded-lg bg-black/[0.035] px-3 py-2.5 dark:bg-white/[0.05]">
          <dt className="text-[11px] text-neutral-500 dark:text-neutral-400">{cap.label}</dt>
          <dd className={cn("text-[12.5px] font-semibold leading-snug", TONE[cap.tone])}>{cap.value}</dd>
        </div>
      ))}
    </dl>
  );
}
