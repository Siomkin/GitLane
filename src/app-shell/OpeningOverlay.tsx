// The delayed "Opening…" layer over the body (tab-open-progress): shown only
// once an open has stayed pending past OPENING_OVERLAY_DELAY_MS, so fast local
// switches never flash it. It dims — never clears — the repository still on
// screen (GL-20); the title bar and tab strip sit outside it and stay usable.

import { useEffect, useState } from "react";
import { Spinner } from "@/components/ui/Loading";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import { openingLabel } from "@/lib/openingLabel";
import { isRemoteLocator, remoteHost, remoteOrigin } from "@/lib/paths";
import { tabDisplay, tabIdentity } from "@/lib/tabs";
import { useRepo } from "@/store/repo";
import type { PendingOpen } from "@/store/repoTypes";
import { connectionFor, remoteSessionOf, useRemoteSessions } from "@/store/remoteSessions";
import { repoNameOf, useUi } from "@/store/ui";

export const OPENING_OVERLAY_DELAY_MS = 400;

export const OpeningOverlay = () => {
  const pendingOpen = useRepo((state) => state.pendingOpen);
  const [shownFor, setShownFor] = useState<PendingOpen | null>(null);

  useEffect(() => {
    if (!pendingOpen) return;
    const timer = setTimeout(() => setShownFor(pendingOpen), OPENING_OVERLAY_DELAY_MS);
    // Reset too, so reopening the same path later waits out the delay again.
    return () => {
      clearTimeout(timer);
      setShownFor(null);
    };
  }, [pendingOpen]);

  // A stale `shownFor` (the open ended, or a newer one is still inside its
  // delay) renders nothing.
  if (!pendingOpen || shownFor !== pendingOpen) return null;
  return <OpeningLayer path={pendingOpen.path} />;
};

const OpeningLayer = ({ path }: { path: string }) => {
  const info = useRepo((state) => state.tabInfoByPath[path]);
  const repoGroups = useUi((state) => state.repoGroups);
  const repoLabelsByIdentity = useUi((state) => state.repoLabelsByIdentity);
  const remote = isRemoteLocator(path);
  const origin = remote ? remoteOrigin(path) : "";
  const session = useRemoteSessions(remoteSessionOf(origin));
  const connection = useRemoteSessions(connectionFor(origin));
  const shown = tabDisplay(path, info, repoNameOf({ repoGroups, repoLabelsByIdentity }, tabIdentity(path, info)));
  const name = shown.kind === "worktree" ? `${shown.repoName} · ${shown.detail}` : shown.name;
  const host = remote ? (connection?.name ?? remoteHost(path)) : null;
  const cancel = useRepo((state) => state.cancelPendingOpen);

  return (
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 bg-white/70 text-[13px] text-neutral-700 backdrop-blur-[1px] dark:bg-neutral-900/70 dark:text-neutral-200">
      <Spinner accent className="h-5 w-5" />
      <span role="status">{openingLabel(name, host, session)}</span>
      {host && <span className="text-[12px] text-neutral-400 dark:text-neutral-500">{path}</span>}
      {/* The way out when no tab can supersede the open (the welcome screen,
          or an open started with no tab active). */}
      <button
        type="button"
        onClick={cancel}
        className={cn(
          "mt-1 rounded-md border border-black/10 px-2.5 py-1 text-[12px] text-neutral-600 hover:bg-black/5 dark:border-white/10 dark:text-neutral-300 dark:hover:bg-white/5",
          focusRing,
        )}
      >
        Cancel
      </button>
    </div>
  );
};
