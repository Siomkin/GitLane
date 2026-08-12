// One adapter's live status, in a chip: unknown until checked, then the
// adapter's own name + version, or the reason it could not answer.
//
// A successful probe proves three things at once — the adapter is installed,
// it launches, and the CLI behind it is signed in — which is why there is one
// indicator rather than three.

import { cn } from "@/lib/cn";
import type { AcpStatus } from "@/store/acpAgents";

export function AcpStatusPill({
  status,
  /** PATH readiness, known without launching anything. Used only while the
   *  adapter has not been launched: "Ready" means the CLI is there, which is a
   *  weaker claim than a successful probe but a free one. */
  onPath,
  /** Dot-only for dense rows — the label moves into the hover title so the
   *  agent name / command aren't repeated beside them. */
  compact = false,
}: {
  status: AcpStatus;
  onPath?: boolean;
  compact?: boolean;
}) {
  const { label, title, tone, dot } = statusPresentation(status, onPath);

  if (compact) {
    return (
      <span
        role="img"
        aria-label={label}
        title={title}
        className="grid h-7 w-5 shrink-0 place-items-center"
      >
        <span className={cn("h-2 w-2 rounded-full", dot)} />
      </span>
    );
  }

  return (
    <span
      title={title !== label ? title : undefined}
      className={cn(
        "inline-flex h-7 max-w-[240px] shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium",
        tone,
      )}
    >
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dot)} />
      <span className="truncate">{label}</span>
    </span>
  );
}

function statusPresentation(
  status: AcpStatus,
  onPath: boolean | undefined,
): { label: string; title: string; tone: string; dot: string } {
  if (status.state === "unknown" && onPath !== undefined) {
    return onPath
      ? {
          label: "Ready",
          title: "The CLI is on PATH. Check to confirm it launches and is signed in.",
          tone: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
          dot: "bg-emerald-500",
        }
      : {
          label: "Needs CLI",
          title: "The CLI was not found on PATH.",
          tone: "bg-black/[0.04] text-neutral-500 dark:bg-white/[0.06] dark:text-neutral-400",
          dot: "bg-neutral-300 dark:bg-neutral-600",
        };
  }

  if (status.state === "ok") {
    const label =
      [status.probe.agentName, status.probe.agentVersion].filter(Boolean).join(" ") ||
      "connected";
    return {
      label,
      title: label,
      tone: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
      dot: "bg-emerald-500",
    };
  }

  if (status.state === "failed") {
    return {
      label: "unavailable",
      title: status.error || "unavailable",
      tone: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
      dot: "bg-rose-500",
    };
  }

  if (status.state === "checking") {
    return {
      label: "Connecting…",
      title: "Connecting…",
      tone: "bg-[var(--accent-soft)] text-[color:var(--accent)]",
      dot: "animate-pulse bg-[color:var(--accent)]",
    };
  }

  return {
    label: "not checked",
    title: "Not checked yet",
    tone: "bg-black/[0.04] text-neutral-500 dark:bg-white/[0.06] dark:text-neutral-400",
    dot: "bg-neutral-300 dark:bg-neutral-600",
  };
}
