// Brand glyph + human name for "open this on the forge" affordances in the PR
// surface. Origin's browser product is Codebase (cursor.com/codebase), not GitHub.
// This file is .tsx so Fast Refresh tracks the icon components (a .ts helper
// that returned `CursorOriginIcon` crashed WKWebView with a missing-variable error).

import { ForgeKind } from "@/lib/api";
import { openExternalUrl } from "@/lib/openExternal";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
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

/** Shared "open this pull request on its forge" click handler. One definition
 * for the header icon button and the conversation action, so both name the
 * forge the same way and report missing / rejected / failed URLs identically. */
export function useOpenPrOnForge(pr: { url: string }): { open: () => void; forgeName: string } {
  const forge = useRepo((s) => s.forge);
  const showToast = useUi((s) => s.showToast);
  const forgeName = prForgeOpenName(forge?.kind, forge?.forge);
  const requestNoun = forge?.kind === ForgeKind.GitLab ? "MR" : "PR";

  const open = () => {
    if (!pr.url) {
      showToast(`No ${forgeName} URL for this ${requestNoun}`, "error");
      return;
    }
    const accepted = openExternalUrl(pr.url, (error) =>
      showToast(`Could not open this ${requestNoun} on ${forgeName}: ${String(error)}`, "error"),
    );
    if (!accepted) showToast(`Invalid ${forgeName} URL for this ${requestNoun}`, "error");
  };

  return { open, forgeName };
}
