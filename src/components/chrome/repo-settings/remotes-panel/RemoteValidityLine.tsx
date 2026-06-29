import { cn } from "../../../../lib/cn";
import { CheckIcon, WarningIcon } from "../../../ui/icons";
import type { RemoteValidity, RemoteValidityLevel } from "./remotes";

const TONE: Record<RemoteValidityLevel, string> = {
  neutral: "text-neutral-400 dark:text-neutral-500",
  ok: "text-emerald-600 dark:text-emerald-400",
  warn: "text-amber-600 dark:text-amber-400",
  bad: "text-rose-600 dark:text-rose-400",
};

/** The validation status line under a remote-URL field: a tone-coloured icon
 * (check / warning / error) plus the message. Shared by add and edit. */
export const RemoteValidityLine = ({ validity }: { validity: RemoteValidity }) => (
  <span
    className={cn(
      "inline-flex items-center gap-1.5 text-[12.5px]",
      TONE[validity.level],
      validity.level === "neutral" ? "font-normal" : "font-medium",
    )}
  >
    {validity.level === "ok" && <CheckIcon className="h-3.5 w-3.5 shrink-0" strokeWidth={2.2} />}
    {validity.level === "warn" && <WarningIcon className="h-3.5 w-3.5 shrink-0" />}
    {validity.level === "bad" && (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-3.5 w-3.5 shrink-0"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M15 9l-6 6M9 9l6 6" />
      </svg>
    )}
    {validity.message}
  </span>
);
