import { openUrl } from "@tauri-apps/plugin-opener";
import { focusRing } from "../../../../lib/ui";
import { cn } from "../../../../lib/cn";
import type { ReactNode } from "react";

/** A single external-link row in the provider popover (GitHub PRs/Issues, repo
 * settings shortcuts). Opens in the system browser via `openUrl`, then closes
 * the popover. Styled as the design's `<a>` rows — leading glyph, label, a
 * trailing `↗`. */
export const PopoverLinkRow = ({
  icon,
  label,
  href,
  onClose,
}: {
  icon: ReactNode;
  label: string;
  href: string;
  onClose: () => void;
}) => (
  <button
    type="button"
    onClick={() => {
      void openUrl(href);
      onClose();
    }}
    title={href}
    className={cn(
      "flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px]",
      "text-neutral-600 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/5",
      focusRing,
    )}
  >
    <span className="shrink-0 text-neutral-400">{icon}</span>
    <span className="flex-1 truncate">{label}</span>
    <span className="text-[12px] text-neutral-300 dark:text-neutral-600">↗</span>
  </button>
);
