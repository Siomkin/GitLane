// Brand glyph + human name for "open this on the forge" affordances in the PR
// surface. Origin's browser product is Codebase (cursor.com/codebase), not GitHub.
// This file is .tsx so Fast Refresh tracks the icon components (a .ts helper
// that returned `CursorOriginIcon` crashed WKWebView with a missing-variable error).

import { ForgeKind } from "@/lib/api";
import { openExternalUrl } from "@/lib/openExternal";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { GitHubIcon } from "@/components/ui/icons";
import { ForgeIcon, forgeOf } from "@/components/chrome/forges";

export function prForgeOpenName(
  kind: ForgeKind | null | undefined,
  forge: string | null | undefined,
): string {
  if (kind === ForgeKind.CursorOrigin) return "Codebase";
  return forge ?? forgeOf(kind)?.label ?? "GitHub";
}

export function PrForgeIcon({
  kind,
  className,
}: {
  kind: ForgeKind | null | undefined;
  className?: string;
}) {
  // The PR surface renders under the GitHub default until detection lands.
  return <ForgeIcon kind={kind} className={className} fallback={GitHubIcon} />;
}

/** Shared "open this pull request on its forge" click handler. One definition
 * for the header icon button and the conversation action, so both name the
 * forge the same way and report missing / rejected / failed URLs identically. */
export function useOpenPrOnForge(pr: { url: string }): { open: () => void; forgeName: string } {
  const forge = useRepo((s) => s.forge);
  const showToast = useUi((s) => s.showToast);
  const forgeName = prForgeOpenName(forge?.kind, forge?.forge);
  const requestNoun = forgeOf(forge?.kind)?.noun === "merge request" ? "MR" : "PR";

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
