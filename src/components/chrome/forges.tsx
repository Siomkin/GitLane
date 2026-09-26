// The one per-forge presentation table (beside chrome, not in the domain-free
// `components/ui`, because it is keyed by the IPC `ForgeKind`): label and request noun (from
// `FORGE_NAMES` in lib) plus the brand glyph. Components index it instead of
// branching on the forge kind. What a forge can *do* is not here — that is
// `RepoForge.capabilities`, declared by the backend.

import type { ComponentType } from "react";
import { ForgeKind } from "@/lib/api";
import { FORGE_NAMES } from "@/lib/forgeHelp";
import {
  AzureDevOpsIcon,
  BitbucketIcon,
  CloudIcon,
  CursorOriginIcon,
  ForgejoIcon,
  GitHubIcon,
  GiteaIcon,
  GitLabIcon,
} from "@/components/ui/icons";

type IconProps = { className?: string };

export interface ForgePresentation {
  label: string;
  noun: "pull request" | "merge request";
  Icon: ComponentType<IconProps>;
}

const ICONS: Record<ForgeKind, ComponentType<IconProps>> = {
  [ForgeKind.GitHub]: GitHubIcon,
  [ForgeKind.GitLab]: GitLabIcon,
  [ForgeKind.Bitbucket]: BitbucketIcon,
  [ForgeKind.AzureDevOps]: AzureDevOpsIcon,
  [ForgeKind.Gitea]: GiteaIcon,
  [ForgeKind.Forgejo]: ForgejoIcon,
  [ForgeKind.CursorOrigin]: CursorOriginIcon,
};

export const FORGES = Object.fromEntries(
  Object.values(ForgeKind).map((kind) => [kind, { ...FORGE_NAMES[kind], Icon: ICONS[kind] }]),
) as Record<ForgeKind, ForgePresentation>;

/** The presentation for a provider word, or `undefined` for one that is not a
 * forge kind (`"other"`, an unrecognised host). */
export const forgeOf = (kind: string | null | undefined): ForgePresentation | undefined =>
  kind ? FORGES[kind as ForgeKind] : undefined;

/** A forge's brand glyph; `fallback` (a generic cloud by default) for anything
 * that is not a known forge. */
export function ForgeIcon({
  kind,
  className,
  fallback: Fallback = CloudIcon,
}: {
  kind: string | null | undefined;
  className?: string;
  fallback?: ComponentType<IconProps>;
}) {
  const Icon = forgeOf(kind)?.Icon ?? Fallback;
  return <Icon className={className} />;
}
