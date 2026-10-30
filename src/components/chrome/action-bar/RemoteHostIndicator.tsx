import { cn } from "@/lib/cn";
import { openExternalUrl } from "@/lib/openExternal";
import { isRemoteLocator, remoteHost, remoteOrigin } from "@/lib/paths";
import { focusRing } from "@/lib/ui";
import { connectionFor, remoteSessionOf, useRemoteSessions } from "@/store/remoteSessions";
import { useRepo } from "@/store/repo";
import { ArrowUpRightIcon, ServerIcon } from "@/components/ui/icons";
import { ForgeIcon } from "@/components/chrome/forges";

const DOT: Record<string, string> = {
  connected: "bg-emerald-500",
  connecting: "bg-amber-400",
  installing: "bg-amber-400",
  disconnected: "bg-red-500",
  failed: "bg-red-500",
};

/** Toolbar chip for a repository opened over SSH (remote-ssh-repos): which
 * host it lives on, whether the session is up, and where its remote is
 * hosted. It takes the provider indicator's place: that one reports this
 * computer's accounts and pull requests, neither of which apply here. */
export const RemoteHostIndicator = ({ className }: { className?: string }) => {
  const path = useRepo((s) => s.summary?.path ?? null);
  const remote = !!path && isRemoteLocator(path);
  const session = useRemoteSessions(remoteSessionOf(remote ? remoteOrigin(path) : ""));
  const connection = useRemoteSessions(connectionFor(remote ? remoteOrigin(path) : ""));
  const forge = useRepo((s) => s.forge);
  const webUrl = forge?.webUrl;
  if (!remote) return null;
  const host = connection?.name ?? remoteHost(path);
  const state = session?.state ?? "connected";
  return (
    <div
      role="status"
      title={`On ${host} over SSH (${state}). Git runs on the server with the server's own credentials and config. Pull requests, the terminal, file editing and agents are off for remote repositories.`}
      className={cn(
        "flex h-8 flex-none items-center gap-1.5 rounded-lg border border-black/10 px-2 text-[12.5px] font-medium text-neutral-600 dark:border-white/10 dark:text-neutral-300",
        className,
      )}
    >
      <ServerIcon className="h-3.5 w-3.5 text-[color:var(--accent)]" />
      <span className="text-neutral-400 dark:text-neutral-500">SSH</span>
      <span className="max-w-40 truncate">{host}</span>
      <span aria-label={state} className={cn("h-1.5 w-1.5 rounded-full", DOT[state])} />
      {forge && webUrl && (
        <button
          type="button"
          onClick={() => openExternalUrl(webUrl)}
          title={`Open on ${forge.forge ?? forge.host}`}
          className={cn(
            "-mr-1 ml-1 flex items-center gap-1 rounded-md border-l border-black/10 py-0.5 pl-2 pr-1 hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5",
            focusRing,
          )}
        >
          <ForgeIcon kind={forge.kind} className="h-3.5 w-3.5" />
          <span>{forge.forge ?? forge.host}</span>
          <ArrowUpRightIcon className="h-3 w-3 text-neutral-400" />
        </button>
      )}
    </div>
  );
};
