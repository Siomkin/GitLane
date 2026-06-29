import type { ComponentType } from "react";
import { openExternalUrl } from "../../../../lib/openExternal";
import { cn } from "../../../../lib/cn";
import { focusRing } from "../../../../lib/ui";
import type { RepoSettingsSection } from "../../../../store/ui";
import {
  AzureDevOpsIcon,
  BitbucketIcon,
  BranchIcon,
  CloudIcon,
  CloudOffIcon,
  ExternalLinkIcon,
  ForgejoIcon,
  GiteaIcon,
  GitHubIcon,
  GitLabIcon,
  IssueIcon,
  KeyIcon,
  PeopleIcon,
  PlusIcon,
  PullRequestIcon,
  RemotesIcon,
  SettingsIcon,
  WarningIcon,
  WebhookIcon,
} from "../../../ui/icons";
import { PopoverLinkRow } from "./PopoverLinkRow";
import type { PopoverIconKey, ProviderPopoverModel } from "./model";

const ICONS: Record<PopoverIconKey, ComponentType<{ className?: string }>> = {
  github: GitHubIcon,
  gitlab: GitLabIcon,
  bitbucket: BitbucketIcon,
  gitea: GiteaIcon,
  forgejo: ForgejoIcon,
  azure: AzureDevOpsIcon,
  cloud: CloudIcon,
  cloudOff: CloudOffIcon,
  warning: WarningIcon,
  pr: PullRequestIcon,
  issue: IssueIcon,
  gear: SettingsIcon,
  branch: BranchIcon,
  people: PeopleIcon,
  webhook: WebhookIcon,
  key: KeyIcon,
  external: ExternalLinkIcon,
  plus: PlusIcon,
  remotes: RemotesIcon,
};

const Glyph = ({ icon, className }: { icon: PopoverIconKey; className?: string }) => {
  const Icon = ICONS[icon];
  return <Icon className={className} />;
};

const eyebrow = "px-3 text-[10px] font-semibold uppercase tracking-wider text-neutral-400";

/** The rich provider-status popover (Toolbar.dc.html). One structure for every
 * status: header (repo link or static panel), an optional note, a primary
 * action, optional GitHub PR/settings shortcuts, and the always-present
 * "In GitLane" footer (repo settings / remotes). */
export const ProviderPopover = ({
  model,
  onViewPrs,
  onSignIn,
  onOpenRepoSettings,
  onClose,
}: {
  model: ProviderPopoverModel;
  onViewPrs: () => void;
  /** Open the global Accounts settings to bind a GitHub account. */
  onSignIn: () => void;
  /** Open the repo-scoped Repository settings window at a section. */
  onOpenRepoSettings: (section: RepoSettingsSection) => void;
  onClose: () => void;
}) => {
  const runPrimary = () => {
    const { action } = model.primary!;
    switch (action.kind) {
      case "view-prs":
        onViewPrs();
        break;
      case "sign-in":
        onSignIn();
        break;
      case "add-remote":
        onOpenRepoSettings("remotes");
        break;
      case "open-url":
        openExternalUrl(action.url);
        break;
    }
    onClose();
  };

  const headerInner = (
    <>
      <span className={cn("mt-0.5 grid place-items-center", model.headerTone)}>
        <Glyph icon={model.headerIcon} className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1 truncate text-[13.5px] font-semibold text-neutral-900 dark:text-white">
          {model.title}
          {model.headHref && <span className="text-[11px] text-neutral-400">↗</span>}
        </div>
        <div className="truncate text-[12px] text-neutral-500 dark:text-neutral-400">{model.host}</div>
      </div>
      {model.capability && (
        <span
          className={cn(
            "ml-auto inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-semibold",
            model.capability.tone,
          )}
        >
          {model.capability.label}
        </span>
      )}
    </>
  );

  return (
    // Non-modal disclosure region (matches the branch navigator's lightweight
    // popover): the trigger owns `aria-expanded`, dismissal is outside-click /
    // Escape via useDismiss, and Tab flows through the rows in DOM order. No
    // `role="dialog"` — that would promise focus-trapping this doesn't do.
    <div className="absolute right-0 top-[calc(100%+6px)] z-50 w-[306px] overflow-hidden rounded-xl border border-black/10 bg-white shadow-[0_18px_44px_-8px_rgba(0,0,0,0.38)] dark:border-white/10 dark:bg-neutral-800">
      {/* HEADER — a link to the repo on its host, or a static panel. */}
      {model.headHref ? (
        <button
          type="button"
          onClick={() => {
            openExternalUrl(model.headHref!);
            onClose();
          }}
          title={model.headHref}
          className={cn(
            "flex w-full items-start gap-2.5 border-b border-black/[0.06] p-3 text-left hover:bg-black/[0.03] dark:border-white/[0.07] dark:hover:bg-white/[0.04]",
            focusRing,
          )}
        >
          {headerInner}
        </button>
      ) : (
        <div className="flex items-start gap-2.5 border-b border-black/[0.06] p-3 dark:border-white/[0.07]">
          {headerInner}
        </div>
      )}

      {/* NOTE */}
      {model.note && (
        <div className="text-pretty px-3 pt-2.5 text-[12.5px] leading-relaxed text-neutral-500 dark:text-neutral-400">
          {model.note}
        </div>
      )}

      {/* PRIMARY ACTION */}
      {model.primary && (
        <div className="p-1.5">
          <button
            type="button"
            onClick={runPrimary}
            className={cn(
              "flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-[13px] font-medium text-[color:var(--accent)] hover:bg-[var(--accent-soft)]",
              focusRing,
            )}
          >
            <span className="shrink-0">
              <Glyph icon={model.primary.icon} className="h-4 w-4" />
            </span>
            <span className="flex-1 truncate text-left">{model.primary.label}</span>
            {model.primary.suffix && (
              <span className="text-[12px] text-[color:var(--accent)]">{model.primary.suffix}</span>
            )}
          </button>
        </div>
      )}

      {/* GITHUB SHORTCUTS */}
      {model.githubEyebrow && (
        <>
          <div className={cn(eyebrow, "pb-1")}>{model.githubEyebrow}</div>
          <div className="px-1.5 pb-1.5">
            {model.githubLinks.map((link) => (
              <PopoverLinkRow
                key={link.href}
                icon={<Glyph icon={link.icon} className="h-4 w-4" />}
                label={link.label}
                href={link.href}
                onClose={onClose}
              />
            ))}
          </div>
        </>
      )}

      {/* HOST SETTINGS SHORTCUTS */}
      {model.settings && (
        <>
          <div className="mx-3 border-t border-black/[0.06] dark:border-white/[0.07]" />
          <div className="flex items-center gap-1.5 px-3 pb-1 pt-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
              {model.settings.eyebrow}
            </span>
            <span className="truncate font-mono text-[10px] text-neutral-300 dark:text-neutral-600">
              {model.settings.mono}
            </span>
          </div>
          <div className="px-1.5 pb-1.5">
            {model.settings.links.map((link) => (
              <PopoverLinkRow
                key={link.href}
                icon={<Glyph icon={link.icon} className="h-4 w-4" />}
                label={link.label}
                href={link.href}
                onClose={onClose}
              />
            ))}
          </div>
        </>
      )}

      {/* IN GITLANE — always available */}
      <div className={cn(eyebrow, "mt-0.5 border-t border-black/[0.06] pb-1 pt-1.5 dark:border-white/[0.07]")}>
        In GitLane
      </div>
      <div className="px-1.5 pb-1.5">
        <button
          type="button"
          onClick={() => {
            onOpenRepoSettings("identity");
            onClose();
          }}
          className={cn(
            "flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-[13px] font-medium text-[color:var(--accent)] hover:bg-[var(--accent-soft)]",
            focusRing,
          )}
        >
          <span className="shrink-0">
            <SettingsIcon className="h-4 w-4" />
          </span>
          <span className="flex-1 truncate text-left">Repository settings…</span>
        </button>
        <button
          type="button"
          onClick={() => {
            onOpenRepoSettings("remotes");
            onClose();
          }}
          className={cn(
            "flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-[13px] text-neutral-600 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/5",
            focusRing,
          )}
        >
          <span className="shrink-0 text-neutral-400">
            <RemotesIcon className="h-4 w-4" />
          </span>
          <span className="flex-1 truncate text-left">Manage remotes…</span>
        </button>
      </div>
    </div>
  );
};
