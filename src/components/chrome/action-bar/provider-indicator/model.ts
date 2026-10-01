import { CURSOR_ORIGIN_HOST, ForgeKind } from "@/lib/api";
import type { RepoForge } from "@/lib/api";
import { FORGE_NAMES } from "@/lib/forgeHelp";
import type { ProviderState } from "./state";
import type { ProviderPopoverModel } from "./popoverTypes";

export type {
  PopoverAction,
  PopoverCapability,
  PopoverIconKey,
  PopoverLinkSpec,
  PopoverPrimary,
  ProviderPopoverModel,
  ProviderSettingsSection,
} from "./popoverTypes";
import { webUrlSlug } from "@/lib/paths";

const MUTED = "text-neutral-500 dark:text-neutral-400";
const STRONG = "text-neutral-700 dark:text-neutral-200";
const ROSE = "text-rose-600 dark:text-rose-400";
const TRANSPORT_TONE = "text-blue-600 dark:text-blue-400 bg-blue-500/12";

/** `owner/repo` from a web URL (scheme + host + trailing `.git` stripped),
 * falling back to the host when no path is available. */
const slugOf = (webUrl: string | null, host: string | null): string =>
  webUrl ? webUrlSlug(webUrl) || host || "remote" : (host ?? "remote");

type PrForge = typeof ForgeKind.GitHub | typeof ForgeKind.GitLab | typeof ForgeKind.Bitbucket | typeof ForgeKind.CursorOrigin;
type PrVariant = "connected" | "transport-auth" | "needs-auth";
type Links = Pick<ProviderPopoverModel, "hostEyebrow" | "hostLinks" | "settings">;

const NO_LINKS: Links = { hostEyebrow: null, hostLinks: [], settings: null };

/** Everything that differs between the PR-capable forges' popovers: default
 * host, the "On <host>" links, and the not-signed-in copy. The shape, the
 * header mark (the forge itself) and the connected copy are shared by
 * [`prForgeModel`]. */
interface PrForgeSpec {
  defaultHost: string;
  /** Short plural for the capability chip ("PRs" / "MRs"). */
  abbr: string;
  /** The links group for a repo web URL (the caller handles a missing URL). */
  links: (webUrl: string, host: string, prCount: number) => Links;
  /** Copy for a remote whose git auth works but PRs are not signed in. */
  transportNote: string;
  /** GitHub offers "sign in" here; the other forges link out to the repo. */
  transportSignIn: boolean;
  needsAuth: { chip: string; note: string; primary: string };
}

const PR_FORGE_SPEC: Record<PrForge, PrForgeSpec> = {
  [ForgeKind.GitHub]: {
    defaultHost: "github.com",
    abbr: "PRs",
    links: (gh, host, prCount) => ({
      hostEyebrow: `On ${host}`,
      hostLinks: [
        { icon: "pr", label: `Pull requests (${prCount})`, href: `${gh}/pulls` },
        { icon: "issue", label: "Issues", href: `${gh}/issues` },
      ],
      settings: {
        eyebrow: `Settings on ${host}`,
        mono: "/settings",
        links: [
          { icon: "gear", label: "General", href: `${gh}/settings` },
          { icon: "branch", label: "Branches", href: `${gh}/settings/branches` },
          { icon: "people", label: "Collaborators & teams", href: `${gh}/settings/access` },
          { icon: "webhook", label: "Webhooks", href: `${gh}/settings/hooks` },
        ],
      },
    }),
    transportNote:
      "Git fetch and push use this remote's HTTPS URL with GCM/helper, or SSH. Sign in with gh to enable GitHub pull requests in GitLane.",
    transportSignIn: true,
    needsAuth: {
      chip: "Sign in",
      note: "A GitHub remote, but no gh account is bound. Sign in with gh for pull requests; GCM/helper or SSH can still handle git transport.",
      primary: "Sign in to GitHub",
    },
  },
  // GitLab's links live under `/-/`; no settings sub-group (its settings paths
  // differ from GitHub's and aren't part of this surface) (GL-145).
  [ForgeKind.GitLab]: {
    defaultHost: "gitlab.com",
    abbr: "MRs",
    links: (webUrl, host, prCount) => ({
      hostEyebrow: `On ${host}`,
      hostLinks: [
        { icon: "pr", label: `Merge requests (${prCount})`, href: `${webUrl}/-/merge_requests` },
        { icon: "issue", label: "Issues", href: `${webUrl}/-/issues` },
      ],
      settings: null,
    }),
    transportNote:
      "Git fetch and push use this remote's HTTPS URL with GCM/helper, or SSH. Sign in with glab to enable merge requests in GitLane.",
    transportSignIn: false,
    needsAuth: {
      chip: "Sign in",
      note: "A GitLab remote, but no git auth is configured yet. Add an HTTPS username for GCM/helper, use SSH, or sign in with glab.",
      primary: "Sign in to GitLab",
    },
  },
  // Bitbucket: `/pull-requests` and `/issues`; no settings sub-group (GL-141).
  [ForgeKind.Bitbucket]: {
    defaultHost: "bitbucket.org",
    abbr: "PRs",
    links: (webUrl, host, prCount) => ({
      hostEyebrow: `On ${host}`,
      hostLinks: [
        { icon: "pr", label: `Pull requests (${prCount})`, href: `${webUrl}/pull-requests` },
        { icon: "issue", label: "Issues", href: `${webUrl}/issues` },
      ],
      settings: null,
    }),
    transportNote:
      "Git fetch and push use this remote's HTTPS URL with GCM/helper, or SSH. Bitbucket pull requests are not enabled by GCM credentials alone.",
    transportSignIn: false,
    needsAuth: {
      chip: "Set up auth",
      note: "A Bitbucket remote, but no git auth is configured yet. Add an HTTPS username for GCM/helper or use SSH.",
      primary: "Set up Bitbucket auth",
    },
  },
  // Cursor Origin uses the Cursor brand mark; never falls through to GitHub
  // copy or the "No PRs" forge model.
  [ForgeKind.CursorOrigin]: {
    defaultHost: CURSOR_ORIGIN_HOST,
    abbr: "PRs",
    links: (webUrl, host, prCount) => ({
      hostEyebrow: `On ${host}`,
      hostLinks: [{ icon: "pr", label: `Pull requests (${prCount})`, href: webUrl }],
      settings: null,
    }),
    transportNote:
      "Git fetch and push use this remote's HTTPS URL with GCM/helper, or SSH. Sign in with origin to enable Cursor Origin pull requests in GitLane.",
    transportSignIn: false,
    needsAuth: {
      chip: "Sign in",
      note: "A Cursor Origin remote, but origin is not signed in. Sign in with origin for pull requests; GCM/helper or SSH can still handle git transport.",
      primary: "Sign in to Cursor Origin",
    },
  },
};

const isPrForgeKind = (kind: ForgeKind | null): kind is PrForge => kind != null && kind in PR_FORGE_SPEC;

/** A recognised PR-capable remote — signed in (`connected`), git auth only
 * (`transport-auth`), or not signed in (`needs-auth`). `kind` picks the spec;
 * a null kind is the GitHub default. */
const prForgeModel = (
  forge: RepoForge,
  kind: PrForge,
  prCount: number,
  variant: PrVariant,
): ProviderPopoverModel => {
  const spec = PR_FORGE_SPEC[kind];
  const { label, noun } = FORGE_NAMES[kind];
  const host = forge.host ?? spec.defaultHost;
  const base = {
    headerForge: kind,
    headerIcon: "cloud" as const,
    headerTone: STRONG,
    title: slugOf(forge.webUrl, host),
    host,
    headHref: forge.webUrl,
    ...(forge.webUrl ? spec.links(forge.webUrl, host, prCount) : NO_LINKS),
  };
  if (variant === "connected") {
    return {
      ...base,
      capability: { label: `${spec.abbr} on`, tone: "text-emerald-600 dark:text-emerald-400 bg-emerald-500/12" },
      note: "",
      primary: {
        icon: "pr",
        label: prCount > 0 ? `View ${prCount} ${noun}${prCount === 1 ? "" : "s"}` : `View ${noun}s`,
        suffix: "→",
        action: { kind: "view-prs" },
      },
    };
  }
  if (variant === "transport-auth") {
    return {
      ...base,
      capability: { label: "Git auth", tone: TRANSPORT_TONE },
      note: spec.transportNote,
      primary: spec.transportSignIn
        ? { icon: "key", label: `Sign in for ${noun}s`, suffix: "", action: { kind: "sign-in" } }
        : forge.webUrl
          ? { icon: "external", label: `Open on ${label}`, suffix: "↗", action: { kind: "open-url", url: forge.webUrl } }
          : null,
      ...NO_LINKS,
    };
  }
  return {
    ...base,
    capability: { label: spec.needsAuth.chip, tone: "text-amber-600 dark:text-amber-400 bg-amber-500/12" },
    note: spec.needsAuth.note,
    primary: { icon: "key", label: spec.needsAuth.primary, suffix: "", action: { kind: "sign-in" } },
  };
};

/** A non-PR forge: recognised (Azure/Gitea/Forgejo) or an unrecognised host. The
 * repo link still works; pull requests do not. */
const forgeModel = (forge: RepoForge): ProviderPopoverModel => {
  const host = forge.host ?? "remote";
  const label = forge.forge ?? forge.host ?? "this remote";
  return {
    headerForge: forge.kind,
    headerIcon: "cloud",
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
    hostEyebrow: null,
    hostLinks: [],
    settings: null,
  };
};

const missingModel = (): ProviderPopoverModel => ({
  headerForge: null,
  headerIcon: "cloudOff",
  headerTone: MUTED,
  title: "No remote",
  host: "Local-only repository",
  headHref: null,
  capability: null,
  note: "This repository has no remote. Add one to enable push, fetch and pull requests.",
  primary: { icon: "plus", label: "Add a remote…", suffix: "", action: { kind: "add-remote" } },
  hostEyebrow: null,
  hostLinks: [],
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
    headerForge: null,
    headerIcon: "warning",
    headerTone: ROSE,
    title: "GitHub CLI unavailable",
    host: reason || "Provider unavailable",
    headHref: null,
    capability: { label: "Error", tone: "text-rose-600 dark:text-rose-400 bg-rose-500/12" },
    note: "Pull requests need the GitHub CLI (gh). Install or update it to browse them — push, fetch and pull are unaffected.",
    primary: { icon: "external", label: "Set up gh", suffix: "↗", action: { kind: "open-url", url: "https://cli.github.com" } },
    hostEyebrow: null,
    hostLinks: [],
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
    case "transport-auth":
      // Any other kind here is the gh default (github.com is gh's host).
      return prForgeModel(forge, isPrForgeKind(forge.kind) ? forge.kind : ForgeKind.GitHub, prCount, state);
    case "connected":
      return isPrForgeKind(forge.kind) ? prForgeModel(forge, forge.kind, prCount, state) : forgeModel(forge);
    case "unsupported":
      return forgeModel(forge);
  }
};
