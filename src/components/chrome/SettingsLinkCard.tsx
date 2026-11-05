// The link across to the other settings window (App settings ↔ Repository
// settings): one card, used in both windows' sidebars so they match.

import type { ComponentType } from "react";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import { ArrowUpRightIcon } from "@/components/ui/icons";

export const SettingsLinkCard = ({
  icon: Icon,
  title,
  subtitle,
  onClick,
  className,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  subtitle: string;
  onClick: () => void;
  className?: string;
}) => (
  <button type="button"
    onClick={onClick}
    className={cn(
      "group flex w-full items-center gap-2 rounded-xl border border-black/[0.08] bg-white/60 px-2.5 py-2 text-left hover:border-black/15 hover:bg-white dark:border-white/[0.09] dark:bg-white/[0.03] dark:hover:border-white/15 dark:hover:bg-white/[0.06]",
      focusRing,
      className,
    )}
  >
    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-black/[0.05] text-neutral-500 dark:bg-white/[0.07] dark:text-neutral-400">
      <Icon className="h-[15px] w-[15px]" />
    </span>
    <span className="min-w-0 flex-1">
      <span className="block truncate whitespace-nowrap text-[12.5px] font-semibold text-neutral-700 dark:text-neutral-200">
        {title}
      </span>
      <span className="block truncate font-mono text-[11.5px] text-neutral-400 dark:text-neutral-500">{subtitle}</span>
    </span>
    <ArrowUpRightIcon className="h-3.5 w-3.5 shrink-0 text-neutral-300 group-hover:text-neutral-500 dark:text-neutral-600 dark:group-hover:text-neutral-400" />
  </button>
);
