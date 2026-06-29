import { cn } from "../../../../lib/cn";

/** A monospace remote-URL input. Turns its border rose when `invalid`, otherwise
 * focuses to the accent. Shared by the add form and per-row edit. */
export const RemoteUrlField = ({
  value,
  onChange,
  invalid,
  placeholder = "https://host/owner/repo.git",
  autoFocus,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  invalid: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  ariaLabel?: string;
}) => (
  <input
    type="text"
    value={value}
    spellCheck={false}
    autoFocus={autoFocus}
    aria-label={ariaLabel}
    placeholder={placeholder}
    onChange={(e) => onChange(e.target.value)}
    className={cn(
      "h-10 w-full rounded-lg border bg-black/[0.02] px-3 font-mono text-[13px] text-neutral-900 outline-none focus:ring-2 focus:ring-[var(--accent-soft)] dark:bg-white/[0.04] dark:text-white",
      invalid
        ? "border-rose-400/70 focus:border-rose-500"
        : "border-black/10 focus:border-[color:var(--accent)] dark:border-white/10",
    )}
  />
);
