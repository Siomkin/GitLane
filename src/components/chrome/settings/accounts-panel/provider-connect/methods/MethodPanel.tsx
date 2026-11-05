// The frame every Connect method shares, for every provider: its name and
// badge, what it is, what it covers (the capability strip), then the method's
// own steps.

import type { Capability } from "./capabilities";
import { CapabilityStrip } from "./CapabilityStrip";

export const sectionLabelCls =
  "text-[11px] font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500";
export const mutedTextCls = "text-[12px] leading-relaxed text-neutral-500 dark:text-neutral-400";
export const strongTextCls = "font-semibold text-neutral-900 dark:text-white";

export function MethodPanel({
  capabilities,
  title,
  badge,
  intro,
  children,
}: {
  capabilities: Capability[];
  title: string;
  badge?: { label: string; accent: boolean };
  intro: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <h3 className="text-[14px] font-semibold text-neutral-900 dark:text-white">{title}</h3>
          {badge && (
            <span
              className={
                badge.accent
                  ? "inline-flex h-[18px] items-center rounded-full bg-[color:var(--accent)]/12 px-2 text-[10px] font-semibold text-[color:var(--accent)]"
                  : "inline-flex h-[18px] items-center rounded-full bg-black/[0.06] px-2 text-[10px] font-semibold text-neutral-500 dark:bg-white/[0.08] dark:text-neutral-400"
              }
            >
              {badge.label}
            </span>
          )}
        </div>
        <p className="text-[12.5px] leading-relaxed text-neutral-600 dark:text-neutral-300">{intro}</p>
      </div>
      <CapabilityStrip capabilities={capabilities} />
      {children}
    </section>
  );
}
