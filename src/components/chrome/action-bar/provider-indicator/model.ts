import { ForgeKind } from "../../../../lib/api";
import type { RepoForge } from "../../../../lib/api";
import type { ProviderState } from "./state";

/** Glyph keys the popover resolves to real icon components in `ProviderPopover`.
 * Kept as strings so this module stays pure (no JSX) and unit-testable. */
export type PopoverIconKey =
  | "github"
  | "gitlab"
  | "bitbucket"
  | "gitea"
  | "forgejo"
  | "azure"
  | "cloud"
  | "cloudOff"
  | "warning"
  | "pr"
  | "issue"
  | "gear"
  | "branch"
  | "people"
  | "webhook"
  | "key"
  | "external"
  | "plus"
  | "remotes";

/** What the popover's primary button does. Resolved to a handler in the view. */
export type PopoverAction =
  | { kind: "view-prs" }
  | { kind: "sign-in" }
  | { kind: "add-remote" }
  | { kind: "open-url"; url: string };

export interface PopoverLinkSpec {
  icon: PopoverIconKey;
  label: string;
  href: string;
}

export interface PopoverCapability {
  label: string;
  /** Colour classes for the pill (the component prepends shape/size). */
  tone: string;
}

export interface PopoverPrimary {
  icon: PopoverIconKey;
  label: string;
  /** Trailing affordance glyph ("→", "↗") or "" for none. */
  suffix: string;
  action: PopoverAction;
}

export interface ProviderSettingsSection {
  /** Eyebrow label, e.g. "Settings on github.com". */
  eyebrow: string;
  /** Monospace hint shown beside the eyebrow, e.g. "/settings". */
  mono: string;
  links: PopoverLinkSpec[];
}

/** Fully-resolved content for the provider popover, one shape for every status.
 * `headHref === null` renders a static (non-link) header; `primary === null`
 * drops the primary button (e.g. an unrecognised remote with no web URL). */
export interface ProviderPopoverModel {
  headerIcon: PopoverIconKey;
  headerTone: string;
  title: string;
  host: string;
  headHref: string | null;
  capability: PopoverCapability | null;
  note: string;
  primary: PopoverPrimary | null;
  /** Non-null shows the "On <host>" GitHub links group. */
  githubEyebrow: string | null;
  githubLinks: PopoverLinkSpec[];
  /** Non-null shows the "Settings on <host>" links group. */
  settings: ProviderSettingsSection | null;
}

const MUTED = "text-neutral-500 dark:text-neutral-400";
const STRONG = "text-neutral-700 dark:text-neutral-200";
const ROSE = "text-rose-600 dark:text-rose-400";

const FORGE_ICON_KEY: Partial<Record<ForgeKind, PopoverIconKey>> = {
  [ForgeKind.GitHub]: "github",
  [ForgeKind.GitLab]: "gitlab",
  [ForgeKind.Bitbucket]: "bitbucket",
  [ForgeKind.AzureDevOps]: "azure",
  [ForgeKind.Gitea]: "gitea",
  [ForgeKind.Forgejo]: "forgejo",
};

const forgeIconKey = (kind: ForgeKind | null): PopoverIconKey =>
  (kind && FORGE_ICON_KEY[kind]) || "cloud";

/** `owner/repo` from a web URL (scheme + host + trailing `.git` stripped),
 * falling back to the host when no path is available. */
const slugOf = (webUrl: string | null, host: string | null): string => {
  if (!webUrl) return host ?? "remote";
  return webUrl.replace(/^https?:\/\/[^/]+\/?/, "").replace(/\.git$/, "") || host || "remote";
};

const githubSections = (gh: string | null, host: string, prCount: number) => {
  if (!gh) return { githubEyebrow: null, githubLinks: [], settings: null };
  return {
    githubEyebrow: `On ${host}`,
    githubLinks: [
      { icon: "pr" as const, label: `Pull requests (${prCount})`, href: `${gh}/pulls` },
      { icon: "issue" as const, label: "Issues", href: `${gh}/issues` },
    ],
    settings: {
      eyebrow: `Settings on ${host}`,
      mono: "/settings",
      links: [
        { icon: "gear" as const, label: "General", href: `${gh}/settings` },
        { icon: "branch" as const, label: "Branches", href: `${gh}/settings/branches` },
        { icon: "people" as const, label: "Collaborators & teams", href: `${gh}/settings/access` },
        { icon: "webhook" as const, label: "Webhooks", href: `${gh}/settings/hooks` },
      ],
    },
  };
};

/** A recognised GitHub remote — signed in (`connected`) or not (`needs-auth`). */
const githubModel = (
  forge: RepoForge,
  prCount: number,
  variant: "connected" | "needs-auth",
): ProviderPopoverModel => {
  const host = forge.host ?? "github.com";
  const base = {
    headerIcon: "github" as const,
    headerTone: STRONG,
    title: slugOf(forge.webUrl, host),
    host,
    headHref: forge.webUrl,
    ...githubSections(forge.webUrl, host, prCount),
  };
  if (variant === "connected") {
    return {
      ...base,
      capability: { label: "PRs on", tone: "text-emerald-600 dark:text-emerald-400 bg-emerald-500/12" },
      note: "",
      primary: {
        icon: "pr",
        label: prCount > 0 ? `View ${prCount} pull request${prCount === 1 ? "" : "s"}` : "View pull requests",
        suffix: "→",
        action: { kind: "view-prs" },
      },
    };
  }
  return {
    ...base,
    capability: { label: "Sign in", tone: "text-amber-600 dark:text-amber-400 bg-amber-500/12" },
    note: "A GitHub remote, but no account is bound. Sign in to view and open pull requests.",
    primary: { icon: "key", label: "Sign in to GitHub", suffix: "", action: { kind: "sign-in" } },
  };
};

/** The "On <host>" links group for a GitLab remote — merge requests + issues,
 * under GitLab's `/-/` path. No settings sub-group (GitLab's settings paths
 * differ from GitHub's and aren't part of this surface). */
const gitlabSections = (webUrl: string | null, host: string, prCount: number) => {
  if (!webUrl) return { githubEyebrow: null, githubLinks: [], settings: null };
  return {
    githubEyebrow: `On ${host}`,
    githubLinks: [
      { icon: "pr" as const, label: `Merge requests (${prCount})`, href: `${webUrl}/-/merge_requests` },
      { icon: "issue" as const, label: "Issues", href: `${webUrl}/-/issues` },
    ],
    settings: null,
  };
};

/** A recognised GitLab remote — merge requests ready (`connected`) or awaiting a
 * glab / token sign-in (`needs-auth`). Mirrors [`githubModel`] with GitLab copy,
 * icon, and `/-/` links (GL-145). */
const gitlabModel = (
  forge: RepoForge,
  prCount: number,
  variant: "connected" | "needs-auth",
): ProviderPopoverModel => {
  const host = forge.host ?? "gitlab.com";
  const base = {
    headerIcon: "gitlab" as const,
    headerTone: STRONG,
    title: slugOf(forge.webUrl, host),
    host,
    headHref: forge.webUrl,
    ...gitlabSections(forge.webUrl, host, prCount),
  };
  if (variant === "connected") {
    return {
      ...base,
      capability: { label: "MRs on", tone: "text-emerald-600 dark:text-emerald-400 bg-emerald-500/12" },
      note: "",
      primary: {
        icon: "pr",
        label: prCount > 0 ? `View ${prCount} merge request${prCount === 1 ? "" : "s"}` : "View merge requests",
        suffix: "→",
        action: { kind: "view-prs" },
      },
    };
  }
  return {
    ...base,
    capability: { label: "Sign in", tone: "text-amber-600 dark:text-amber-400 bg-amber-500/12" },
    note: "A GitLab remote, but no sign-in yet. Sign in with glab or a token to view and open merge requests.",
    primary: { icon: "key", label: "Sign in to GitLab", suffix: "", action: { kind: "sign-in" } },
  };
};

/** A non-PR forge: recognised (Bitbucket/Azure/Gitea/Forgejo) or an unrecognised
 * host. The repo link still works; pull requests do not. */
const forgeModel = (forge: RepoForge): ProviderPopoverModel => {
  const host = forge.host ?? "remote";
  const label = forge.forge ?? forge.host ?? "this remote";
  return {
    headerIcon: forgeIconKey(forge.kind),
    headerTone: MUTED,
    title: slugOf(forge.webUrl, forge.host),
    host,
    headHref: forge.webUrl,
    capability: {
      label: "No PRs",
      tone: "text-neutral-500 dark:text-neutral-400 bg-black/[0.05] dark:bg-white/[0.07]",
    },
    note: `Pull requests aren't available for ${label} remotes. Browsing, push, fetch and pull still work.`,
    primary: forge.webUrl
      ? { icon: "external", label: `Open on ${label}`, suffix: "↗", action: { kind: "open-url", url: forge.webUrl } }
      : null,
    githubEyebrow: null,
    githubLinks: [],
    settings: null,
  };
};

const missingModel = (): ProviderPopoverModel => ({
  headerIcon: "cloudOff",
  headerTone: MUTED,
  title: "No remote",
  host: "Local-only repository",
  headHref: null,
  capability: null,
  note: "This repository has no remote. Add one to enable push, fetch and pull requests.",
  primary: { icon: "plus", label: "Add a remote…", suffix: "", action: { kind: "add-remote" } },
  githubEyebrow: null,
  githubLinks: [],
  settings: null,
});

/** GitHub account discovery failed. The cause varies — `gh` not installed, a
 * version below the capability baseline, or an auth/parse failure — so the copy
 * stays generic ("unavailable", "install or update") and surfaces the actual
 * error as the subtitle when one is available, rather than always saying "not
 * found" / "install". */
const errorModel = (detail?: string | null): ProviderPopoverModel => {
  const reason = detail?.trim().replace(/^Error:\s*/i, "");
  return {
    headerIcon: "warning",
    headerTone: ROSE,
    title: "GitHub CLI unavailable",
    host: reason || "Provider unavailable",
    headHref: null,
    capability: { label: "Error", tone: "text-rose-600 dark:text-rose-400 bg-rose-500/12" },
    note: "Pull requests need the GitHub CLI (gh). Install or update it to browse them — push, fetch and pull are unaffected.",
    primary: { icon: "external", label: "Set up gh", suffix: "↗", action: { kind: "open-url", url: "https://cli.github.com" } },
    githubEyebrow: null,
    githubLinks: [],
    settings: null,
  };
};

/** Build the popover content for a provider status. GitHub and GitLab forges
 * show a PR/MR + links surface (each with its own connected / needs-auth copy);
 * other recognised forges and unrecognised hosts share the "no PRs, open
 * externally" shape; missing/error are static panels. */
export const providerPopoverModel = (
  state: ProviderState,
  forge: RepoForge,
  prCount: number,
  /** The accounts-store error string for the `error` state; surfaced verbatim
   * (trimmed) so users can tell "install" from "upgrade/refresh". */
  errorDetail?: string | null,
): ProviderPopoverModel => {
  switch (state) {
    case "missing":
      return missingModel();
    case "error":
      return errorModel(errorDetail);
    case "needs-auth":
      return forge.kind === ForgeKind.GitLab
        ? gitlabModel(forge, prCount, "needs-auth")
        : githubModel(forge, prCount, "needs-auth");
    case "connected":
      if (forge.kind === ForgeKind.GitHub) return githubModel(forge, prCount, "connected");
      if (forge.kind === ForgeKind.GitLab) return gitlabModel(forge, prCount, "connected");
      return forgeModel(forge);
    case "unsupported":
      return forgeModel(forge);
  }
};
