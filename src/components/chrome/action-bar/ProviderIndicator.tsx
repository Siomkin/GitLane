import { cn } from "../../../lib/cn";
import { focusRing } from "../../../lib/ui";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { ComponentType } from "react";
import { ForgeKind } from "../../../lib/api";
import type { RepoForge } from "../../../lib/api";
import {
  AzureDevOpsIcon,
  BitbucketIcon,
  CloudIcon,
  CloudOffIcon,
  ForgejoIcon,
  GiteaIcon,
  GitHubIcon,
  GitLabIcon,
  WarningIcon,
} from "../../ui/icons";
import type { ProviderState } from "./provider";

/** Per-forge brand glyph. Forges without a dedicated mark fall back to a generic
 * cloud (see `providerView`). Add an entry here to give another forge its logo. */
const FORGE_ICON: Partial<Record<ForgeKind, ComponentType<{ className?: string }>>> = {
  [ForgeKind.GitHub]: GitHubIcon,
  [ForgeKind.GitLab]: GitLabIcon,
  [ForgeKind.Bitbucket]: BitbucketIcon,
  [ForgeKind.AzureDevOps]: AzureDevOpsIcon,
  [ForgeKind.Gitea]: GiteaIcon,
  [ForgeKind.Forgejo]: ForgejoIcon,
};

/** Status-dot colour per provider state (the design's `pm.dot`). `connected`
 * has no dot — a healthy GitHub remote needs no badge. */
const PROVIDER_DOT: Record<ProviderState, string | null> = {
  connected: null,
  "needs-auth": "#d4a72c",
  unsupported: "#9a9a9a",
  missing: "#9a9a9a",
  error: "#cf222e",
};

/** Icon, tone, and tooltip for a provider state. The icon follows the *forge*
 * (GitHub mark vs a generic cloud), the dot + tooltip follow the *status*. */
const providerView = (
  state: ProviderState,
  forge: RepoForge,
): { Icon: ComponentType<{ className?: string }>; tone: string; title: string } => {
  const host = forge.host ?? "";
  // Prefer the repo slug ("github.com/owner/repo") when we have a web URL.
  const slug = forge.webUrl ? forge.webUrl.replace(/^https?:\/\//, "") : host || "remote";
  const muted = "text-neutral-500 dark:text-neutral-400";

  // Icon is provider-led (its brand mark, else a generic cloud); missing/error
  // override with their own glyphs.
  const Icon =
    state === "missing"
      ? CloudOffIcon
      : state === "error"
        ? WarningIcon
        : (forge.kind && FORGE_ICON[forge.kind]) || CloudIcon;
  const tone = state === "error" ? "text-rose-500 dark:text-rose-400" : muted;

  switch (state) {
    case "connected":
      return { Icon, tone, title: slug };
    case "needs-auth":
      return { Icon, tone, title: `${slug} · sign in to GitHub` };
    case "unsupported":
      return { Icon, tone, title: `${host || "This remote"} · unsupported provider` };
    case "missing":
      return { Icon, tone, title: "No remote configured" };
    case "error":
      return { Icon, tone, title: `${slug} · GitHub connection error` };
  }
};

/** Remote-provider indicator: provider glyph plus a status dot (amber = sign-in
 * needed, grey = no PR support / no remote, red = gh missing; none = healthy).
 * When the repo has a web URL it's a button that opens the repo on its provider;
 * otherwise (e.g. no remote) it's a static badge. */
export const ProviderIndicator = ({
  state,
  forge,
}: {
  state: ProviderState;
  forge: RepoForge;
}) => {
  const { Icon, tone, title } = providerView(state, forge);
  const dot = PROVIDER_DOT[state];
  const href = forge.webUrl;
  const inner = (
    <>
      <Icon className="h-4 w-4" />
      {dot && (
        <span
          className="absolute right-1 top-1 h-2 w-2 rounded-full ring-2 ring-white dark:ring-neutral-800"
          style={{ background: dot }}
        />
      )}
    </>
  );

  if (!href) {
    return (
      <div
        className={cn("relative grid h-8 w-8 flex-none place-items-center", tone)}
        title={title}
        aria-label={title}
      >
        {inner}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => void openUrl(href)}
      title={`${title}\nOpen ${href}`}
      aria-label={`${title} — open repository on its provider`}
      className={cn(
        "relative grid h-8 w-8 flex-none place-items-center rounded-lg transition-colors",
        "hover:bg-black/5 dark:hover:bg-white/5",
        tone,
        focusRing,
      )}
    >
      {inner}
    </button>
  );
};
