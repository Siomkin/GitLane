// Brand glyph + human name for "open this on the forge" affordances in the PR
// surface. Origin's browser product is Codebase (cursor.com/codebase), not GitHub.
// This file is .tsx so Fast Refresh tracks the icon components (a .ts helper
// that returned `CursorOriginIcon` crashed WKWebView with a missing-variable error).

import { ForgeKind } from "@/lib/api";
import { BitbucketIcon, CursorOriginIcon, GitHubIcon, GitLabIcon } from "@/components/ui/icons";

export function prForgeOpenName(
  kind: ForgeKind | null | undefined,
  forge: string | null | undefined,
): string {
  if (kind === ForgeKind.GitLab) return forge ?? "GitLab";
  if (kind === ForgeKind.Bitbucket) return forge ?? "Bitbucket";
  if (kind === ForgeKind.CursorOrigin) return "Codebase";
  return forge ?? "GitHub";
}

export function PrForgeIcon({
  kind,
  className,
}: {
  kind: ForgeKind | null | undefined;
  className?: string;
}) {
  if (kind === ForgeKind.GitLab) return <GitLabIcon className={className} />;
  if (kind === ForgeKind.Bitbucket) return <BitbucketIcon className={className} />;
  if (kind === ForgeKind.CursorOrigin) return <CursorOriginIcon className={className} />;
  return <GitHubIcon className={className} />;
}
