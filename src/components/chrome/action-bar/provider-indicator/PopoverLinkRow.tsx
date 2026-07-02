import { openExternalUrl } from "../../../../lib/openExternal";
import { focusRing } from "../../../../lib/ui";
import { cn } from "../../../../lib/cn";
import { ArrowUpRightIcon } from "../../../ui/icons";
import type { ReactNode } from "react";

/** A single external-link row in the provider popover (GitHub PRs/Issues, repo
 * settings shortcuts). Opens in the system browser via `openExternalUrl`, then closes
 * the popover. Styled as the design's `<a>` rows — leading glyph, label, a
 * trailing open-elsewhere arrow. */
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
      openExternalUrl(href);
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
    <ArrowUpRightIcon className="h-3 w-3 shrink-0 text-neutral-300 dark:text-neutral-600" />
  </button>
);
