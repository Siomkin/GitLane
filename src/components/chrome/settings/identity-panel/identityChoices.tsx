// Shared commit-identity choice UI — the radio-style profile rows and their
// badges. Used by the settings CommitAsZone picker and the commit composer's
// identity selector (GL-213), so both render identical choices.

import { type ReactNode } from "react";

import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import { selectCommitSource } from "@/lib/identities";
import { profileInitials } from "@/lib/profiles";

/** The hint-line badges: which card the current name/email match, plus how they
 * diverge from its saved values. Purely informational. */
export function HintBadges({ selection }: { selection: ReturnType<typeof selectCommitSource> }) {
  if (selection.kind === "manual") {
    return (
      <>
        {selection.customName && (
          <Badge title="The author name differs from this profile's saved name — names are free-form; attribution follows the email.">
            custom name
          </Badge>
        )}
        {selection.customSigning && <Badge tone="amber">custom signing</Badge>}
      </>
    );
  }
  return null;
}

/** One selectable git-identity row (radio dot + avatar/swatch + name/email +
 * badges), used in both the settings picker and the commit-dialog popover. */
export function ProfileChoiceRow({
  title,
  subtitle,
  active,
  icon,
  swatch,
  badges,
  onClick,
}: {
  title: string;
  subtitle: string;
  active: boolean;
  icon?: ReactNode;
  swatch?: string;
  badges?: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={title}
      className={cn(
        "flex w-full items-center gap-3 rounded-[10px] border p-3 text-left transition",
        active
          ? "border-[color:var(--accent)]/45 bg-[var(--accent-soft)]"
          : "border-black/[0.06] bg-black/[0.02] hover:bg-black/[0.04] dark:border-white/[0.08] dark:bg-white/[0.03] dark:hover:bg-white/[0.06]",
        focusRing,
      )}
    >
      <span
        className={cn(
          "grid h-4 w-4 shrink-0 place-items-center rounded-full border",
          active ? "border-[color:var(--accent)]" : "border-neutral-400/70 dark:border-neutral-500/80",
        )}
        aria-hidden
      >
        {active && <span className="h-2 w-2 rounded-full bg-[color:var(--accent)]" />}
      </span>
      {swatch ? (
        <span
          className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] text-[11px] font-bold text-white"
          style={{ background: swatch }}
          aria-hidden
        >
          {profileInitials(title)}
        </span>
      ) : (
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-black/[0.06] text-neutral-500 dark:bg-white/[0.08] dark:text-neutral-300">
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-[13.5px] font-semibold text-neutral-900 dark:text-white">{title}</span>
          {badges}
        </span>
        <span className="mt-0.5 block truncate font-mono text-[12px] text-neutral-500 dark:text-neutral-400">
          {subtitle}
        </span>
      </span>
    </button>
  );
}

/** A small pill used across the identity choices (source, signing, hints). */
export function Badge({
  children,
  tone = "neutral",
  title,
}: {
  children: ReactNode;
  tone?: "neutral" | "accent" | "amber";
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-[17px] items-center gap-1 rounded-full px-1.5 text-[10px] font-semibold",
        tone === "accent"
          ? "bg-[var(--accent-soft)] text-[color:var(--accent)]"
          : tone === "amber"
            ? "bg-amber-500/12 text-amber-600 dark:text-amber-400"
            : "bg-black/[0.05] text-neutral-500 dark:bg-white/[0.07] dark:text-neutral-400",
      )}
    >
      {children}
    </span>
  );
}
