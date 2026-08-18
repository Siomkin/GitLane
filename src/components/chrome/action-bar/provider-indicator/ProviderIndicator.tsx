import { useRef, useState } from "react";
import type { ComponentType } from "react";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import { ForgeKind } from "@/lib/api";
import type { RepoForge } from "@/lib/api";
import { isPrForge } from "../actionBarModel";
import { pullRequestLabel } from "@/lib/forgeHelp";
import type { RepoSettingsSection } from "@/store/ui";
import { useDismiss } from "@/hooks/useDismiss";
import {
  AzureDevOpsIcon,
  BitbucketIcon,
  CloudIcon,
  CloudOffIcon,
  CursorOriginIcon,
  ForgejoIcon,
  GiteaIcon,
  GitHubIcon,
  GitLabIcon,
  WarningIcon,
} from "@/components/ui/icons";
import { ProviderPopover } from "./ProviderPopover";
import { providerPopoverModel } from "./model";
import type { ProviderState } from "./state";

/** Per-forge brand glyph for the toolbar button; forges without a mark fall back
 * to a generic cloud. */
const FORGE_ICON: Partial<Record<ForgeKind, ComponentType<{ className?: string }>>> = {
  [ForgeKind.GitHub]: GitHubIcon,
  [ForgeKind.GitLab]: GitLabIcon,
  [ForgeKind.Bitbucket]: BitbucketIcon,
  [ForgeKind.AzureDevOps]: AzureDevOpsIcon,
  [ForgeKind.Gitea]: GiteaIcon,
  [ForgeKind.Forgejo]: ForgejoIcon,
  [ForgeKind.CursorOrigin]: CursorOriginIcon,
};

/** Status-dot colour per state (the design's `pm.dot`). `connected` has none — a
 * healthy remote needs no badge. */
const PROVIDER_DOT: Record<ProviderState, string | null> = {
  connected: null,
  "transport-auth": "#2f81f7",
  "needs-auth": "#d4a72c",
  unsupported: "#9a9a9a",
  missing: "#9a9a9a",
  error: "#cf222e",
};

/** The button glyph follows the forge (its brand mark, else a generic cloud);
 * missing/error override with their own status glyphs. */
const buttonIcon = (state: ProviderState, forge: RepoForge): ComponentType<{ className?: string }> => {
  if (state === "missing") return CloudOffIcon;
  if (state === "error") return WarningIcon;
  return (forge.kind && FORGE_ICON[forge.kind]) || CloudIcon;
};

/** Concise tooltip / accessible name summarising the remote's status. */
const buttonTitle = (state: ProviderState, forge: RepoForge): string => {
  const slug = forge.webUrl ? forge.webUrl.replace(/^https?:\/\//, "") : forge.host ?? "remote";
  switch (state) {
    case "missing":
      return "No remote configured";
    case "error":
      return "GitHub CLI unavailable — pull requests unavailable";
    case "connected":
      if (!isPrForge(forge.kind)) return `${slug} · pull requests unavailable`;
      return `${slug} · ${pullRequestLabel(forge.kind).toLowerCase()} enabled`;
    case "transport-auth":
      return `${slug} · git auth configured, ${pullRequestLabel(forge.kind).toLowerCase()} unavailable`;
    case "needs-auth":
      if (forge.kind === ForgeKind.Bitbucket) return `${slug} · set up auth for pull requests`;
      return `${slug} · sign in to view ${pullRequestLabel(forge.kind).toLowerCase()}`;
    case "unsupported":
      return `${slug} · pull requests unavailable`;
  }
};

/** Remote-provider indicator: an 8×8 toolbar button (forge glyph + status dot)
 * that opens the provider popover, with a hover-revealed "Repo settings" text
 * link to its left (the design's `group/repo`). The popover content is derived
 * per status by {@link providerPopoverModel}. */
export const ProviderIndicator = ({
  state,
  forge,
  prCount,
  errorDetail,
  className,
  onViewPrs,
  onSignIn,
  onOpenRepoSettings,
  onOpen,
}: {
  state: ProviderState;
  forge: RepoForge;
  prCount: number;
  /** Accounts-store error string, shown in the popover for the `error` state. */
  errorDetail?: string | null;
  className?: string;
  onViewPrs: () => void;
  /** Open the global Accounts settings (bind a GitHub account). */
  onSignIn: () => void;
  /** Open the repo-scoped Repository settings window at a section. */
  onOpenRepoSettings: (section: RepoSettingsSection) => void;
  /** Fired when the popover opens — lets the toolbar dismiss sibling surfaces
   * (e.g. the branch navigator) so only one popover is open at a time. */
  onOpen?: () => void;
}) => {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);
  const toggle = () => {
    if (!open) onOpen?.();
    setOpen((v) => !v);
  };
  useDismiss(open, close, wrapRef);

  const Icon = buttonIcon(state, forge);
  const title = buttonTitle(state, forge);
  const dot = PROVIDER_DOT[state];

  return (
    <div ref={wrapRef} className={cn("group/repo relative", className)}>
      {/* Repository-settings shortcut — a pointer-only affordance revealed on
          hover (the design's slide-in link). It's aria-hidden and out of the tab
          order: keyboard and screen-reader users reach the same action via the
          popover's "Repository settings…" item, so there's no invisible
          focusable control to land on. */}
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        onClick={() => onOpenRepoSettings("identity")}
        title="Repository settings — identity & remotes for this repo"
        className={cn(
          "pointer-events-none absolute right-full top-1/2 h-8 -translate-y-1/2 whitespace-nowrap rounded-lg px-2.5 text-[13px] font-medium text-neutral-600 opacity-0 transition-opacity duration-150 ease-out",
          "hover:bg-black/5 hover:text-neutral-800 dark:text-neutral-300 dark:hover:bg-white/5 dark:hover:text-neutral-100",
          "group-hover/repo:pointer-events-auto group-hover/repo:opacity-100",
        )}
      >
        Repo settings
      </button>

      <button
        type="button"
        onClick={toggle}
        title={title}
        aria-label={`Remote provider: ${title}`}
        aria-haspopup="true"
        aria-expanded={open}
        className={cn(
          "relative grid h-8 w-8 place-items-center rounded-lg transition-colors",
          "hover:bg-black/5 dark:hover:bg-white/5",
          open
            ? "bg-[var(--accent-soft)] text-[color:var(--accent)]"
            : "text-neutral-700 dark:text-neutral-200",
          focusRing,
        )}
      >
        <Icon className="h-[18px] w-[18px]" />
        {dot && (
          <span
            className="absolute right-1 top-1 h-2 w-2 rounded-full ring-2 ring-white dark:ring-neutral-800"
            style={{ background: dot }}
          />
        )}
      </button>

      {open && (
        <ProviderPopover
          model={providerPopoverModel(state, forge, prCount, errorDetail)}
          onViewPrs={onViewPrs}
          onSignIn={onSignIn}
          onOpenRepoSettings={onOpenRepoSettings}
          onClose={close}
        />
      )}
    </div>
  );
};
